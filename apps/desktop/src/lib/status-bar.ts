/**
 * The status bar summarises work in flight. Both counts come from queues the
 * store already keeps, so nothing new is tracked just for display.
 */
export function runningSessionsCount(map: Record<string, boolean> | undefined): number {
  if (!map) return 0;
  let total = 0;
  for (const active of Object.values(map)) if (active) total += 1;
  return total;
}

/** `[██████░░░░]` — ten cells, same idea as the terminal bars this app mirrors. */
export function contextBarText(percent: number | undefined, width = 10): string {
  const bounded = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((bounded / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/** `842` / `42.1k` / `1.2M` — token counts stay short enough for a 30px bar. */
export function compactTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** `0:42`, `12:05`, `1:02:33`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function pendingPermissionsCount(
  queues: Record<string, readonly unknown[]> | undefined,
): number {
  if (!queues) return 0;
  let total = 0;
  for (const queue of Object.values(queues)) total += queue.length;
  return total;
}
