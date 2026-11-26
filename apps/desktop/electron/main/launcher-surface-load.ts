/**
 * Retry the launcher surface's first load.
 *
 * The retained launcher is prewarmed about a second into boot, while the app is
 * still allocating its first window, the plugin host and host-core. On a small
 * fraction of starts the `file://` navigation of that surface is aborted before
 * the renderer commits — Electron rejects it with `ERR_FAILED (-2)` a few
 * milliseconds in — and the same load succeeds when it is simply tried again.
 *
 * That failure used to be terminal for the whole session: the launcher is the
 * only way into a plugin's own panel window, so an unbuilt launcher reads as
 * "clicking a plugin does nothing". Retrying the navigation on the window that
 * already exists costs one boot-time re-navigation and removes that outcome.
 *
 * Only an aborted or failed navigation is retried. A missing file
 * (`ERR_FILE_NOT_FOUND`) or a rejected URL is a build or configuration defect
 * and has to surface on the first attempt instead of being retried three times
 * and then reported as the same error anyway.
 */

/** Error codes Chromium reports when a navigation was cut short by a restart. */
const RETRYABLE_CODES = [-2, -3];

/** Electron renders a failed load as `ERR_FAILED (-2) loading '<url>'`. */
const RETRYABLE_MARKERS = ["err_failed", "err_aborted"];

/**
 * Whether a load failure looks like a navigation that lost a race with boot.
 *
 * Matched on the code in Electron's message rather than the human sentence, so a
 * renamed error string cannot silently turn the retry off; the marker list is the
 * narrower fallback for a bare `Error` built from `errno`.
 */
export function isLauncherLoadRace(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (!message) return false;
  if (message.includes("err_file_not_found") || message.includes("err_invalid_url")) return false;
  for (const code of RETRYABLE_CODES) {
    if (message.includes(`(${code})`)) return true;
  }
  return RETRYABLE_MARKERS.some((marker) => message.includes(marker));
}

export type LauncherLoadRetryOptions = {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Pause between attempts; boot is still settling when the first one fails. */
  delayMs: number;
  /** Injected in tests so a retry does not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry, so a recovered race is still visible in the log. */
  onRetry?: (info: { attempt: number; error: unknown }) => void;
};

/**
 * Run the surface load, retrying only the boot-race failure.
 *
 * The loader re-navigates the existing window: an aborted navigation leaves the
 * window usable, and recreating it would drop the bounds and the listeners the
 * launcher installs on it.
 */
export async function loadLauncherSurface(
  load: () => Promise<void>,
  options: LauncherLoadRetryOptions,
): Promise<void> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 3));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await load();
      return;
    } catch (error) {
      lastError = error;
      if (!isLauncherLoadRace(error) || attempt === attempts) throw error;
      options.onRetry?.({ attempt, error });
      await sleep(options.delayMs);
    }
  }
  throw lastError;
}
