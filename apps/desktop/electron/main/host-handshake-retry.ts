/**
 * Retry a host call that raced the handshake.
 *
 * Host-core answers `app.handshake` with the protocol receipt and rejects every
 * other method before it with code 1001, "handshake required". Boot code that
 * touches the host — window chrome is the one that showed up as a red toast —
 * can therefore fire a few hundred milliseconds too early, and the failure looks
 * like a real defect in whatever surface made the call.
 *
 * Only that one failure is retried: a genuine RPC error keeps its single attempt.
 */

/**
 * Both shapes of "the host is not there yet": the process has not been spawned
 * (`getHost()` returned null) and the process exists but has not answered
 * `app.handshake`. They arrive within milliseconds of each other on a cold start
 * and both mean the same thing to a caller — try again shortly.
 */
const NOT_READY = ["handshake required", "host-core is unavailable"];

export function isHandshakeRace(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return NOT_READY.some((needle) => message.includes(needle));
}

export type HandshakeRetryOptions = {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Pause between attempts; the handshake lands on the host's own schedule. */
  delayMs: number;
  /** Injected in tests so a retry does not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
};

export async function callAfterHandshake<T>(
  call: () => Promise<T>,
  options: HandshakeRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 8));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (!isHandshakeRace(error) || attempt === attempts - 1) throw error;
      await sleep(options.delayMs);
    }
  }
  throw lastError;
}
