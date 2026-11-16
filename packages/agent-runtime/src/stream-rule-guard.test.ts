import { describe, expect, it, vi } from "vitest";

import { MAX_RULE_RETRIES, StreamRuleGuard, assistantTextOf } from "./stream-rule-guard.js";
import type { StreamRule } from "./stream-rules.js";

/*
 * The guard owns what the loop does when a rule fires. What must hold:
 *
 *  - the stream is aborted exactly once per firing, before the reminder is used;
 *  - a rule fires once per attempt, so the same text arriving in several deltas
 *    does not abort three times;
 *  - the retry budget is per turn and cannot be reset by an attempt boundary, or a
 *    model that keeps tripping the rule would loop forever.
 */

const rule = (over: Partial<StreamRule> = {}): StreamRule => ({
  id: "box-leak",
  name: "box-leak",
  pattern: "Box::leak",
  message: "Don't reach for Box::leak in production code paths.",
  ...over,
});

describe("StreamRuleGuard.observe", () => {
  it("aborts once and returns the reminder for a firing", () => {
    const abort = vi.fn();
    const guard = new StreamRuleGuard({ rules: [rule()], abort });

    const fire = guard.observe("let s = Box::leak(x);");
    expect(fire).toBeDefined();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(fire!.reminder).toContain("Box::leak");
    expect(fire!.attempt).toBe(1);
  });

  it("does not abort again when the same rule matches a later delta", () => {
    const abort = vi.fn();
    const guard = new StreamRuleGuard({ rules: [rule()], abort });
    expect(guard.observe("Box::leak(x)")).toBeDefined();
    expect(guard.observe("Box::leak(x) and more")).toBeUndefined();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("leaves clean text alone", () => {
    const abort = vi.fn();
    const guard = new StreamRuleGuard({ rules: [rule()], abort });
    expect(guard.observe("let s = String::from(x);")).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it("allows a different rule to fire on the same attempt", () => {
    const abort = vi.fn();
    const guard = new StreamRuleGuard({
      rules: [rule(), rule({ id: "todo", name: "todo", pattern: "TODO:" })],
      abort,
    });
    expect(guard.observe("Box::leak(x)")).toBeDefined();
    expect(guard.observe("Box::leak(x) TODO: later")).toBeDefined();
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it("re-arms on a new attempt but keeps the budget", () => {
    const abort = vi.fn();
    const guard = new StreamRuleGuard({ rules: [rule()], abort, maxRetries: 2 });
    expect(guard.observe("Box::leak(x)")).toBeDefined();

    guard.beginAttempt();
    expect(guard.observe("Box::leak(y)")).toBeDefined();
    expect(guard.retriesUsed).toBe(2);

    // Budget exhausted: the third attempt is allowed to finish with the mistake
    // rather than looping forever.
    guard.beginAttempt();
    expect(guard.observe("Box::leak(z)")).toBeUndefined();
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it("reset clears the budget for the next turn", () => {
    const abort = vi.fn();
    const guard = new StreamRuleGuard({ rules: [rule()], abort, maxRetries: 1 });
    expect(guard.observe("Box::leak(x)")).toBeDefined();
    guard.beginAttempt();
    expect(guard.observe("Box::leak(y)")).toBeUndefined();

    guard.reset();
    expect(guard.observe("Box::leak(z)")).toBeDefined();
    expect(guard.retriesUsed).toBe(1);
  });

  it("defaults the budget to MAX_RULE_RETRIES", () => {
    const abort = vi.fn();
    const guard = new StreamRuleGuard({ rules: [rule({ maxPerTurn: 99 })], abort });
    for (let index = 0; index < 10; index += 1) {
      guard.beginAttempt();
      guard.observe(`Box::leak(${index})`);
    }
    expect(guard.retriesUsed).toBe(MAX_RULE_RETRIES);
    expect(abort).toHaveBeenCalledTimes(MAX_RULE_RETRIES);
  });
});

describe("assistantTextOf", () => {
  it("reads a string body", () => {
    expect(assistantTextOf("hello")).toBe("hello");
  });

  it("joins text blocks and ignores tool blocks", () => {
    expect(
      assistantTextOf([
        { type: "text", text: "let s = " },
        { type: "toolCall", name: "Write" },
        { type: "text", text: "Box::leak(x);" },
      ]),
    ).toBe("let s = Box::leak(x);");
  });

  it("treats anything else as empty rather than throwing", () => {
    expect(assistantTextOf(undefined)).toBe("");
    expect(assistantTextOf({ text: "nope" })).toBe("");
  });
});
