/**
 * Compression-failure cooldown.
 *
 * Hermes records a cooldown deadline after a failed compression so the same
 * failing summary is not re-issued on every turn: `record_compression_failure_cooldown`
 * merges with the maximum of any live deadline (a later shorter write must not
 * reopen the thrash window) and `get_compression_failure_cooldown` returns the row
 * only while it is unexpired. The duration escalates on a ladder indexed by the
 * consecutive-failure streak (`_TIMEOUT_COOLDOWN_LADDER = (60, 300, 900)`), because
 * a structural repeat offender is not a transient fault.
 *
 * In Pi the ledger is process-local on purpose: the boundary it guards belongs to
 * the runtime that owns the turn, and the durable evidence of a compression is the
 * checkpoint itself. Cooldown state therefore never outlives the runtime that
 * observed the failure — which is exactly the scope in which it can prevent spend.
 */

/**
 * Escalating ladder for consecutive failures at the same boundary, in ms.
 * Values mirror Hermes' 60s -> 300s -> 900s rungs.
 */
export const COMPRESSION_FAILURE_COOLDOWN_LADDER_MS: readonly number[] = [
  60_000,
  300_000,
  900_000,
];

/** Rung for a streak count; the last rung repeats. */
export function compressionFailureCooldownMs(
  consecutiveFailures: number,
  ladder: readonly number[] = COMPRESSION_FAILURE_COOLDOWN_LADDER_MS,
): number {
  if (ladder.length === 0) return 0;
  const streak = Number.isFinite(consecutiveFailures)
    ? Math.max(1, Math.floor(consecutiveFailures))
    : 1;
  return ladder[Math.min(streak, ladder.length) - 1] ?? ladder.at(-1) ?? 0;
}

/** Stored cooldown columns for one session, without any expiry filtering. */
export type CompressionCooldownRow = {
  /** Epoch ms when the cooldown lapses; absent when never recorded. */
  cooldownUntil?: number;
  /** Latest diagnostic of the failure that armed it. */
  error?: string;
  /** Failures observed since the last successful compression. */
  consecutiveFailures: number;
};

/** A cooldown that is live at the time it was read. */
export type ActiveCompressionCooldown = {
  cooldownUntil: number;
  remainingMs: number;
  consecutiveFailures: number;
  error?: string;
};

const MAX_ERROR_CHARS = 400;

function boundedError(error: unknown): string | undefined {
  if (typeof error !== "string") return undefined;
  const trimmed = error.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ERROR_CHARS ? trimmed.slice(0, MAX_ERROR_CHARS) : trimmed;
}

/**
 * Cooldown rows keyed by session. Same contract as the Hermes store methods:
 * merge-max deadline, latest error wins, expiry is evaluated on read.
 */
export class CompressionFailureCooldownStore {
  private readonly rows = new Map<string, CompressionCooldownRow>();

  /**
   * Arm (or extend) the cooldown after a failure at `at`.
   *
   * The deadline is `max(stored, at + rung)`: a shorter later write can never pull
   * an existing deadline forward, so a burst of failures cannot keep reopening the
   * window it just closed.
   */
  recordFailure(
    sessionId: string,
    input: { at: number; error?: string; ladder?: readonly number[] },
  ): ActiveCompressionCooldown | undefined {
    if (!sessionId || !Number.isFinite(input.at)) return undefined;
    const previous = this.rows.get(sessionId);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const deadline = input.at + compressionFailureCooldownMs(consecutiveFailures, input.ladder);
    const cooldownUntil = Math.max(previous?.cooldownUntil ?? 0, deadline);
    const error = boundedError(input.error) ?? previous?.error;
    this.rows.set(sessionId, {
      cooldownUntil,
      consecutiveFailures,
      ...(error ? { error } : {}),
    });
    return this.active(sessionId, input.at);
  }

  /** Failure streak, whether or not a cooldown is still live. */
  failures(sessionId: string): number {
    return this.rows.get(sessionId)?.consecutiveFailures ?? 0;
  }

  /** Exact stored row, no expiry filtering. */
  row(sessionId: string): CompressionCooldownRow | undefined {
    const row = this.rows.get(sessionId);
    return row ? { ...row } : undefined;
  }

  /**
   * The live cooldown for `sessionId`, or undefined when none was recorded or it
   * has lapsed. An expired row is left in place: only a successful compression
   * clears it, so the streak keeps escalating across expiries.
   */
  active(sessionId: string, at: number): ActiveCompressionCooldown | undefined {
    const row = this.rows.get(sessionId);
    if (!row || row.cooldownUntil === undefined) return undefined;
    if (!Number.isFinite(at) || row.cooldownUntil <= at) return undefined;
    return {
      cooldownUntil: row.cooldownUntil,
      remainingMs: row.cooldownUntil - at,
      consecutiveFailures: row.consecutiveFailures,
      ...(row.error ? { error: row.error } : {}),
    };
  }

  /** Successful compression: the streak and the deadline both reset. */
  clear(sessionId: string): void {
    this.rows.delete(sessionId);
  }

  clearAll(): void {
    this.rows.clear();
  }
}

/** Fields a diagnostic may publish about an active cooldown. Bounded and typed. */
export function compressionCooldownDiagnostic(
  cooldown: ActiveCompressionCooldown | undefined,
): Record<string, unknown> {
  if (!cooldown) return { coolingDown: false };
  return {
    coolingDown: true,
    cooldownRemainingMs: Math.max(0, Math.round(cooldown.remainingMs)),
    cooldownFailures: cooldown.consecutiveFailures,
  };
}
