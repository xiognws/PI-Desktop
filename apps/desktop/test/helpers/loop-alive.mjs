/**
 * Keep a test's event loop alive around a wait that is itself unref'd.
 *
 * Product code unrefs timers and abort signals so a hung dependency cannot hold
 * the app open — `AbortSignal.timeout`, `raceWithTimeout`, and the update cache's
 * kill timers all do this. In a test nothing else holds the loop, so node ends it
 * before the timeout fires and the runner reports "Promise resolution is still
 * pending but the event loop has already resolved".
 *
 * Wrap the wait, not the whole test: the point is to prove the wait settles, not
 * to keep the process busy afterwards.
 */
export async function withLoopAlive(promise, keepAliveMs = 30_000) {
  const keepAlive = setTimeout(() => undefined, keepAliveMs);
  try {
    return await promise;
  } finally {
    clearTimeout(keepAlive);
  }
}
