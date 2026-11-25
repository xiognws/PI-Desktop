import { describe, expect, it } from "vitest";

import {
  REPEAT_ALLOWANCE,
  RepeatedToolCallGuard,
  toolCallSignature,
} from "./repeated-tool-call.js";

/**
 * Measured case: `Grep` with byte-identical arguments ran 22 times for the same
 * `count: 0`, in batches where two copies were dispatched 20-50ms apart. These
 * tests pin both shapes: duplicates inside one batch, and repeats across turns.
 */
const CHANGAN = { path: "gateway/logs/route-2026-11-18.jsonl", pattern: '"provider":"changan"' };

describe("repeated tool calls", () => {
  it("treats argument order as the same call", () => {
    const left = toolCallSignature("Grep", { path: "a.log", pattern: "x", headLimit: 20 });
    const right = toolCallSignature("Grep", { headLimit: 20, pattern: "x", path: "a.log" });
    expect(left).toBe(right);
  });

  it("keeps a different pattern, path or limit a different call", () => {
    const base = toolCallSignature("Grep", { path: "a.log", pattern: "x" });
    expect(toolCallSignature("Grep", { path: "a.log", pattern: "y" })).not.toBe(base);
    expect(toolCallSignature("Grep", { path: "b.log", pattern: "x" })).not.toBe(base);
    expect(toolCallSignature("Grep", { path: "a.log", pattern: "x", headLimit: 30 })).not.toBe(base);
    expect(toolCallSignature("Read", { path: "a.log", pattern: "x" })).not.toBe(base);
  });

  it("skips the second copy inside one parallel batch", () => {
    const guard = new RepeatedToolCallGuard();

    // A parallel batch reserves every call before any result exists.
    expect(guard.reserve("Grep", CHANGAN).kind).toBe("first");
    const twin = guard.reserve("Grep", CHANGAN);
    expect(twin.kind).toBe("duplicate");
    if (twin.kind !== "duplicate") throw new Error("unreachable");
    expect(twin.reason).toBe("in-flight");
    expect(twin.notice).toMatch(/already running/);

    guard.record("Grep", CHANGAN, { count: 0, matches: [] });
  });

  it("executes the first call, answers the second from cache, refuses the third", () => {
    const guard = new RepeatedToolCallGuard();

    expect(guard.reserve("Grep", CHANGAN).kind).toBe("first");
    guard.record("Grep", CHANGAN, { count: 0, matches: [] });

    const second = guard.reserve("Grep", CHANGAN);
    expect(second.kind).toBe("duplicate");
    if (second.kind !== "duplicate" || second.reason !== "answered") {
      throw new Error("expected the cached answer");
    }
    expect(second.previous).toContain('"count":0');
    expect(second.notice).toMatch(/already ran once/);

    expect(guard.reserve("Grep", CHANGAN).kind).toBe("refused");
  });

  it("lets a released call run again, because it never produced an answer", () => {
    const guard = new RepeatedToolCallGuard();
    expect(guard.reserve("Bash", { command: "make" }).kind).toBe("first");
    // Cancelled, or the user aborted: nothing was learned.
    guard.release("Bash", { command: "make" });
    expect(guard.reserve("Bash", { command: "make" }).kind).toBe("first");
  });

  it("blocks a duplicate that arrives while the first copy is still in flight", () => {
    const guard = new RepeatedToolCallGuard();
    expect(guard.reserve("Read", { path: "f.ts" }).kind).toBe("first");
    const second = guard.reserve("Read", { path: "f.ts" });
    if (second.kind !== "duplicate") throw new Error("expected a duplicate");
    expect(second.reason).toBe("in-flight");
  });

  it("keeps the first answer even if a later run reports a different one", () => {
    const guard = new RepeatedToolCallGuard();
    guard.reserve("Read", { path: "f.ts" });
    guard.record("Read", { path: "f.ts" }, "first answer");
    // A caller that executes the duplicate anyway must not be able to replace the
    // cached answer: the point is that repeats keep looking identical.
    guard.record("Read", { path: "f.ts" }, "something else");
    const verdict = guard.reserve("Read", { path: "f.ts" });
    expect(verdict.kind).toBe("refused");
    expect("previous" in verdict ? verdict.previous : "").toBe("first answer");
  });

  it("forgets everything on reset, so a new context may ask again", () => {
    const guard = new RepeatedToolCallGuard();
    guard.record("Grep", { pattern: "x" }, "gone");
    expect(guard.size()).toBe(1);
    guard.reset();
    expect(guard.reserve("Grep", { pattern: "x" }).kind).toBe("first");
  });

  it("allows exactly one execution per signature", () => {
    expect(REPEAT_ALLOWANCE).toBe(1);
  });
});
