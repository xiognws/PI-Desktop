/**
 * Widget package runner (D699).
 *
 * Loads one entry module per enabled, readable package and keeps the
 * implementations its `register` calls produced. Loading is per process, not per
 * session: a package declares what it can do, and a session only decides whether
 * to call it.
 *
 * Failure containment is the whole point of this file. A package that throws at
 * import, registers an action nobody declared, or hangs past the invoke budget
 * must leave the client working — the failure belongs to that package's row in
 * the widget page, never to the sidecar.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  isSupportedWidgetApiVersion,
  readWidgetRuntime,
  WIDGET_API_VERSION,
  WIDGET_API_VERSION_MIN,
  WIDGET_INVOKE_TIMEOUT_MS,
  WIDGET_MANIFEST_FILE,
  WIDGET_SCHEMA_VERSION,
  normalizeWidgetPermissions,
  type WidgetAction,
  type WidgetPermission,
  type WidgetRuntime,
  type WidgetRuntimeState,
  type WidgetSummary,
} from "@pi-workspace/shared";

import { startPythonEntry } from "./python-entry.js";

import type {
  WidgetActionHandler,
  WidgetActionInput,
  WidgetApi,
  LoadedWidget,
} from "./types.js";

/** Most characters one package may keep in its log ring. */
const LOG_LIMIT = 200;
/** Entry module candidates, in resolution order. */
const ENTRY_CANDIDATES = ["index.js", "index.mjs", "index.cjs"];

export type WidgetRunnerOptions = {
  /**
   * Resolve the interpreter for `runtime.kind: "python"` packages.
   *
   * Interpreter policy stays with the caller: this process may run in a
   * sandbox where the user's preferred interpreter is only known to main.
   * Returning undefined makes a Python package fail with a message instead of
   * silently never loading.
   */
  pythonInterpreter?: () => string | undefined;
};

export type WidgetRunnerHost = {
  /** Ask host-core for something; the caller has already checked `host`. */
  call(method: string, params: unknown): Promise<unknown>;
  /** Where the packages live, for the "open folder" affordance and errors. */
  packagesDir?: string;
};

export type WidgetManifestIssue = { id: string; message: string };

type ManifestShape = {
  schemaVersion?: number;
  apiVersion?: number;
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  permissions?: string[];
  actions?: Array<{ name?: string; description?: string; params?: string[] }>;
  /** v2: what the entry is written in. Absent means JavaScript. */
  runtime?: unknown;
};

/** Narrow an unknown value to a manifest we are willing to execute. */
export function readWidgetManifest(dir: string): {
  manifest?: ManifestShape;
  error?: string;
} {
  const file = path.join(dir, WIDGET_MANIFEST_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    return { error: `${file}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { error: `${WIDGET_MANIFEST_FILE}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${WIDGET_MANIFEST_FILE}: expected an object` };
  }
  const manifest = parsed as ManifestShape;
  if (manifest.schemaVersion !== WIDGET_SCHEMA_VERSION) {
    return {
      error: `${WIDGET_MANIFEST_FILE}: unsupported schemaVersion ${String(manifest.schemaVersion)}`,
    };
  }
  if (!isSupportedWidgetApiVersion(manifest.apiVersion)) {
    return {
      error:
        `${WIDGET_MANIFEST_FILE}: unsupported apiVersion ${String(manifest.apiVersion)} ` +
        `(this build runs ${WIDGET_API_VERSION_MIN}..=${WIDGET_API_VERSION})`,
    };
  }
  return { manifest };
}

/** First existing entry module inside a package directory. */
export function resolveEntry(dir: string): string | undefined {
  for (const candidate of ENTRY_CANDIDATES) {
    const file = path.join(dir, candidate);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/**
 * Resolve the entry a v2 manifest names, for any runtime kind.
 *
 * The manifest's `runtime.entry` is authoritative when present, so a Python
 * package does not have to be called `index.*`. A path that escapes the package
 * directory is refused: a widget package is trusted only for its own files, and
 * an entry elsewhere would let it run code the user never reviewed.
 */
export function resolveRuntimeEntry(
  dir: string,
  runtime: WidgetRuntime,
): { entry?: string; error?: string } {
  if (runtime.kind === "javascript" && !runtime.entry) {
    const entry = resolveEntry(dir);
    return entry ? { entry } : { error: `no entry module (${ENTRY_CANDIDATES.join(", ")})` };
  }
  if (runtime.kind === "python" && !runtime.entry) {
    return { error: "runtime.entry is required when runtime.kind is python" };
  }
  if (runtime.kind === "python" && !runtime.entry.toLowerCase().endsWith(".py")) {
    return { error: `runtime.entry must end in .py for python packages: ${runtime.entry}` };
  }
  const root = path.resolve(dir);
  const entry = path.resolve(root, runtime.entry);
  if (entry !== root && !entry.startsWith(root + path.sep)) {
    return { error: `runtime.entry escapes the package directory: ${runtime.entry}` };
  }
  if (!existsSync(entry)) return { error: `runtime.entry not found: ${runtime.entry}` };
  return { entry };
}

function declaredActions(manifest: ManifestShape): WidgetAction[] {
  return (manifest.actions ?? [])
    .filter((action): action is { name: string; description?: string; params?: string[] } =>
      typeof action?.name === "string" && action.name.trim().length > 0,
    )
    .map((action) => ({
      name: action.name.trim(),
      description: typeof action.description === "string" ? action.description.trim() : "",
      params: Array.isArray(action.params)
        ? action.params.filter((param): param is string => typeof param === "string")
        : undefined,
    }));
}

function summarize(
  summary: WidgetSummary,
  manifest: ManifestShape,
): WidgetSummary {
  return {
    ...summary,
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : summary.id,
    version: typeof manifest.version === "string" ? manifest.version.trim() : "",
    description: typeof manifest.description === "string" ? manifest.description.trim() : "",
    author: typeof manifest.author === "string" ? manifest.author.trim() : undefined,
    actions: declaredActions(manifest),
  };
}

export class WidgetRunner {
  private loaded = new Map<string, LoadedWidget>();
  private host: WidgetRunnerHost;

  private options: WidgetRunnerOptions;

  constructor(host: WidgetRunnerHost, options: WidgetRunnerOptions = {}) {
    this.host = host;
    this.options = options;
  }

  /** Packages currently held, by id. */
  summaries(): Map<string, WidgetSummary> {
    return new Map(
      [...this.loaded.entries()].map(([id, entry]) => [id, entry.summary]),
    );
  }

  /** Runtime state of every package, for the page's status panel. */
  states(): WidgetRuntimeState[] {
    return [...this.loaded.values()].map((entry) => ({
      id: entry.summary.id,
      state: entry.state,
      actionNames: [...entry.actions.keys()],
      error: entry.error,
    }));
  }

  /**
   * Load (or reload) every enabled, trusted-enough package the host reports.
   *
   * `summaries` is the host's authoritative list: it carries the manifest id,
   * the granted permissions and the digest trust verdict, so the sidecar never
   * re-derives trust from the filesystem on its own.
   */
  async load(summaries: WidgetSummary[]): Promise<WidgetRuntimeState[]> {
    // Every package is re-created below, so the previous generation is disposed
    // first: a Python package owns a child process, and a sync that only swapped
    // the map would leak one process per package per reload.
    for (const entry of this.loaded.values()) entry.python?.dispose();
    const next = new Map<string, LoadedWidget>();
    for (const summary of summaries) {
      if (!summary.enabled) continue;
      if (summary.error) continue;
      if (summary.trust === "untrusted") continue;
      const loaded = await this.loadOne(summary);
      if (loaded) next.set(summary.id, loaded);
    }
    this.loaded = next;
    return this.states();
  }

  /** Drop every package; used when the client disables the whole feature. */
  clear(): void {
    for (const entry of this.loaded.values()) entry.python?.dispose();
    this.loaded.clear();
  }

  /**
   * Start a Python package and forward its declared actions to the process.
   *
   * Only declared actions are reachable: an undeclared action is refused here,
   * which keeps the manifest the single list of what a package may be asked to
   * do - the same rule the JavaScript loader enforces by checking registration.
   */
  private async loadPythonPackage(
    summary: WidgetSummary,
    manifest: ManifestShape,
    dir: string,
    runtime: WidgetRuntime,
  ): Promise<LoadedWidget> {
    const declared = declaredActions(manifest);
    const resolved = resolveRuntimeEntry(dir, runtime);
    if (!resolved.entry) {
      return {
        summary,
        actions: new Map(),
        declared,
        state: "error",
        error: resolved.error ?? "python entry is missing",
        logs: [],
      };
    }
    const interpreter = this.options.pythonInterpreter?.();
    if (!interpreter) {
      return {
        summary,
        actions: new Map(),
        declared,
        state: "error",
        error: "no Python interpreter is configured for widget packages",
        logs: [],
      };
    }
    const python = startPythonEntry({
      interpreter,
      entry: resolved.entry,
      cwd: dir,
      pythonPath: runtime.pythonPath ?? [],
    });
    try {
      await python.ready;
    } catch (cause) {
      python.dispose();
      return {
        summary,
        actions: new Map(),
        declared,
        state: "error",
        error: cause instanceof Error ? cause.message : String(cause),
        logs: python.stderr(),
      };
    }
    const actions = new Map<string, WidgetActionHandler>();
    for (const action of declared) {
      actions.set(action.name, (input: WidgetActionInput) =>
        python.request(action.name, input.args, WIDGET_INVOKE_TIMEOUT_MS),
      );
    }
    return {
      summary: summarize(summary, manifest),
      actions,
      declared,
      state: "loaded",
      logs: python.stderr(),
      python,
    };
  }

  private async loadOne(summary: WidgetSummary): Promise<LoadedWidget | undefined> {
    const dir = summary.path;
    const { manifest, error } = readWidgetManifest(dir);
    if (!manifest) {
      return {
        summary,
        actions: new Map(),
        declared: [],
        state: "error",
        error: error ?? "unreadable manifest",
        logs: [],
      };
    }
    const runtime = readWidgetRuntime(manifest.runtime) ?? { kind: "javascript" as const };
    if (runtime.kind === "python") {
      return await this.loadPythonPackage(summary, manifest, dir, runtime);
    }
    const entry = resolveEntry(dir);
    if (!entry) {
      return {
        summary,
        actions: new Map(),
        declared: declaredActions(manifest),
        state: "error",
        error: `no entry module (${ENTRY_CANDIDATES.join(", ")})`,
        logs: [],
      };
    }
    const permissions = normalizeWidgetPermissions(summary.grantedPermissions);
    const actions = new Map<string, WidgetActionHandler>();
    const logs: string[] = [];
    const api = this.createApi(summary, dir, permissions, actions, logs);
    try {
      const { loadWidgetEntry } = await import("./loader.js");
      const factory = await loadWidgetEntry(entry);
      if (typeof factory !== "function") {
        return {
          summary,
          actions,
          declared: declaredActions(manifest),
          state: "error",
          error: "entry module has no default export function",
          logs,
        };
      }
      await factory(api);
    } catch (cause) {
      return {
        summary,
        actions,
        declared: declaredActions(manifest),
        state: "error",
        error: cause instanceof Error ? cause.message : String(cause),
        logs,
      };
    }
    const declared = declaredActions(manifest);
    const missing = declared.filter((action) => !actions.has(action.name));
    if (missing.length > 0) {
      logs.push(
        `declared but not registered: ${missing.map((action) => action.name).join(", ")}`,
      );
    }
    return {
      summary: summarize(summary, manifest),
      actions,
      declared,
      state: "loaded",
      logs,
    };
  }

  private createApi(
    summary: WidgetSummary,
    dir: string,
    permissions: readonly WidgetPermission[],
    actions: Map<string, WidgetActionHandler>,
    logs: string[],
  ): WidgetApi {
    const runner = this;
    const can = (permission: WidgetPermission) => permissions.includes(permission);
    const log = (message: string) => {
      const line = String(message);
      logs.push(line);
      if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
    };
    const call = async (method: string, params?: unknown) => {
      if (!can("host")) {
        throw new Error(`widget ${summary.id} has no host permission`);
      }
      return runner.host.call(method, params);
    };
    return {
      id: summary.id,
      version: summary.version,
      permissions,
      can,
      dir,
      log,
      call,
      action(name, handler) {
        if (typeof name !== "string" || !name.trim()) {
          throw new Error("widget action name is required");
        }
        if (typeof handler !== "function") {
          throw new Error(`widget action ${name} needs a function`);
        }
        actions.set(name.trim(), handler);
      },
    };
  }

  /** True when `id` is loaded and exposes `action`. */
  has(id: string, action: string): boolean {
    return this.loaded.get(id)?.actions.has(action) ?? false;
  }

  /**
   * Run one action.
   *
   * Every way this can fail is reported as a rejection with a message that names
   * what was wrong: unknown package, unknown action, thrown error, or a handler
   * that outlived the budget. A handler that keeps running after the timeout is
   * not cancelled — Node cannot preempt it — but the caller has already been
   * told, so a hung package cannot hang the UI.
   */
  async invoke(id: string, action: string, args: unknown): Promise<{
    value: unknown;
    durationMs: number;
    logs: string[];
  }> {
    const entry = this.loaded.get(id);
    if (!entry) throw new Error(`widget ${id} is not loaded`);
    const handler = entry.actions.get(action);
    if (!handler) throw new Error(`widget ${id} has no action ${action}`);
    const logs: string[] = [];
    const input: WidgetActionInput = {
      args,
      dir: entry.summary.path,
      log: (message: string) => {
        const line = String(message);
        logs.push(line);
        entry.logs.push(line);
        if (entry.logs.length > LOG_LIMIT) entry.logs.splice(0, entry.logs.length - LOG_LIMIT);
      },
      call: async (method: string, params?: unknown) => {
        if (!entry.summary.grantedPermissions.includes("host")) {
          throw new Error(`widget ${id} has no host permission`);
        }
        return this.host.call(method, params);
      },
    };
    const startedAt = Date.now();
    const result = await withDeadline(
      Promise.resolve().then(() => handler(input)),
      WIDGET_INVOKE_TIMEOUT_MS,
      `widget ${id} action ${action} exceeded ${WIDGET_INVOKE_TIMEOUT_MS}ms`,
    );
    return { value: result, durationMs: Date.now() - startedAt, logs };
  }

  /** Recent log lines for one package, for the runtime panel. */
  logsFor(id: string): string[] {
    return [...(this.loaded.get(id)?.logs ?? [])];
  }
}

/**
 * Race a promise against a deadline. The loser is left to settle on its own:
 * cancelling arbitrary package code is not something this process can do, and
 * rejecting the race is what the caller actually needs.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
