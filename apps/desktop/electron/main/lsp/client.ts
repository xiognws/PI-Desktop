/**
 * One language server per language, with requests correlated by id (ADR 0401).
 *
 * A server answers out of order and interleaves notifications while it works, so
 * matching a response to a request can only be done by id. The dispatcher below is
 * the whole of that rule, and it is separated from the process so the cases that are
 * easy to get wrong are testable without spawning `rust-analyzer`:
 *
 *  - a response for an id nobody waits for is *normal* (that request timed out) and
 *    must be dropped rather than handed to the next caller;
 *  - a server-initiated request has an id *and* a method, and must be answered or the
 *    server waits on us forever;
 *  - a payload that is not JSON-RPC at all is surfaced, because a server printing a
 *    banner on stdout otherwise looks like a hang.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { decodeFrame, encodeFrame } from "./framing.ts";

export type Delivered =
  | { kind: "response"; id: number }
  | { kind: "orphan"; id: number }
  | { kind: "notification"; method: string }
  | { kind: "serverRequest"; id: number; method: string }
  | { kind: "unparsed" };

type Waiter = {
  resolve: (payload: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Correlates responses with the requests waiting for them.
 *
 * Kept transport-free: it takes a decoded payload and a `reply` callback (used to
 * answer server-initiated requests) and nothing else.
 */
export class Dispatcher {
  private nextId = 1;
  private readonly waiters = new Map<number, Waiter>();
  private readonly notifications = new Map<string, string[]>();

  private readonly reply: (payload: string) => void;

  constructor(reply: (payload: string) => void) {
    this.reply = reply;
  }

  /** Allocate an id and a promise for the response, bounded by `timeoutMs`. */
  begin(method: string, timeoutMs: number): { id: number; response: Promise<string> } {
    const id = this.nextId++;
    const response = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The id is abandoned, not reused: a late answer arrives as an orphan and is
        // dropped by `deliver`, which is exactly what keeps it away from the next
        // request that happens to get the same number.
        this.waiters.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      // Deliberately not unref’d: a timeout that must fire has to keep the loop alive,
      // or the request waits forever instead of reporting that it timed out.
      this.waiters.set(id, { resolve, reject, timer });
    });
    return { id, response };
  }

  abandon(id: number): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(id);
  }

  /** Route one decoded payload. */
  deliver(payload: string): Delivered {
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return { kind: "unparsed" };
    }
    if (!value || typeof value !== "object") return { kind: "unparsed" };
    const record = value as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
    const id = typeof record.id === "number" ? record.id : undefined;
    const method = typeof record.method === "string" ? record.method : undefined;

    if (id !== undefined && method === undefined) {
      const waiter = this.waiters.get(id);
      if (!waiter) return { kind: "orphan", id };
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve(payload);
      return { kind: "response", id };
    }
    if (id !== undefined && method !== undefined) {
      // A request from the server. Every capability this client declares is
      // null-answerable, so `null` is correct for all of them; answering nothing
      // would stall the server.
      this.reply(JSON.stringify({ jsonrpc: "2.0", id, result: null }));
      return { kind: "serverRequest", id, method };
    }
    if (method !== undefined) {
      const list = this.notifications.get(method) ?? [];
      list.push(payload);
      // Diagnostics are snapshots, not a stream: keeping more than the last one
      // would report problems the server has already cleared.
      if (list.length > 8) list.splice(0, list.length - 8);
      this.notifications.set(method, list);
      return { kind: "notification", method };
    }
    return { kind: "unparsed" };
  }

  lastNotification(method: string): string | undefined {
    return this.notifications.get(method)?.at(-1);
  }

  get pending(): number {
    return this.waiters.size;
  }

  /** Reject everything still waiting; used when the process dies. */
  failAll(message: string): void {
    for (const [id, waiter] of [...this.waiters]) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.reject(new Error(message));
    }
  }
}

export type SessionTimeouts = {
  initializeMs: number;
  requestMs: number;
  shutdownMs: number;
};

/**
 * Defaults with three different values on purpose: they fail for different reasons.
 * `initialize` is slow when a server is indexing (rust-analyzer on a large workspace
 * takes a while), a request is slow when the server is stuck, and shutdown is slow
 * when the process is ignoring us.
 */
export const DEFAULT_TIMEOUTS: SessionTimeouts = {
  initializeMs: 120_000,
  requestMs: 30_000,
  shutdownMs: 5_000,
};

export type ServerCommand = {
  command: string;
  args: string[];
  /** Shown when something fails, so the error names the server that misbehaved. */
  label: string;
};

/**
 * Spawn the server, working around Windows shims.
 *
 * `typescript-language-server` and `pyright` install as `.cmd` shims on Windows, and
 * Node refuses to spawn those directly (`EINVAL`) since the BatBadBut fix. They have
 * to go through the command processor, with quoting we do ourselves: `shell: true`
 * would split a path containing a space, which is exactly where these live
 * (`C:\Program Files\...`).
 */
function spawnServerProcess(spec: ServerCommand): ChildProcessWithoutNullStreams {
  const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(spec.command)) {
    // `cmd /s` strips the first and last quote of the whole command line, so the
    // line needs one extra pair around it: without it the server receives a mangled
    // first argument and exits with code 1 before the handshake.
    const argumentsLine = spec.args.map((argument) => `"${argument}"`).join(" ");
    const line = `""${spec.command}" ${argumentsLine}"`;
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
      stdio,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(spec.command, spec.args, { stdio, windowsHide: true });
}

/** A running language server. */
export class LspClient {
  private buffer = Buffer.alloc(0);
  private closed: string | undefined;
  // Plain fields rather than constructor parameter properties: the electron tests
  // import this file with Node type stripping, which erases types but cannot
  // synthesise the assignments those properties imply.
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dispatcher: Dispatcher;
  private readonly timeouts: SessionTimeouts;
  readonly label: string;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    dispatcher: Dispatcher,
    timeouts: SessionTimeouts,
    label: string,
  ) {
    this.child = child;
    this.dispatcher = dispatcher;
    this.timeouts = timeouts;
    this.label = label;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.on("exit", (code, signal) => {
      this.closed = `the server exited (code=${code ?? "null"} signal=${signal ?? "null"})`;
      this.dispatcher.failAll(this.closed);
    });
    child.on("error", (error) => {
      this.closed = `the server failed: ${error.message}`;
      this.dispatcher.failAll(this.closed);
    });
  }

  /**
   * Start a server and complete the handshake.
   *
   * `root` goes out as the workspace folder, so the server indexes the project the
   * session is working in rather than whatever directory the app was launched from.
   */
  static async start(
    spec: ServerCommand,
    root: string,
    timeouts: SessionTimeouts = DEFAULT_TIMEOUTS,
  ): Promise<LspClient> {
    const child = spawnServerProcess(spec);
    const dispatcher: Dispatcher = new Dispatcher((payload) => {
      if (!child.stdin.destroyed) child.stdin.write(encodeFrame(payload));
    });
    const client = new LspClient(child, dispatcher, timeouts, spec.label);
    // stderr is drained, not parsed: a server that fills its stderr pipe would block,
    // and the last line is the only part a human needs.
    child.stderr.on("data", (chunk: Buffer) => {
      client.stderrTail = `${client.stderrTail}${chunk.toString("utf8")}`.slice(-2_000);
    });
    await client.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "pi-workspace" },
        rootUri: pathToUri(root),
        workspaceFolders: [{ uri: pathToUri(root), name: "workspace" }],
        capabilities: {
          // Read-only client: it declares only what the three tools need, so a
          // capability mismatch shows up as a missing answer rather than as an edit
          // the agent never asked for.
          textDocument: { definition: {}, references: {}, publishDiagnostics: {} },
          workspace: { workspaceFolders: true },
        },
      },
      timeouts.initializeMs,
    );
    // `initialized` is a notification: the server does not index until it arrives.
    client.notify("initialized", {});
    return client;
  }

  /** Last 2 KB of the server's stderr, for error messages. */
  stderrTail = "";

  async request(method: string, params: unknown, timeoutMs = this.timeouts.requestMs): Promise<unknown> {
    if (this.closed) throw new Error(`${method}: ${this.closed}${this.stderrSuffix()}`);
    const { id, response } = this.dispatcher.begin(method, timeoutMs);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (this.child.stdin.destroyed) {
      this.dispatcher.abandon(id);
      throw new Error(`${method}: the server closed its stdin`);
    }
    this.child.stdin.write(encodeFrame(payload));
    const raw = await response;
    const value = JSON.parse(raw) as { error?: { message?: string }; result?: unknown };
    if (value.error) {
      throw new Error(`${method} failed: ${value.error.message ?? JSON.stringify(value.error)}`);
    }
    return value.result ?? null;
  }

  notify(method: string, params: unknown): void {
    if (this.closed || this.child.stdin.destroyed) return;
    this.child.stdin.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", method, params })));
  }

  lastDiagnostics(): unknown {
    const raw = this.dispatcher.lastNotification("textDocument/publishDiagnostics");
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  get isClosed(): boolean {
    return this.closed !== undefined;
  }

  /**
   * Shut down deterministically: `shutdown` then `exit`, wait, and kill only if it
   * does not go. Leaving the child alive would leave a process nobody can find again.
   */
  async shutdown(): Promise<void> {
    if (!this.closed) {
      await this.request("shutdown", null, this.timeouts.shutdownMs).catch(() => undefined);
      this.notify("exit", null);
    }
    const exited = await waitForExit(this.child, this.timeouts.shutdownMs);
    if (!exited) {
      this.child.kill("SIGKILL");
      await waitForExit(this.child, this.timeouts.shutdownMs);
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim();
    if (!tail) return "";
    return `\nserver stderr (tail): ${tail.split("\n").slice(-5).join("\n")}`;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const decoded = decodeFrame(this.buffer);
      if (decoded.kind === "incomplete") return;
      if (decoded.kind === "error") {
        // A frame that cannot be parsed never becomes valid by waiting: drop what we
        // have and keep the session alive, so one bad write does not kill a server
        // that is otherwise fine.
        this.buffer = Buffer.alloc(0);
        return;
      }
      this.buffer = this.buffer.subarray(decoded.consumed);
      this.dispatcher.deliver(decoded.payload);
    }
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    function onExit(): void {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

/**
 * Turn a filesystem path into a `file://` URI.
 *
 * Windows needs the drive letter as the path segment with forward slashes; a path
 * sent as-is is rejected by most servers, and the rejection surfaces as "no
 * definition found" rather than "bad URI", which sends the reader looking in the
 * wrong place.
 */
export function pathToUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const encoded = normalized.replace(/ /g, "%20").replace(/#/g, "%23").replace(/\?/g, "%3F");
  if (/^[A-Za-z]:\//.test(encoded)) return `file:///${encoded}`;
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}
