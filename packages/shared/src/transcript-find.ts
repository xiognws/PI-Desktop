/**
 * Where a find bar stands, as plain arithmetic.
 *
 * The bar owns no state of its own beyond what it renders: the transcript
 * supplies how many matches the DOM currently holds and which one is active, so
 * these two helpers are the only place stepping and display rules live.
 */

/**
 * The next match after a step, wrapping in both directions. `-1` means nothing
 * is active yet (the query just changed), so a forward step starts at the first
 * match and a backward step starts at the last.
 */
export function stepFindIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : total - 1;
  return (((current + delta) % total) + total) % total;
}

/** 1-based "3 of 17" for display; `0 / 0` when the query matches nothing. */
export function findPosition(index: number, total: number): { current: number; total: number } {
  if (total <= 0) return { current: 0, total: 0 };
  const clamped = index < 0 ? 0 : index >= total ? total - 1 : index;
  return { current: clamped + 1, total };
}
