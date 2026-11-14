import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The interpreter choice, mirrored where the next launch can read it.
 *
 * The environment for every tool call is built before host-core answers, and
 * settings live inside the database host-core owns. This file is the same escape
 * hatch the startup animation already uses: one small JSON in the data directory,
 * written whenever the setting changes, read synchronously at boot.
 */
const FILE = "python-preferences.json";

function preferenceFile(dataDir: string): string {
  return join(dataDir, FILE);
}

/** The configured interpreter, or an empty string when the user has not chosen. */
export function readPythonInterpreterPreference(dataDir: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(preferenceFile(dataDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return "";
    const value = (parsed as { interpreterPath?: unknown }).interpreterPath;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/** Mirror the setting; a failure here must never fail the settings write. */
export function writePythonInterpreterPreference(dataDir: string, path: unknown): void {
  const value = typeof path === "string" ? path.trim() : "";
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(preferenceFile(dataDir), JSON.stringify({ interpreterPath: value }), "utf8");
  } catch {
    // best-effort persistence
  }
}

/** Whether the mirrored value still points at a file that exists. */
export function pythonInterpreterPreferenceIsUsable(dataDir: string): boolean {
  const path = readPythonInterpreterPreference(dataDir);
  return path.length > 0 && existsSync(path);
}
