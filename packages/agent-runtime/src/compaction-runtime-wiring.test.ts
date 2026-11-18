/**
 * Integration coverage for the compaction wiring in `runtime.ts`.
 *
 * The three building blocks have their own unit tests. This file exercises the
 * composition the runtime actually performs — the ledger's budget projection,
 * the failure cooldown, and the checkpoint lineage link — with a fake context
 * budget and fake checkpoints, so the seam is covered without a model, a host,
 * or a session.
 */

import { describe, expect, it } from "vitest";
import type { ContextCompactionRecord } from "@pi-workspace/shared";
import { automaticCompactionGate } from "./compaction-auto-gate.js";
import {
  compressionBranchTip,
  publishCompressionBranch,
  readCompressionBranch,
} from "./compaction-branch.js";
import {
  CompressionFailureCooldownStore,
  compressionCooldownDiagnostic,
} from "./compaction-cooldown.js";
import { TurnTokenLedger } from "./turn-token-ledger.js";

const SESSION = "session-1";

function gate(input: {
  ledger: TurnTokenLedger;
  tokens: number;
  hardLimit: number;
  cooldowns: CompressionFailureCooldownStore;
  at?: number;
}) {
  return automaticCompactionGate({
    ledger: input.ledger,
    budget: { tokens: input.tokens, hardLimit: input.hardLimit },
    cooldowns: input.cooldowns,
    sessionId: SESSION,
    at: input.at ?? 0,
  });
}

function checkpoint(
  id: string,
  overrides: Partial<ContextCompactionRecord> = {},
): ContextCompactionRecord {
  return {
    id,
    summary: `summary of ${id}`,
    throughMessageId: `msg-${id}`,
    tokensBefore: 180_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("automatic compaction gate", () => {
  it("keeps the unchanged context threshold when the turn carried no tool output", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("t1");
    const cooldowns = new CompressionFailureCooldownStore();

    // Half of a 1M window is 500k: one token short triggers nothing.
    const below = gate({ ledger, tokens: 499_999, hardLimit: 1_000_000, cooldowns });
    expect(below.trigger).toBeNull();
    expect(below.compact).toBe(false);
    expect(below.view.thresholdTokens).toBe(500_000);

    const at = gate({ ledger, tokens: 500_000, hardLimit: 1_000_000, cooldowns });
    expect(at.trigger).toBe("context_threshold");
    expect(at.compact).toBe(true);
  });

  it("compacts a tool-heavy turn early, but never below 0.8 of the threshold", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("t1");
    // Three capped results: 24k of the 40k window, i.e. a 60% tool share.
    for (let index = 0; index < 3; index += 1) ledger.recordToolResult(8_000);
    const cooldowns = new CompressionFailureCooldownStore();

    // Threshold is 20k, the floor is 16k, and 17k is under neither the threshold
    // nor the floor — yet the tool share alone is worth compacting.
    const early = gate({ ledger, tokens: 17_000, hardLimit: 40_000, cooldowns });
    expect(early.trigger).toBe("tool_result_share");
    expect(early.compact).toBe(true);

    // Below the floor a tool-heavy turn is small: the ledger must not compact.
    const small = gate({ ledger, tokens: 15_000, hardLimit: 40_000, cooldowns });
    expect(small.trigger).toBeNull();
    expect(small.compact).toBe(false);
  });

  it("holds automatic attempts back while a failure cooldown is live, except at the hard limit", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("t1");
    const cooldowns = new CompressionFailureCooldownStore();
    cooldowns.recordFailure(SESSION, { at: 1_000, error: "summary provider 500" });

    const held = gate({ ledger, tokens: 500_000, hardLimit: 1_000_000, cooldowns, at: 2_000 });
    expect(held.trigger).toBe("context_threshold");
    expect(held.suppressedByCooldown).toBe(true);
    expect(held.compact).toBe(false);
    expect(compressionCooldownDiagnostic(held.cooldown)).toEqual({
      coolingDown: true,
      cooldownRemainingMs: 59_000,
      cooldownFailures: 1,
    });

    // The hard limit outranks the cooldown: a rejected request is worse.
    const forced = gate({ ledger, tokens: 1_000_000, hardLimit: 1_000_000, cooldowns, at: 2_000 });
    expect(forced.suppressedByCooldown).toBe(false);
    expect(forced.compact).toBe(true);

    // Past the deadline the cooldown no longer holds anything back.
    const lapsed = gate({ ledger, tokens: 500_000, hardLimit: 1_000_000, cooldowns, at: 61_000 });
    expect(lapsed.cooldown).toBeUndefined();
    expect(lapsed.compact).toBe(true);
  });

  it("escalates the cooldown while the same boundary keeps failing and clears it on success", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("t1");
    const cooldowns = new CompressionFailureCooldownStore();

    // First automatic failure: 60s of no retries.
    cooldowns.recordFailure(SESSION, { at: 0, error: "timeout" });
    expect(gate({ ledger, tokens: 500_000, hardLimit: 1_000_000, cooldowns, at: 30_000 }).compact).toBe(false);

    // Second failure at the next boundary: the ladder escalates to 300s.
    const second = cooldowns.recordFailure(SESSION, { at: 60_000 });
    expect(second?.consecutiveFailures).toBe(2);
    expect(cooldowns.active(SESSION, 100_000)?.cooldownUntil).toBe(360_000);
    expect(gate({ ledger, tokens: 500_000, hardLimit: 1_000_000, cooldowns, at: 100_000 }).compact).toBe(false);

    // A successful compression resets the streak and the deadline.
    cooldowns.clear(SESSION);
    const cleared = gate({ ledger, tokens: 500_000, hardLimit: 1_000_000, cooldowns, at: 100_000 });
    expect(cleared.cooldown).toBeUndefined();
    expect(cleared.compact).toBe(true);
    expect(compressionCooldownDiagnostic(cleared.cooldown)).toEqual({ coolingDown: false });
  });

  it("does not gate a runtime whose ledger is attached but whose context is unchanged", () => {
    // The clock moves, the ledger is fresh, and nothing about the budget
    // changed: the decision is the same as the pre-ledger comparison.
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("t1");
    ledger.recordUsage({ inputTokens: 40_000, outputTokens: 2_000 });
    const cooldowns = new CompressionFailureCooldownStore();
    const view = gate({ ledger, tokens: 120_000, hardLimit: 1_000_000, cooldowns, at: 5_000 });
    expect(view.view.inputTokens).toBe(40_000);
    expect(view.compact).toBe(false);
  });
});

describe("checkpoint lineage (runtime publish path)", () => {
  /** The runtime's own publish-or-keep-the-checkpoint rule. */
  function withBranch(
    record: ContextCompactionRecord,
    checkpoints: readonly ContextCompactionRecord[],
    kind: "compression" | "manual" = "compression",
  ): ContextCompactionRecord {
    const carriedTail = Array.isArray(record.retainedTail) ? record.retainedTail.length : 0;
    const handoffMessageCount = carriedTail + (record.summary ? 1 : 0);
    try {
      return publishCompressionBranch({
        checkpoint: record,
        checkpoints,
        sessionId: SESSION,
        handoffMessageCount,
        kind,
      });
    } catch {
      return record;
    }
  }

  it("links a new checkpoint to the installed boundary and moves the tip", () => {
    const parent = checkpoint("c1", { details: { generation: 1 } });
    const child = withBranch(
      checkpoint("c2", {
        details: { generation: 2 },
        retainedTail: [{ role: "user", content: "tail" }],
      }),
      [parent],
    );

    expect(readCompressionBranch(child)).toMatchObject({
      sessionId: SESSION,
      parentCheckpointId: "c1",
      kind: "compression",
      handoffMessageCount: 2,
    });
    // `parentSessionId` is only filled from the parent's own link, so a first
    // boundary (no link yet) leaves it absent rather than guessing a session.
    expect(readCompressionBranch(child)?.parentSessionId).toBeUndefined();
    // Details the checkpoint already carried survive the publication.
    expect((child.details as Record<string, unknown>).generation).toBe(2);
    expect(compressionBranchTip([parent, child])?.id).toBe("c2");
    // The parent record itself is never mutated.
    expect(readCompressionBranch(parent)).toBeUndefined();
  });

  it("records a manual boundary as a manual branch", () => {
    const parent = checkpoint("c1");
    const child = withBranch(checkpoint("c2"), [parent], "manual");
    expect(readCompressionBranch(child)?.kind).toBe("manual");
  });

  it("keeps the checkpoint unchanged when the boundary carries nothing", () => {
    const bare = checkpoint("c2", { summary: "", retainedTail: [] });
    expect(withBranch(bare, [])).toBe(bare);
    expect(readCompressionBranch(bare)).toBeUndefined();
  });

  it("extends the lineage from the current tip rather than the oldest boundary", () => {
    const parent = checkpoint("c1");
    const first = withBranch(checkpoint("c2"), [parent]);
    const second = withBranch(checkpoint("c3"), [parent, first]);
    // The runtime always hands over the installed checkpoint, which is the tip,
    // so a third boundary continues the second instead of forking the chain.
    expect(readCompressionBranch(second)?.parentCheckpointId).toBe("c2");
    expect(readCompressionBranch(second)?.parentSessionId).toBe(SESSION);
    expect(compressionBranchTip([parent, first, second])?.id).toBe("c3");
  });
});
