/**
 * Stop the same tool call being replayed for the same answer.
 *
 * A chat-completions model is stateless: when a result tells it nothing new it
 * may simply ask again, and because every replay is executed and answered
 * identically, nothing in the transcript says "you already ran this". One
 * measured session spent 57 of 114 tool calls on seven repeated signatures - a
 * single `Grep` ran 22 times with byte-identical arguments and byte-identical
 * `count: 0` results.
 *
 * Repetition comes in two shapes and both have to be stopped, because the second
 * one cannot be caught by looking at results:
 *
 * 1. **Across turns** - the model reads `count: 0`, re-plans, and re-sends the same
 *    call. The first answer is cached, so the repeat is answered from it and the
 *    one after that is refused.
 * 2. **Inside one batch** - the model writes the same call two or three times in a
 *    single reply, and Pi runs `Read`/`Glob`/`Grep` in parallel. No result exists
 *    yet when the second copy starts, so the guard reserves before execution and
 *    the duplicate is skipped while its twin is still running.
 *
 * "Same call" means the same tool name and the same arguments, order-insensitive
 * at every level. A different `pattern`, `path` or `headLimit` is a different
 * call, so widening a query still works.
 */

/** A tool call rendered into a stable string: two equal keys mean two equal calls. */
export function toolCallSignature(name: string, args: unknown): string {
  return `${name}\u0000${canonicalJson(args)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * What the caller must do with a call.
 *
 * - `first`: execute it, then `record` whatever came back - or `release` when the
 *   call never produced an answer (cancelled, aborted by the user).
 * - `duplicate`: do not execute. `previous` carries the earlier answer when there
 *   is one; `in-flight` means an identical call in this same batch is still running.
 * - `refused`: the signature used its allowance; refuse and let the model change
 *   the request or finish.
 */
export type ReservedCall =
  | { kind: "first" }
  | { kind: "duplicate"; reason: "in-flight"; notice: string }
  | { kind: "duplicate"; reason: "answered"; previous: string; notice: string }
  | { kind: "refused"; previous: string; notice: string };

type Entry = {
  /** Rendered result of the first execution; null while it is still running. */
  result: string | null;
  /** True between `reserve` and `record`/`release`. */
  inFlight: boolean;
  /** How many times the call actually ran. */
  executions: number;
  /** How many repeats were already answered from the cache. */
  served: number;
};

/** How many times one signature may run; later copies are refused. */
export const REPEAT_ALLOWANCE = 1;

/**
 * Per-session memory of executed and in-flight calls.
 *
 * Scoped to a session rather than a turn: a model that re-asks two turns later is
 * the same mistake, and the cached answer is still the correct answer.
 */
export class RepeatedToolCallGuard {
  private entries = new Map<string, Entry>();

  /**
   * Claim the right to run a call.
   *
   * Synchronous on purpose: a parallel batch dispatches every call before any
   * result exists, so this is the only point where a duplicate inside one batch is
   * still visible.
   */
  reserve(name: string, args: unknown): ReservedCall {
    const signature = toolCallSignature(name, args);
    const entry = this.entries.get(signature);

    if (!entry) {
      this.entries.set(signature, { result: null, inFlight: true, executions: 0, served: 0 });
      return { kind: "first" };
    }
    if (entry.inFlight) {
      return { kind: "duplicate", reason: "in-flight", notice: inFlightNotice() };
    }
    if (entry.executions === 0) {
      // A reservation was released without ever recording an answer, so there is
      // nothing to replay: this call is genuinely free to run.
      entry.inFlight = true;
      return { kind: "first" };
    }
    const previous = entry.result ?? "";
    if (entry.executions <= REPEAT_ALLOWANCE && entry.served === 0) {
      entry.served += 1;
      return {
        kind: "duplicate",
        reason: "answered",
        previous,
        notice: answeredNotice(entry.executions),
      };
    }
    return { kind: "refused", previous, notice: refusedNotice(entry.executions) };
  }

  /** Record the answer of a reserved call, so its repeats can be answered from it. */
  record(name: string, args: unknown, result: unknown): void {
    const signature = toolCallSignature(name, args);
    const entry = this.entries.get(signature);
    if (!entry) {
      this.entries.set(signature, {
        result: renderResult(result),
        inFlight: false,
        executions: 1,
        served: 0,
      });
      return;
    }
    entry.inFlight = false;
    entry.executions += 1;
    // Keep the first answer: a repeat that returned a different-looking result would
    // restart the loop this cache exists to stop.
    entry.result ??= renderResult(result);
  }

  /**
   * Drop a reservation that produced no answer.
   *
   * Used when a call is cancelled or aborted: nothing was learned, so a later
   * attempt is not a repeat and must not be blocked.
   */
  release(name: string, args: unknown): void {
    const entry = this.entries.get(toolCallSignature(name, args));
    if (entry) entry.inFlight = false;
  }

  /** Signatures seen so far, for the runtime panel and tests. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Forget everything.
   *
   * Called when the session boundary moves (compaction, a new context) because the
   * model's working set no longer holds the earlier answer, so re-asking is
   * legitimate again.
   */
  reset(): void {
    this.entries.clear();
  }
}

function renderResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

function answeredNotice(executions: number): string {
  const times = executions === 1 ? "once" : `${executions} times`;
  return `[repeated-call: this exact call already ran ${times}; the result below is from that run, not a new one. Change the arguments or report what you have.]`;
}

function refusedNotice(executions: number): string {
  return `[repeated-call refused: this exact call already ran ${executions} times with the result below. Do not retry it - change the arguments or report what you have.]`;
}

function inFlightNotice(): string {
  return "[duplicate-call: an identical call in this same batch is already running; its result is on the way. Do not send it again.]";
}
