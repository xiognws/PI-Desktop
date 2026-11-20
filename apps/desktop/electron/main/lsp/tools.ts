/**
 * The three read-only LSP tools (ADR 0401, stage 3).
 *
 * Each one answers a question grep cannot: where a symbol is *defined*, who
 * references it, and what the compiler already knows is wrong with a file. None of
 * them can modify anything — there is no rename and no code action, because a tool
 * that rewrites a workspace belongs behind the same diff-and-approval path as
 * `AstEdit`, not here.
 *
 * One server per language per session, created on first use and reused: a server
 * indexes the whole workspace when it starts, so starting one per query would make
 * every call feel broken.
 *
 * Handlers have the sidecar's `LocalToolHandler` shape; the name, description and
 * schema the model sees live in the agent runtime's tool declarations.
 */
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { LocalToolHandler } from "@pi-workspace/host-runtime";

import { DEFAULT_TIMEOUTS, LspClient, pathToUri } from "./client.ts";
import { LspServerPool } from "./pool.ts";
import { discoverServer } from "./servers.ts";

export type LspToolOptions = {
  /** Directories a tool may read; the same roots `Read` and `Grep` use. */
  getRoots: (sessionId: string) => Promise<readonly string[]>;
  /** Resolved from the session record: a worktree session answers with its worktree. */
  getProjectRoot: (sessionId: string) => string | Promise<string | null>;
};

type Location = {
  uri?: string;
  targetUri?: string;
  range?: { start?: { line?: number; character?: number } };
};

type Position = { file: string; line: number; column: number };

/**
 * Sessions and their servers, in a pool that reclaims idle ones (see `pool.ts`).
 *
 * ADR 0401 still holds — one server per language per session, reused across
 * turns — but a server no longer outlives its usefulness until the session ends.
 */
const pool = new LspServerPool<LspClient>();

async function rootFor(options: LspToolOptions, sessionId: string): Promise<string> {
  return (await options.getProjectRoot(sessionId)) ?? process.cwd();
}

async function clientFor(
  sessionId: string,
  filePath: string,
  projectRoot: string,
): Promise<{ client: LspClient; languageId: string; key: string } | { error: string }> {
  const discovery = discoverServer(filePath, projectRoot);
  if (!discovery.ok) {
    // The directories are part of the message: "not installed" alone leaves the reader
    // unable to tell a missing binary from a broken PATH.
    return { error: `${discovery.reason}. Looked in: ${discovery.lookedFor.join(", ")}` };
  }
  const key = `${sessionId}::${projectRoot}::${discovery.spec.label}`;
  const client = await pool.acquire(key, () =>
    LspClient.start(
      { command: discovery.executable, args: discovery.spec.args, label: discovery.spec.label },
      projectRoot,
      DEFAULT_TIMEOUTS,
    ),
  );
  return { client, languageId: discovery.spec.languageId, key };
}

/** Shut every server down; called when the session ends. */
export async function shutdownLspSessions(sessionId: string): Promise<void> {
  await pool.shutdownSession(sessionId);
}

/** Stop every language server; called on quit, before the process tree goes. */
export function disposeLspServers(): Promise<void> {
  return pool.dispose();
}

function formatLocation(root: string, location: Location): string {
  const uri = location.uri ?? location.targetUri ?? "";
  const raw = uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
  // `file:///D:/x` carries a leading slash before the drive letter.
  const path = raw.replace(/^\/([A-Za-z]:)/, "$1");
  const line = (location.range?.start?.line ?? 0) + 1;
  const character = (location.range?.start?.character ?? 0) + 1;
  // Relative to the workspace root: an absolute path on every line is noise.
  const shown = path.startsWith(root) ? relative(root, path).replace(/\\/g, "/") : path;
  return `${shown}:${line}:${character}`;
}

function positionOf(root: string, input: Position) {
  return {
    textDocument: { uri: pathToUri(resolve(root, input.file)) },
    position: { line: Math.max(0, input.line - 1), character: Math.max(0, input.column - 1) },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `definition` — where a symbol is declared. */
export function createLspDefinitionTool(options: LspToolOptions): LocalToolHandler {
  return async ({ sessionId, args }) => {
    const input = args as Position;
    const root = await rootFor(options, sessionId);
    const ready = await clientFor(sessionId, input.file, root);
    if ("error" in ready) return { ok: false, content: ready.error, isError: true };
    pool.begin(ready.key);
    try {
      const result = await ready.client.request("textDocument/definition", positionOf(root, input));
      const locations = (Array.isArray(result) ? result : result ? [result] : []) as Location[];
      if (!locations.length) {
        return { ok: true, content: `no definition found for ${input.file}:${input.line}:${input.column}` };
      }
      return { ok: true, content: locations.map((location) => formatLocation(root, location)).join("\n") };
    } catch (error) {
      return { ok: false, content: message(error), isError: true };
    } finally {
      pool.end(ready.key);
    }
  };
}

/** `references` — the blast radius of a rename. */
export function createLspReferencesTool(options: LspToolOptions): LocalToolHandler {
  return async ({ sessionId, args }) => {
    const input = args as Position & { includeDeclaration?: boolean };
    const root = await rootFor(options, sessionId);
    const ready = await clientFor(sessionId, input.file, root);
    if ("error" in ready) return { ok: false, content: ready.error, isError: true };
    pool.begin(ready.key);
    try {
      const result = await ready.client.request("textDocument/references", {
        ...positionOf(root, input),
        context: { includeDeclaration: input.includeDeclaration === true },
      });
      const locations = (Array.isArray(result) ? result : []) as Location[];
      if (!locations.length) {
        return { ok: true, content: `no references found at ${input.file}:${input.line}:${input.column}` };
      }
      const lines = locations.map((location) => formatLocation(root, location));
      return { ok: true, content: `${lines.length} reference(s):\n${lines.join("\n")}` };
    } catch (error) {
      return { ok: false, content: message(error), isError: true };
    } finally {
      pool.end(ready.key);
    }
  };
}

/** `diagnostics` — what the compiler already knows is wrong. */
export function createLspDiagnosticsTool(options: LspToolOptions): LocalToolHandler {
  return async ({ sessionId, args }) => {
    const input = args as { file: string };
    const root = await rootFor(options, sessionId);
    const ready = await clientFor(sessionId, input.file, root);
    if ("error" in ready) return { ok: false, content: ready.error, isError: true };
    const absolute = resolve(root, input.file);
    const uri = pathToUri(absolute);
    let text: string;
    try {
      text = await readFile(absolute, "utf8");
    } catch (error) {
      return { ok: false, content: `could not read ${input.file}: ${message(error)}`, isError: true };
    }
    pool.begin(ready.key);
    try {
      // Opening the document is what makes a server publish diagnostics for it.
      ready.client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: ready.languageId, version: 1, text },
      });
      // Diagnostics are pushed on the server's schedule. Wait a bounded moment and say
      // so if nothing arrives: reporting "clean" for a file the server has not looked
      // at is the one answer worse than no answer.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const payload = ready.client.lastDiagnostics() as
          | { params?: { uri?: string; diagnostics?: { message?: string; range?: { start?: { line?: number } } }[] } }
          | undefined;
        if (payload?.params?.uri === uri) {
          const found = payload.params.diagnostics ?? [];
          if (!found.length) return { ok: true, content: `no diagnostics for ${input.file}` };
          const lines = found.map(
            (item) => `${input.file}:${(item.range?.start?.line ?? 0) + 1}: ${item.message ?? "(no message)"}`,
          );
          return { ok: true, content: `${found.length} diagnostic(s):\n${lines.join("\n")}` };
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      return {
        ok: true,
        content: `the language server has not reported diagnostics for ${input.file} yet; it may still be indexing`,
      };
    } catch (error) {
      return { ok: false, content: message(error), isError: true };
    } finally {
      pool.end(ready.key);
    }
  };
}
