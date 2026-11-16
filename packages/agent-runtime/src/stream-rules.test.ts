import { describe, expect, it } from "vitest";

import {
  createStreamRuleMatcher,
  parseStreamRules,
  renderStreamRuleReminder,
  type StreamRule,
} from "./stream-rules.js";

/*
 * Stream rules decide only *when* a rule fires. The properties that matter:
 *
 *  - matching runs over the whole assistant text of the attempt, because `^\s*import`
 *    means nothing on a chunk that starts mid-line;
 *  - a rule fires at most `maxPerTurn` times, so a retry cannot loop forever on the
 *    same mistake;
 *  - a bad rule is reported by name instead of being silently dropped, because a
 *    dropped rule looks configured and never fires.
 */

const rule = (over: Partial<StreamRule> = {}): StreamRule => ({
  id: "box-leak",
  name: "box-leak",
  pattern: "Box::leak",
  message: "Don't reach for Box::leak in production code paths.",
  ...over,
});

describe("parseStreamRules", () => {
  it("keeps a complete rule and defaults the optional fields", () => {
    const parsed = parseStreamRules([rule()]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].maxPerTurn).toBeUndefined();
    expect(parsed.rules[0].enabled).toBeUndefined();
  });

  it("names the offending rule instead of dropping it", () => {
    const missingMessage = parseStreamRules([rule({ message: "  " })]);
    expect(missingMessage.ok).toBe(false);
    if (!missingMessage.ok) expect(missingMessage.error).toMatch(/box-leak: message is required/);

    const badRegex = parseStreamRules([rule({ pattern: "(unclosed" })]);
    expect(badRegex.ok).toBe(false);
    if (!badRegex.ok) expect(badRegex.error).toMatch(/box-leak:/);

    const badFlags = parseStreamRules([rule({ flags: "x" })]);
    expect(badFlags.ok).toBe(false);
    if (!badFlags.ok) expect(badFlags.error).toMatch(/only the i, m, s, u flags/);

    const badLimit = parseStreamRules([rule({ maxPerTurn: 0 })]);
    expect(badLimit.ok).toBe(false);
    if (!badLimit.ok) expect(badLimit.error).toMatch(/maxPerTurn/);
  });

  it("rejects duplicate ids", () => {
    const parsed = parseStreamRules([rule(), rule()]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/duplicate id/);
  });
});

describe("createStreamRuleMatcher", () => {
  it("matches over the accumulated text, not the latest chunk", () => {
    const matcher = createStreamRuleMatcher([rule({ pattern: "^\\s*import\\s" })]);
    // A chunk that starts mid-line must not decide this on its own.
    expect(matcher.check("import fs from 'node:fs';\n")).toBeDefined();
  });

  it("fires once per turn by default, and respects maxPerTurn", () => {
    const matcher = createStreamRuleMatcher([
      rule(),
      rule({ id: "todo-twice", name: "todo-twice", pattern: "TODO:", maxPerTurn: 2 }),
    ]);
    expect(matcher.check("Box::leak(x)")).toBeDefined();
    expect(matcher.check("Box::leak(x) again")).toBeUndefined();
    expect(matcher.check("nothing here")).toBeUndefined();

    // maxPerTurn: 2 means the second occurrence still fires, the third does not.
    expect(matcher.check("TODO: one")).toBeDefined();
    expect(matcher.check("TODO: two")).toBeDefined();
    expect(matcher.check("TODO: three")).toBeUndefined();
    expect(matcher.activations().map((entry) => `${entry.rule.id}:${entry.count}`)).toEqual([
      "box-leak:1",
      "todo-twice:2",
    ]);
  });

  it("reset re-arms every rule for the next turn", () => {
    const matcher = createStreamRuleMatcher([rule()]);
    expect(matcher.check("Box::leak(x)")).toBeDefined();
    matcher.reset();
    expect(matcher.check("Box::leak(x)")).toBeDefined();
    expect(matcher.activations().map((entry) => entry.rule.id)).toEqual(["box-leak"]);
  });

  it("ignores disabled rules", () => {
    const matcher = createStreamRuleMatcher([rule({ enabled: false })]);
    expect(matcher.check("Box::leak(x)")).toBeUndefined();
  });

  it("a global flag does not make the next check depend on the last one", () => {
    const matcher = createStreamRuleMatcher([rule({ pattern: "leak", flags: "g", maxPerTurn: 2 })]);
    expect(matcher.check("leak one")).toBeDefined();
    expect(matcher.check("leak two")).toBeDefined();
  });
});

describe("renderStreamRuleReminder", () => {
  it("carries the rule name, its message and what matched", () => {
    const matcher = createStreamRuleMatcher([rule()]);
    const hit = matcher.check("let s: &'static str = Box::leak(x);");
    expect(hit).toBeDefined();
    const reminder = renderStreamRuleReminder(hit!);
    expect(reminder).toContain('<stream-rule name="box-leak">');
    expect(reminder).toContain("Don't reach for Box::leak");
    expect(reminder).toContain('(matched: "Box::leak")');
  });

  it("trims a huge match so the reminder stays small", () => {
    const matcher = createStreamRuleMatcher([rule({ pattern: "x+" })]);
    const hit = matcher.check("x".repeat(500));
    const reminder = renderStreamRuleReminder(hit!);
    expect(reminder.length).toBeLessThan(400);
    expect(reminder).toContain("…");
  });
});
