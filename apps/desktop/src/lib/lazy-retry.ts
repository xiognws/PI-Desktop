/**
 * A route that survives one bad module fetch.
 *
 * Routes are code-split with `lazy(() => import(...))`. That import is a network
 * request in development (one per module, hundreds of them) and a chunk request
 * in production, and a single failure rejects it — the router then has no
 * component to render and the whole surface is replaced by the crash panel:
 *
 *     TypeError: Failed to fetch dynamically imported module: …/SettingsPage.tsx
 *
 * Measured on a laptop whose network adapter flaps: entering Settings for the
 * first time failed exactly this way, and the only recovery was reloading the
 * app. A retry is enough — the second attempt is served from a warm connection,
 * and the same helper covers the "new version replaced the old chunks" case after
 * an update.
 */

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 120;

/** Run `load`, retrying a rejection a bounded number of times. */
export async function retryImport<T>(
  load: () => Promise<T>,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(attempts, 1); attempt += 1) {
    try {
      return await load();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      // Back off a little: the usual cause is a connection that is being
      // re-established, and retrying in the same tick fails the same way.
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

/**
 * `React.lazy` with the retry above.
 *
 * Kept separate from the component file so the retry can be tested as a plain
 * async function: a test that renders routes would need a router, a boundary and
 * a dev server to prove the same thing.
 */
export function lazyRoute<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    // One promise per route, like `lazy` itself: a retry after the first success
    // must not re-run the import.
    cached ??= retryImport(load);
    return cached;
  };
}
