/**
 * A widget package whose entry is a Python program.
 *
 * The runtime contract for `runtime.kind: "python"` packages: the program is
 * started in its own child process and speaks one JSON object per line over
 * stdio. A request is `{"id":n,"action":"name","args":{...}}`; the answer is
 * `{"id":n,"ok":true,"value":...}` or `{"id":n,"ok":false,"error":"..."}`.
 *
 * It runs out-of-process for the same reason the JavaScript loader runs
 * in-process: a package is third-party code, and the only way to bound it is a
 * separate process whose lifetime this side owns. Nothing here reaches the host
 * API yet — a Python package may only answer the actions it declared, which is
 * the v1 contract and the safe half of the ADR.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const STDERR_LIMIT = 50;
const STARTUP_TIMEOUT_MS = 10_000;

export type PythonSpawn = (
  interpreter: string,
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams;

export type PythonEntryOptions = {
  /** Absolute interpreter path, resolved by the caller that owns interpreter policy. */
  interpreter: string;
  /** Absolute path to the package's `.py` entry. */
  entry: string;
  /** Working directory: the package directory, so relative paths stay inside it. */
  cwd: string;
  /** Extra `PYTHONPATH` entries (the package's own library directories). */
  pythonPath?: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
  /** Injectable for tests: the protocol is interpreter-agnostic. */
  spawn?: PythonSpawn;
};

export type PythonEntry = {
  /** Resolves once the process is running; rejects if it cannot start. */
  ready: Promise<void>;
  request(action: string, args: unknown, timeoutMs: number): Promise<unknown>;
  stderr(): string[];
  dispose(): void;
};

function defaultSpawn(
  interpreter: string,
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return nodeSpawn(interpreter, [entry], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export function startPythonEntry(options: PythonEntryOptions): PythonEntry {
  const spawn = options.spawn ?? defaultSpawn;
  const pythonPath = [
    options.cwd,
    ...(options.pythonPath ?? []),
    ...(options.baseEnv?.PYTHONPATH ? [options.baseEnv.PYTHONPATH] : []),
  ].join(process.platform === "win32" ? ";" : ":");

  const child = spawn(options.interpreter, options.entry, options.cwd, {
    ...(options.baseEnv ?? process.env),
    PYTHONPATH: pythonPath,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  });

  const stderrLines: string[] = [];
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void }
  >();
  let nextId = 1;
  let disposed = false;
  let exitReason: string | undefined;

  const failAll = (reason: string): void => {
    exitReason ??= reason;
    for (const [, entry] of pending) entry.reject(new Error(reason));
    pending.clear();
  };

  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on("line", (line: string) => {
    const text = line.trim();
    if (!text) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      // Anything the program prints that is not a response is a log line.
      stderrLines.push(text);
      if (stderrLines.length > STDERR_LIMIT) stderrLines.shift();
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as { id?: unknown; ok?: unknown; value?: unknown; error?: unknown };
    if (typeof record.id !== "number") return;
    const slot = pending.get(record.id);
    if (!slot) return;
    pending.delete(record.id);
    if (record.ok === true) slot.resolve(record.value);
    else slot.reject(new Error(typeof record.error === "string" ? record.error : "python action failed"));
  });

  const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
  stderr.on("line", (line: string) => {
    const text = line.trimEnd();
    if (!text) return;
    stderrLines.push(text);
    if (stderrLines.length > STDERR_LIMIT) stderrLines.shift();
  });

  child.on("error", (cause: Error) => failAll(`python entry failed to start: ${cause.message}`));
  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    if (disposed) return;
    failAll(`python entry exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
  });

  const ready = new Promise<void>((resolve, reject) => {
    if (exitReason) {
      reject(new Error(exitReason));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`python entry did not start within ${STARTUP_TIMEOUT_MS}ms`));
    }, STARTUP_TIMEOUT_MS);
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (cause: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`python entry failed to start: ${cause.message}`));
    });
  });
  // The caller may never await `ready`; an unhandled rejection here would crash
  // the process instead of surfacing on the first request.
  ready.catch(() => undefined);

  return {
    ready,
    request(action: string, args: unknown, timeoutMs: number): Promise<unknown> {
      if (disposed) return Promise.reject(new Error("python entry is disposed"));
      if (exitReason) return Promise.reject(new Error(exitReason));
      const id = nextId++;
      const body = `${JSON.stringify({ id, action, args })}\n`;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`widget action ${action} exceeded ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (cause) => {
            clearTimeout(timer);
            reject(cause);
          },
        });
        child.stdin.write(body, (cause) => {
          if (!cause) return;
          pending.delete(id);
          clearTimeout(timer);
          reject(cause);
        });
      });
    },
    stderr(): string[] {
      return [...stderrLines];
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      failAll("python entry was disposed");
      stdout.close();
      stderr.close();
      child.kill();
    },
  };
}
