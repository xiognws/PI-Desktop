/**
 * Whether a rejected call failed only because the host is not answering yet.
 *
 * Main throws `new Error("host unavailable")` from every IPC handler until the host
 * bridge is up, so this is the one message a caller may safely retry.
 */
export function isHostNotReadyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /host unavailable/i.test(message);
}

/**
 * Run `attempt`, retrying while the host is still starting.
 *
 * Only a "host unavailable" rejection is retried: a real failure (a bad row, a refused
 * permission) must surface immediately instead of being hidden behind three sleeps.
 * The last error is rethrown so the caller decides what the user sees.
 */
export async function retryWhileHostNotReady<T>(
  attempt: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const delayMs = Math.max(0, options.delayMs ?? 200);
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (!isHostNotReadyError(error) || index === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (index + 1)));
    }
  }
  throw lastError;
}
