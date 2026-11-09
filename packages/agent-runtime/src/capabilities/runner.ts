/**
 * Capability package runner (D691).
 *
 * Loads one entry module per enabled, readable package and keeps the
 * implementations its `register` calls produced. Loading is per process, not per
 * session: a package declares what it can do, and a session only decides whether
 * to call it.
 *
 * Failure containment is the whole point of this file. A package that throws at
 * import, registers an action nobody declared, or hangs past the invoke budget
 * must leave the client working — the failure belongs to that package's row in
 * the capability page, never to the sidecar.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CAPABILITY_API_VERSION,
  CAPABILITY_INVOKE_TIMEOUT_MS,
  CAPABILITY_MANIFEST_FILE,
  CAPABILITY_SCHEMA_VERSION,
  normalizeCapabilityPermissions,
  type CapabilityAction,
  type CapabilityPermission,
  type CapabilityRuntimeState,
  type CapabilitySummary,
} from "@pi-workspace/shared";

import type {
  CapabilityActionHandler,
  CapabilityActionInput,
  CapabilityApi,
  LoadedCapability,
} from "./types.js";

/** Most characters one package may keep in its log ring. */
const LOG_LIMIT = 200;
/** Entry module candidates, in resolution order. */
const ENTRY_CANDIDATES = ["index.js", "index.mjs", "index.cjs"];

export type CapabilityRunnerHost = {
  /** Ask host-core for something; the caller has already checked `host`. */
  call(method: string, params: unknown): Promise<unknown>;
  /** Where the packages live, for the "open folder" affordance and errors. */
  packagesDir?: string;
};

export type CapabilityManifestIssue = { id: string; message: string };

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
};

/** Narrow an unknown value to a manifest we are willing to execute. */
export function readCapabilityManifest(dir: string): {
  manifest?: ManifestShape;
  error?: string;
} {
  const file = path.join(dir, CAPABILITY_MANIFEST_FILE);
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
    return { error: `${CAPABILITY_MANIFEST_FILE}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${CAPABILITY_MANIFEST_FILE}: expected an object` };
  }
  const manifest = parsed as ManifestShape;
  if (manifest.schemaVersion !== CAPABILITY_SCHEMA_VERSION) {
    return {
      error: `${CAPABILITY_MANIFEST_FILE}: unsupported schemaVersion ${String(manifest.schemaVersion)}`,
    };
  }
  if (manifest.apiVersion !== CAPABILITY_API_VERSION) {
    return {
      error: `${CAPABILITY_MANIFEST_FILE}: unsupported apiVersion ${String(manifest.apiVersion)}`,
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

function declaredActions(manifest: ManifestShape): CapabilityAction[] {
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
  summary: CapabilitySummary,
  manifest: ManifestShape,
): CapabilitySummary {
  return {
    ...summary,
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : summary.id,
    version: typeof manifest.version === "string" ? manifest.version.trim() : "",
    description: typeof manifest.description === "string" ? manifest.description.trim() : "",
    author: typeof manifest.author === "string" ? manifest.author.trim() : undefined,
    actions: declaredActions(manifest),
  };
}

export class CapabilityRunner {
  private loaded = new Map<string, LoadedCapability>();
  private host: CapabilityRunnerHost;

  constructor(host: CapabilityRunnerHost) {
    this.host = host;
  }

  /** Packages currently held, by id. */
  summaries(): Map<string, CapabilitySummary> {
    return new Map(
      [...this.loaded.entries()].map(([id, entry]) => [id, entry.summary]),
    );
  }

  /** Runtime state of every package, for the page's status panel. */
  states(): CapabilityRuntimeState[] {
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
  async load(summaries: CapabilitySummary[]): Promise<CapabilityRuntimeState[]> {
    const next = new Map<string, LoadedCapability>();
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
    this.loaded.clear();
  }

  private async loadOne(summary: CapabilitySummary): Promise<LoadedCapability | undefined> {
    const dir = summary.path;
    const { manifest, error } = readCapabilityManifest(dir);
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
    const permissions = normalizeCapabilityPermissions(summary.grantedPermissions);
    const actions = new Map<string, CapabilityActionHandler>();
    const logs: string[] = [];
    const api = this.createApi(summary, dir, permissions, actions, logs);
    try {
      const { loadCapabilityEntry } = await import("./loader.js");
      const factory = await loadCapabilityEntry(entry);
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
    summary: CapabilitySummary,
    dir: string,
    permissions: readonly CapabilityPermission[],
    actions: Map<string, CapabilityActionHandler>,
    logs: string[],
  ): CapabilityApi {
    const runner = this;
    const can = (permission: CapabilityPermission) => permissions.includes(permission);
    const log = (message: string) => {
      const line = String(message);
      logs.push(line);
      if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
    };
    const call = async (method: string, params?: unknown) => {
      if (!can("host")) {
        throw new Error(`capability ${summary.id} has no host permission`);
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
          throw new Error("capability action name is required");
        }
        if (typeof handler !== "function") {
          throw new Error(`capability action ${name} needs a function`);
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
    if (!entry) throw new Error(`capability ${id} is not loaded`);
    const handler = entry.actions.get(action);
    if (!handler) throw new Error(`capability ${id} has no action ${action}`);
    const logs: string[] = [];
    const input: CapabilityActionInput = {
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
          throw new Error(`capability ${id} has no host permission`);
        }
        return this.host.call(method, params);
      },
    };
    const startedAt = Date.now();
    const result = await withDeadline(
      Promise.resolve().then(() => handler(input)),
      CAPABILITY_INVOKE_TIMEOUT_MS,
      `capability ${id} action ${action} exceeded ${CAPABILITY_INVOKE_TIMEOUT_MS}ms`,
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
