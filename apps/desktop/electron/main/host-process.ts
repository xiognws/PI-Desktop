import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HostProcess as RuntimeHostProcess,
  type DiagnosedHostFailure,
  type StderrHandler,
} from "@pi-workspace/host-runtime";
import { ErrorCodes } from "@pi-workspace/shared";
import {
  GlibcUnsupportedError,
  glibcMissingSymbol,
} from "./linux-glibc";
import { DbSchemaTooNewError, parseSchemaTooNew } from "./host-boot-diagnostics";
import { redactValue } from "./logger";
import { getModuleDirectory } from "./module-path";
import { localTimestamp } from "./log-timestamp.ts";
import { pythonEnv, resolvePythonRuntime, USER_SITE_DIR } from "./python-runtime.ts";
import {
  PATH_DELIMITER,
  resolveExtraPluginDirs,
  resolvePreinstalledPluginsDirs,
} from "./plugin-paths.ts";

export type {
  HostNotificationHandler,
  ProcessExitHandler,
  StderrHandler,
} from "@pi-workspace/host-runtime";

export function resolveHostBinary(): string {
  if (process.env.PI_DESKTOP_HOST_BIN && existsSync(process.env.PI_DESKTOP_HOST_BIN)) {
    return process.env.PI_DESKTOP_HOST_BIN;
  }
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    // packaged resources
    join(process.resourcesPath || "", `bin/pi-desktop-host-core${exe}`),
    // monorepo dev/build
    join(
      getModuleDirectory(import.meta.url),
      `../../../../target/debug/pi-desktop-host-core${exe}`,
    ),
    join(
      getModuleDirectory(import.meta.url),
      `../../../../target/release/pi-desktop-host-core${exe}`,
    ),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error(
    "host-core binary not found. Run `cargo build -p host-core` first.",
  );
}

/**
 * Directories this build ships plugins in, in scan order (possibly empty).
 *
 * Resolved in `plugin-paths.ts`, which also owns the directories the user
 * pointed the host at; the host treats what it finds in these as
 * *preinstalled* — shipped, but the user's to remove, update, or replace.
 */

/**
 * Name the two boot refusals the desktop phrases for the user (D380): a data
 * directory newer than this build, and a glibc below the packaged floor. The
 * schema refusal is checked first because its stderr line is the more specific
 * one; anything else stays the generic `HOST_UNAVAILABLE` transport error.
 */
export function diagnoseHostFailure({
  lastStderr,
  message,
}: {
  lastStderr: string;
  message: string;
}): DiagnosedHostFailure | null {
  const schema = parseSchemaTooNew(lastStderr) ?? parseSchemaTooNew(message);
  if (schema) {
    return Object.assign(new DbSchemaTooNewError(schema), {
      errorCode: ErrorCodes.HOST_UNAVAILABLE,
    });
  }
  if (glibcMissingSymbol(lastStderr) || glibcMissingSymbol(message)) {
    return Object.assign(new GlibcUnsupportedError(), {
      errorCode: ErrorCodes.HOST_UNAVAILABLE,
    });
  }
  return null;
}

function fallbackStderrLogger(text: string): void {
  console.error(
    `[host/runtime] ${JSON.stringify({
      ts: localTimestamp(),
      level: "info",
      channel: "host",
      category: "runtime",
      event: "child.process.stderr",
      message: "child process stderr",
      data: { output: redactValue(text.trimEnd()) },
    })}`,
  );
}

/**
 * Directory holding the tool packages this build ships, or null when it ships
 * none. Mirrors `resolveBuiltinPluginsDir` (electron-builder copies
 * `resources/tools` to `<resources>/tools`).
 */
function resolveBuiltinToolsDir(): string | null {
  const candidates = [
    join(process.resourcesPath || "", "tools"),
    join(getModuleDirectory(import.meta.url), "../../resources/tools"),
    join(getModuleDirectory(import.meta.url), "../../../resources/tools"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The desktop's host-core child: the shared stdio transport from
 * `@pi-workspace/host-runtime` plus the two things only Electron knows — where
 * this build keeps the binary and its bundled plugins, and how to name the
 * boot refusals the renderer phrases.
 */
export class HostProcess extends RuntimeHostProcess {
  constructor(dataDir: string, onStderr?: StderrHandler) {
    const preinstalledPlugins = resolvePreinstalledPluginsDirs();
    const extraPlugins = resolveExtraPluginDirs(dataDir);
    const builtinTools = resolveBuiltinToolsDir();
    // Every Bash/Core tool command inherits host-core's environment, so the
    // Python path is set here rather than per call: the runtime is a property of
    // the installation, not of the session that happens to run a script.
    const python = resolvePythonRuntime();
    const pythonPath = python.state === "present" ? pythonEnv(python.runtime, [
      join(dataDir, USER_SITE_DIR),
    ]) : null;
    super({
      binaryPath: resolveHostBinary(),
      dataDir,
      // Only Electron knows whether this build runs from `resources/` or a
      // source checkout, so it resolves the plugin directories and host-core
      // simply reconciles its registry against them (ADR 0105, ADR 0396).
      env: {
        PI_DESKTOP_ELECTRON_PID: String(process.pid),
        ...(preinstalledPlugins.length
          ? { PI_DESKTOP_PREINSTALLED_DIRS: preinstalledPlugins.join(PATH_DELIMITER) }
          : {}),
        // The user's own directories: read in place, never copied, never
        // deleted. Empty means the settings page has not been used.
        ...(extraPlugins.length
          ? { PI_DESKTOP_EXTRA_PLUGIN_DIRS: extraPlugins.join(PATH_DELIMITER) }
          : {}),
        // Same split for the bundled tool packages (D681): the host scans the
        // directory, Electron only says where it is.
        ...(builtinTools ? { PI_DESKTOP_BUILTIN_TOOLS_DIR: builtinTools } : {}),
        // A build without a pinned runtime (a checkout that never ran
        // `bundle:python`) simply exports nothing, and the tools that need it
        // report the absence instead of a half-set PYTHONPATH.
        ...(pythonPath
          ? {
              PYTHONHOME: pythonPath.PYTHONHOME,
              PYTHONPATH: pythonPath.PYTHONPATH,
              PYTHONNOUSERSITE: pythonPath.PYTHONNOUSERSITE,
              PI_DESKTOP_PYTHON: python.state === "present" ? python.runtime.executable : "",
            }
          : {}),
      },
      onStderr: onStderr ?? fallbackStderrLogger,
      diagnoseFailure: diagnoseHostFailure,
    });
  }
}
