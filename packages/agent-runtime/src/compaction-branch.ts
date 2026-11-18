/**
 * Compaction as a resumable conversation branch instead of a one-shot prune.
 *
 * Hermes (`hermes_state_compression.py`) keeps compression recoverable with three
 * primitives: `publish_compression_child` (close the parent and publish a child
 * that names it, atomically, refusing an empty handoff), `_walk_compression_chain`
 * (root-first lineage walk with a cycle guard and a defensive cap) and
 * `reopen_orphaned_compression_session` (reopen a parent that was closed by
 * compression and whose child never arrived).
 *
 * Pi compacts in place: the child of a compression boundary is the next checkpoint
 * generation written after it, restored by the same `liveSessionContext` path any
 * checkpoint uses. So lineage rides `ContextCompactionRecord.details` — already
 * persisted, already copied by `fork_session_through` — and no schema column is
 * needed for a parent pointer.
 *
 * Two invariants are carried over verbatim because they are what makes the chain
 * trustworthy: a boundary publishes at most one continuation (so a walk can never
 * fork silently), and a handoff that carries no messages is not a branch at all.
 */

import type { ContextCompactionRecord } from "@pi-workspace/shared";

/** `details` key holding the lineage link. Opaque to every other reader. */
export const COMPACTION_BRANCH_DETAILS_KEY = "compressionBranch";

/**
 * Bound on the forward walk. Hermes caps at 1000 because a real lineage reached
 * ~180 segments and an unbounded walk on a corrupted chain never returns.
 */
export const COMPACTION_CHAIN_CAP = 1_000;

/**
 * How long an opened handoff may stay unsettled before recovery treats it as
 * abandoned. Mirrors the compression lease TTL Hermes publishes under
 * (`lease_ttl_seconds: 300`): a live summarizer refreshes its lease, a dead one
 * stops holding the boundary.
 */
export const COMPRESSION_HANDOFF_LEASE_MS = 300_000;

export type CompressionBranchKind =
  /** Automatic boundary; continues the parent boundary. */
  | "compression"
  /** User asked for it (`/compact`). */
  | "manual"
  /** A deliberate fork the user opened from a boundary. */
  | "branch";

/** What one checkpoint records about the boundary it continues. */
export type CompressionBranchLink = {
  /** Session the checkpoint was written into. */
  sessionId: string;
  /** Boundary checkpoint this one continues; absent for a session's first boundary. */
  parentCheckpointId?: string;
  /** Session that owned `parentCheckpointId`; absent when it is the same session. */
  parentSessionId?: string;
  kind: CompressionBranchKind;
  /** ISO timestamp of publication. */
  publishedAt: string;
  /** Messages the handoff carried. A branch with none is refused. */
  handoffMessageCount: number;
};

export type CompressionBranchRefusal =
  | "empty_handoff"
  | "missing_checkpoint_id"
  | "parent_missing"
  | "parent_superseded"
  | "cycle";

/** A refused publication. Callers treat this as "no branch", never as a crash. */
export class CompressionBranchRefusedError extends Error {
  readonly code: CompressionBranchRefusal;

  constructor(code: CompressionBranchRefusal, message: string) {
    super(message);
    this.name = "CompressionBranchRefusedError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function checkpointDetails(
  checkpoint: Pick<ContextCompactionRecord, "details"> | undefined,
): Record<string, unknown> | undefined {
  return record(checkpoint?.details);
}

const BRANCH_KINDS: readonly CompressionBranchKind[] = ["compression", "manual", "branch"];

/**
 * The lineage link a checkpoint carries, if any. Every field is re-validated: the
 * `details` blob is persisted JSON an older or newer build may have written.
 */
export function readCompressionBranch(
  checkpoint: Pick<ContextCompactionRecord, "details"> | undefined,
): CompressionBranchLink | undefined {
  const link = record(checkpointDetails(checkpoint)?.[COMPACTION_BRANCH_DETAILS_KEY]);
  if (!link) return undefined;
  const sessionId = nonEmptyString(link.sessionId);
  const kind = nonEmptyString(link.kind);
  const publishedAt = nonEmptyString(link.publishedAt);
  const handoffMessageCount = link.handoffMessageCount;
  if (!sessionId || !kind || !publishedAt) return undefined;
  if (!BRANCH_KINDS.includes(kind as CompressionBranchKind)) return undefined;
  if (typeof handoffMessageCount !== "number" || !Number.isFinite(handoffMessageCount)) {
    return undefined;
  }
  const parentCheckpointId = nonEmptyString(link.parentCheckpointId);
  const parentSessionId = nonEmptyString(link.parentSessionId);
  return {
    sessionId,
    ...(parentCheckpointId ? { parentCheckpointId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    kind: kind as CompressionBranchKind,
    publishedAt,
    handoffMessageCount,
  };
}

/** The checkpoint `id`, first occurrence wins; checkpoints are appended over time. */
function byId(
  checkpoints: readonly ContextCompactionRecord[],
): Map<string, ContextCompactionRecord> {
  const index = new Map<string, ContextCompactionRecord>();
  for (const checkpoint of checkpoints) {
    if (!checkpoint?.id || index.has(checkpoint.id)) continue;
    index.set(checkpoint.id, checkpoint);
  }
  return index;
}

/**
 * The first checkpoint of a session's lineage: one that names no parent, else the
 * oldest checkpoint (a session whose first boundary was written before lineage
 * existed has no root link).
 */
export function compressionChainRoot(
  checkpoints: readonly ContextCompactionRecord[],
): ContextCompactionRecord | undefined {
  const first = checkpoints.find((checkpoint) => checkpoint?.id);
  if (!first) return undefined;
  for (const checkpoint of checkpoints) {
    if (!checkpoint?.id) continue;
    if (!readCompressionBranch(checkpoint)?.parentCheckpointId) return checkpoint;
  }
  return first;
}

export type CompressionChain = {
  /** Boundary ids, root first. */
  ids: string[];
  /** True when the walk hit `cap` before reaching a tip. */
  truncated: boolean;
  /** True when a checkpoint named an ancestor as its parent. */
  cycle: boolean;
};

/**
 * Root-first ids from `fromCheckpointId` (default: the lineage root) through its
 * tip, following the continuation pointer. Hermes' `_walk_compression_chain`,
 * including the `seen` cycle guard and the defensive cap.
 */
export function compressionChain(
  checkpoints: readonly ContextCompactionRecord[],
  options: { fromCheckpointId?: string; cap?: number } = {},
): CompressionChain {
  const index = byId(checkpoints);
  const cap = Math.max(1, Math.floor(options.cap ?? COMPACTION_CHAIN_CAP));
  const current = (options.fromCheckpointId && index.get(options.fromCheckpointId)) ||
    compressionChainRoot(checkpoints);
  if (!current) return { ids: [], truncated: false, cycle: false };
  // A boundary publishes at most one continuation, so the first child in
  // append order is the preferred one; a later sibling cannot steal the walk.
  const childOf = new Map<string, string>();
  for (const checkpoint of checkpoints) {
    const parentId = readCompressionBranch(checkpoint)?.parentCheckpointId;
    if (!parentId || !checkpoint?.id) continue;
    if (!childOf.has(parentId)) childOf.set(parentId, checkpoint.id);
  }
  const ids = [current.id];
  const seen = new Set(ids);
  let cursor = current.id;
  // `cap` bounds the number of boundaries returned, root included — it is not a
  // hop budget, so a cap of 3 reports c1..c3 rather than letting the third hop
  // add a fourth id the caller never asked for.
  while (ids.length < cap) {
    const next = childOf.get(cursor);
    if (!next) return { ids, truncated: false, cycle: false };
    if (seen.has(next)) return { ids, truncated: false, cycle: true };
    seen.add(next);
    cursor = next;
    ids.push(next);
  }
  return { ids, truncated: childOf.has(cursor), cycle: false };
}

/** The newest boundary of a lineage: the checkpoint a new one would continue. */
export function compressionBranchTip(
  checkpoints: readonly ContextCompactionRecord[],
): ContextCompactionRecord | undefined {
  const chain = compressionChain(checkpoints);
  const tipId = chain.ids.at(-1);
  if (!tipId) {
    return checkpoints.filter((checkpoint) => checkpoint?.id).at(-1);
  }
  return byId(checkpoints).get(tipId);
}

/** True when `parentCheckpointId` already has a continuation other than `exceptId`. */
function hasContinuation(
  checkpoints: readonly ContextCompactionRecord[],
  parentCheckpointId: string,
  exceptId?: string,
): boolean {
  return checkpoints.some((checkpoint) => {
    if (!checkpoint?.id || checkpoint.id === exceptId) return false;
    return readCompressionBranch(checkpoint)?.parentCheckpointId === parentCheckpointId;
  });
}

export type PublishCompressionBranchInput = {
  /** The checkpoint being written; returned with its lineage link attached. */
  checkpoint: ContextCompactionRecord;
  /** Checkpoints already durable in the session. */
  checkpoints: readonly ContextCompactionRecord[];
  /** Session the checkpoint is written into. */
  sessionId: string;
  /** Messages the handoff carries. Zero is refused, as in Hermes. */
  handoffMessageCount: number;
  kind?: CompressionBranchKind;
  /** Session that owns the parent boundary; defaults to the parent link's own. */
  parentSessionId?: string;
  /**
   * Boundary to continue. Defaults to the lineage tip; naming one explicitly is
   * how a publication that arrived late (an imported or adopted checkpoint) is
   * refused when that boundary already published its continuation.
   */
  parentCheckpointId?: string;
  publishedAt?: string;
};

/**
 * Publish `checkpoint` as the continuation of the session's current boundary.
 *
 * Returns a new record; the input is never mutated. Throws
 * `CompressionBranchRefusedError` when the publication cannot be trusted:
 * an empty handoff, a missing id, a second child for one boundary, or a
 * self-referential link. Callers record the checkpoint without a link instead of
 * failing the turn.
 */
export function publishCompressionBranch(
  input: PublishCompressionBranchInput,
): ContextCompactionRecord {
  const { checkpoint, checkpoints, handoffMessageCount } = input;
  if (!Number.isFinite(handoffMessageCount) || handoffMessageCount <= 0) {
    throw new CompressionBranchRefusedError(
      "empty_handoff",
      "compression branch handoff must not be empty",
    );
  }
  if (!checkpoint?.id) {
    throw new CompressionBranchRefusedError(
      "missing_checkpoint_id",
      "compression branch needs a checkpoint id",
    );
  }
  const requestedParentId = nonEmptyString(input.parentCheckpointId);
  const parent = requestedParentId
    ? byId(checkpoints).get(requestedParentId)
    : compressionBranchTip(checkpoints);
  if (requestedParentId && !parent) {
    throw new CompressionBranchRefusedError(
      "parent_missing",
      `compression boundary ${requestedParentId} is not durable`,
    );
  }
  if (parent?.id === checkpoint.id) {
    throw new CompressionBranchRefusedError(
      "cycle",
      `compression branch ${checkpoint.id} cannot continue itself`,
    );
  }
  if (parent && hasContinuation(checkpoints, parent.id, checkpoint.id)) {
    throw new CompressionBranchRefusedError(
      "parent_superseded",
      `compression boundary ${parent.id} already has a continuation`,
    );
  }
  const sessionId = nonEmptyString(input.sessionId);
  if (!sessionId) {
    throw new CompressionBranchRefusedError(
      "missing_checkpoint_id",
      "compression branch needs the session it belongs to",
    );
  }
  const parentSessionId =
    nonEmptyString(input.parentSessionId) ?? readCompressionBranch(parent)?.sessionId;
  const link: CompressionBranchLink = {
    sessionId,
    ...(parent?.id ? { parentCheckpointId: parent.id } : {}),
    ...(parent?.id && parentSessionId ? { parentSessionId } : {}),
    kind: input.kind ?? "compression",
    publishedAt: input.publishedAt ?? new Date().toISOString(),
    handoffMessageCount: Math.floor(handoffMessageCount),
  };
  return {
    ...checkpoint,
    details: {
      ...(record(checkpoint.details) ?? {}),
      [COMPACTION_BRANCH_DETAILS_KEY]: link,
    },
  };
}

export type CompressionReturnResult =
  | { kind: "returned"; checkpoint: ContextCompactionRecord }
  | { kind: "refused"; reason: "no_branch" | "parent_missing" };

/**
 * Walk back to the boundary `current` continues — the "return to the parent
 * conversation" half of a resumable branch. The caller installs the returned
 * checkpoint, which restores the parent window exactly as it was published.
 */
export function returnToParentCheckpoint(
  checkpoints: readonly ContextCompactionRecord[],
  current: Pick<ContextCompactionRecord, "id" | "details">,
): CompressionReturnResult {
  const parentId = readCompressionBranch(current)?.parentCheckpointId;
  if (!parentId) return { kind: "refused", reason: "no_branch" };
  const parent = byId(checkpoints).get(parentId);
  if (!parent) return { kind: "refused", reason: "parent_missing" };
  return { kind: "returned", checkpoint: parent };
}

/** A handoff that was opened and has not yet been settled by a publication. */
export type PendingCompressionHandoff = {
  sessionId: string;
  /** Boundary the handoff continues; absent for a session's first boundary. */
  parentCheckpointId?: string;
  /** Epoch ms when the summarizer claimed the boundary. */
  startedAt: number;
};

/**
 * Open/settle bookkeeping for one runtime process.
 *
 * Hermes persists this as a compression lease row; Pi keeps it in the runtime
 * that owns the turn, because the boundary it guards cannot outlive that runtime
 * (a restarted runtime reloads the durable checkpoint, which either carries the
 * lineage link or is still the tip). The registry is what makes an interrupted
 * handoff visible instead of silently ending a conversation on a boundary whose
 * child never arrived.
 */
export class CompressionHandoffRegistry {
  private readonly open = new Map<string, PendingCompressionHandoff>();

  begin(handoff: PendingCompressionHandoff): void {
    this.open.set(handoff.sessionId, handoff);
  }

  /** True when a handoff was actually open. */
  settle(sessionId: string): boolean {
    return this.open.delete(sessionId);
  }

  peek(sessionId: string): PendingCompressionHandoff | undefined {
    return this.open.get(sessionId);
  }

  size(): number {
    return this.open.size;
  }
}

export type CompressionReopenDecision =
  | { reopen: true; reason: "orphaned_handoff"; checkpoint?: ContextCompactionRecord }
  | {
      reopen: false;
      reason: "no_handoff" | "handoff_too_old" | "continuation_published";
    };

/**
 * Hermes' `reopen_orphaned_compression_session`, expressed over checkpoints.
 *
 * Reopen only when a handoff was opened, it is still inside its lease, and no
 * continuation was published for that boundary. Conservative in the same
 * direction as Hermes: any canonical child means another path owns the lineage,
 * and an expired lease means the attempt is presumed dead rather than recovered.
 */
export function reopenOrphanedCompressionSession(input: {
  handoff?: PendingCompressionHandoff;
  checkpoints: readonly ContextCompactionRecord[];
  at: number;
  leaseMs?: number;
}): CompressionReopenDecision {
  const { handoff, checkpoints, at } = input;
  if (!handoff) return { reopen: false, reason: "no_handoff" };
  const leaseMs = Math.max(0, input.leaseMs ?? COMPRESSION_HANDOFF_LEASE_MS);
  if (!Number.isFinite(at) || at - handoff.startedAt > leaseMs) {
    return { reopen: false, reason: "handoff_too_old" };
  }
  if (
    handoff.parentCheckpointId &&
    hasContinuation(checkpoints, handoff.parentCheckpointId)
  ) {
    return { reopen: false, reason: "continuation_published" };
  }
  const parent = handoff.parentCheckpointId
    ? byId(checkpoints).get(handoff.parentCheckpointId)
    : compressionBranchTip(checkpoints);
  return { reopen: true, reason: "orphaned_handoff", ...(parent ? { checkpoint: parent } : {}) };
}
