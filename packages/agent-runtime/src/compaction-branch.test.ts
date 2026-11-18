import { describe, expect, it } from "vitest";
import type { ContextCompactionRecord } from "@pi-workspace/shared";
import {
  COMPACTION_BRANCH_DETAILS_KEY,
  CompressionBranchRefusedError,
  CompressionHandoffRegistry,
  compressionBranchTip,
  compressionChain,
  compressionChainRoot,
  publishCompressionBranch,
  readCompressionBranch,
  reopenOrphanedCompressionSession,
  returnToParentCheckpoint,
} from "./compaction-branch.js";

function checkpoint(
  id: string,
  overrides: Partial<ContextCompactionRecord> = {},
): ContextCompactionRecord {
  return {
    id,
    summary: `summary ${id}`,
    throughMessageId: `m-${id}`,
    tokensBefore: 1000,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A lineage where `child` continues `parent`. */
function publish(
  parent: ContextCompactionRecord | undefined,
  child: ContextCompactionRecord,
  checkpoints: ContextCompactionRecord[],
): ContextCompactionRecord {
  return publishCompressionBranch({
    checkpoint: child,
    checkpoints: parent ? [...checkpoints, parent] : checkpoints,
    sessionId: "s1",
    handoffMessageCount: 3,
    publishedAt: "2026-01-01T00:00:01.000Z",
  });
}

describe("publishCompressionBranch", () => {
  it("links a continuation to the boundary it continues", () => {
    const first = publish(undefined, checkpoint("c1"), []);
    const second = publish(first, checkpoint("c2"), []);

    expect(readCompressionBranch(first)).toMatchObject({
      sessionId: "s1",
      kind: "compression",
      handoffMessageCount: 3,
    });
    expect(readCompressionBranch(first)?.parentCheckpointId).toBeUndefined();
    expect(readCompressionBranch(second)).toMatchObject({
      sessionId: "s1",
      parentCheckpointId: "c1",
      parentSessionId: "s1",
    });
  });

  it("keeps the details other writers put on the checkpoint", () => {
    const first = publish(undefined, checkpoint("c1"), []);
    const linked = publishCompressionBranch({
      checkpoint: checkpoint("c2", {
        details: { contextTokens: 4096, systemMessageJson: "{}" },
      }),
      checkpoints: [first],
      sessionId: "s1",
      handoffMessageCount: 2,
      publishedAt: "2026-01-01T00:00:02.000Z",
    });

    expect(linked.details).toMatchObject({
      contextTokens: 4096,
      systemMessageJson: "{}",
      [COMPACTION_BRANCH_DETAILS_KEY]: { parentCheckpointId: "c1" },
    });
    // The input record is never mutated.
    expect(checkpoint("c2").details).toBeUndefined();
  });

  it("refuses an empty handoff instead of publishing a branch with no messages", () => {
    expect(() =>
      publishCompressionBranch({
        checkpoint: checkpoint("c1"),
        checkpoints: [],
        sessionId: "s1",
        handoffMessageCount: 0,
      }),
    ).toThrowError(CompressionBranchRefusedError);
    expect(() =>
      publishCompressionBranch({
        checkpoint: checkpoint("c1"),
        checkpoints: [],
        sessionId: "s1",
        handoffMessageCount: 0,
      }),
    ).toThrowError(/handoff must not be empty/);
  });

  it("refuses a second continuation of one boundary", () => {
    const first = publish(undefined, checkpoint("c1"), []);
    publish(first, checkpoint("c2"), []);

    // A late publication that names the already-continued boundary.
    expect(() =>
      publishCompressionBranch({
        checkpoint: checkpoint("c3"),
        checkpoints: [first, publish(first, checkpoint("c2"), [])],
        sessionId: "s1",
        handoffMessageCount: 1,
        parentCheckpointId: "c1",
      }),
    ).toThrowError(/already has a continuation/);
  });

  it("refuses a named parent that is not durable", () => {
    expect(() =>
      publishCompressionBranch({
        checkpoint: checkpoint("c2"),
        checkpoints: [publish(undefined, checkpoint("c1"), [])],
        sessionId: "s1",
        handoffMessageCount: 1,
        parentCheckpointId: "gone",
      }),
    ).toThrowError(/is not durable/);
  });

  it("refuses to continue itself", () => {
    const first = publish(undefined, checkpoint("c1"), []);
    expect(() =>
      publishCompressionBranch({
        checkpoint: first,
        checkpoints: [first],
        sessionId: "s1",
        handoffMessageCount: 1,
      }),
    ).toThrowError(/cannot continue itself/);
  });
});

describe("compressionChain", () => {
  it("walks root first through the continuation pointer", () => {
    const first = publish(undefined, checkpoint("c1"), []);
    const second = publish(first, checkpoint("c2"), []);
    const third = publishCompressionBranch({
      checkpoint: checkpoint("c3"),
      checkpoints: [first, second],
      sessionId: "s1",
      handoffMessageCount: 2,
    });

    expect(compressionChain([first, second, third])).toEqual({
      ids: ["c1", "c2", "c3"],
      truncated: false,
      cycle: false,
    });
    expect(compressionChainRoot([first, second, third])?.id).toBe("c1");
    expect(compressionBranchTip([first, second, third])?.id).toBe("c3");
    // A walk from a mid segment reaches the same tip.
    expect(compressionChain([first, second, third], { fromCheckpointId: "c2" }).ids).toEqual([
      "c2",
      "c3",
    ]);
  });

  it("treats a session whose oldest checkpoint has no link as rooted there", () => {
    const legacy = checkpoint("legacy");
    const child = publishCompressionBranch({
      checkpoint: checkpoint("c2"),
      checkpoints: [legacy],
      sessionId: "s1",
      handoffMessageCount: 1,
    });
    expect(compressionChain([legacy, child])).toMatchObject({
      ids: ["legacy", "c2"],
      truncated: false,
    });
  });

  it("stops at the cap and reports truncation", () => {
    const checkpoints: ContextCompactionRecord[] = [publish(undefined, checkpoint("c1"), [])];
    for (let index = 2; index <= 6; index += 1) {
      checkpoints.push(publish(checkpoints.at(-1), checkpoint(`c${index}`), []));
    }

    expect(compressionChain(checkpoints, { cap: 3 })).toEqual({
      ids: ["c1", "c2", "c3"],
      truncated: true,
      cycle: false,
    });
  });

  it("breaks a cycle instead of looping", () => {
    const link = (parentCheckpointId: string) => ({
      details: {
        [COMPACTION_BRANCH_DETAILS_KEY]: {
          sessionId: "s1",
          parentCheckpointId,
          kind: "compression",
          publishedAt: "2026-01-01T00:00:00.000Z",
          handoffMessageCount: 1,
        },
      },
    });
    const loop = compressionChain([
      checkpoint("c1", link("c2")),
      checkpoint("c2", link("c1")),
    ]);
    expect(loop).toEqual({ ids: ["c1", "c2"], truncated: false, cycle: true });
  });
});

describe("returnToParentCheckpoint", () => {
  it("hands back the boundary the current checkpoint continues", () => {
    const first = publish(undefined, checkpoint("c1"), []);
    const second = publish(first, checkpoint("c2"), []);

    expect(returnToParentCheckpoint([first, second], second)).toEqual({
      kind: "returned",
      checkpoint: first,
    });
  });

  it("refuses when there is no parent to return to", () => {
    const first = publish(undefined, checkpoint("c1"), []);
    expect(returnToParentCheckpoint([first], first)).toEqual({
      kind: "refused",
      reason: "no_branch",
    });
    const orphan = publishCompressionBranch({
      checkpoint: checkpoint("c2"),
      checkpoints: [first],
      sessionId: "s1",
      handoffMessageCount: 1,
    });
    expect(returnToParentCheckpoint([orphan], orphan)).toEqual({
      kind: "refused",
      reason: "parent_missing",
    });
  });
});

describe("reopenOrphanedCompressionSession", () => {
  const parent = publish(undefined, checkpoint("c1"), []);

  it("reopens a boundary whose handoff never published a child", () => {
    const registry = new CompressionHandoffRegistry();
    registry.begin({ sessionId: "s1", parentCheckpointId: "c1", startedAt: 1_000 });

    expect(
      reopenOrphanedCompressionSession({
        handoff: registry.peek("s1"),
        checkpoints: [parent],
        at: 1_500,
      }),
    ).toEqual({ reopen: true, reason: "orphaned_handoff", checkpoint: parent });
  });

  it("refuses when no handoff is open", () => {
    expect(
      reopenOrphanedCompressionSession({ checkpoints: [parent], at: 1_500 }),
    ).toEqual({ reopen: false, reason: "no_handoff" });
  });

  it("refuses once the handoff published its continuation", () => {
    const registry = new CompressionHandoffRegistry();
    registry.begin({ sessionId: "s1", parentCheckpointId: "c1", startedAt: 1_000 });
    const child = publishCompressionBranch({
      checkpoint: checkpoint("c2"),
      checkpoints: [parent],
      sessionId: "s1",
      handoffMessageCount: 2,
    });

    expect(
      reopenOrphanedCompressionSession({
        handoff: registry.peek("s1"),
        checkpoints: [parent, child],
        at: 1_100,
      }),
    ).toEqual({ reopen: false, reason: "continuation_published" });
    // Settling the handoff is what a successful publication does.
    expect(registry.settle("s1")).toBe(true);
    expect(registry.settle("s1")).toBe(false);
  });

  it("refuses an attempt past its lease", () => {
    const registry = new CompressionHandoffRegistry();
    registry.begin({ sessionId: "s1", parentCheckpointId: "c1", startedAt: 1_000 });

    expect(
      reopenOrphanedCompressionSession({
        handoff: registry.peek("s1"),
        checkpoints: [parent],
        at: 400_000,
        leaseMs: 300_000,
      }),
    ).toEqual({ reopen: false, reason: "handoff_too_old" });
  });
});
