import { describe, expect, it } from "vitest";

import {
  REVIEW_MAX_ITERATIONS,
  REVIEW_READONLY_TOOLS,
  REVIEW_TOOL_ALLOWLIST,
  SKILL_REVIEW_NO_LOOK_RETRY,
  SKILL_REVIEW_PROMPT,
  SKILL_REVIEW_TOOL_NOTE,
  REVIEW_DEFAULT_MIN_INTERVAL_SEC,
  REVIEW_DEFAULT_MIN_TOOL_CALLS,
  ReviewActionCollector,
  accrueReviewToolCalls,
  canReview,
  describeReviewAction,
  skillReviewPolicyFrom,
  reviewActionFromCall,
  reviewToolsFrom,
  summarizeReviewActions,
} from "./skill-review-run.js";

describe("SKILL_REVIEW_PROMPT", () => {
  it("carries the load-bearing shape rules", () => {
    expect(SKILL_REVIEW_PROMPT).toContain("CLASS-LEVEL skills");
    expect(SKILL_REVIEW_PROMPT).toMatch(/No PR\/issue numbers, dates, ticket IDs/);
    expect(SKILL_REVIEW_PROMPT).toMatch(/learned twice is ONE rule/);
    expect(SKILL_REVIEW_PROMPT).toMatch(/Fix the skill in place when it is wrong/);
  });

  it("keeps the do-not-capture list", () => {
    expect(SKILL_REVIEW_PROMPT).toMatch(/Negative claims about tools or features/);
    expect(SKILL_REVIEW_PROMPT).toMatch(/Unresolved failures/);
    expect(SKILL_REVIEW_PROMPT).toMatch(/capture the FIX/);
  });

  it("says 'Nothing to save.' is real but not the default", () => {
    expect(SKILL_REVIEW_PROMPT).toMatch(/'Nothing to save\.' is a real option but should NOT be the default/);
  });

  it("prefers the earliest action that fits, in order", () => {
    const order = [
      "UPDATE A CURRENTLY-LOADED SKILL",
      "UPDATE AN EXISTING UMBRELLA",
      "ADD A SUPPORT FILE",
      "CREATE A NEW CLASS-LEVEL UMBRELLA",
    ].map((needle) => SKILL_REVIEW_PROMPT.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("does not promise support directories the host cannot write", () => {
    // The host writes `references/<topic>.md` only; promising templates/scripts
    // here would have the model burn iterations on refused writes.
    expect(SKILL_REVIEW_PROMPT).not.toContain("templates/");
    expect(SKILL_REVIEW_PROMPT).not.toContain("scripts/");
  });

  it("carries no JSON protocol — that is the failure mode being replaced", () => {
    expect(SKILL_REVIEW_PROMPT).not.toContain('"ops"');
    // `decision points` / `decision table` are prose; a JSON key is not.
    expect(SKILL_REVIEW_PROMPT).not.toContain('"decision"');
    expect(SKILL_REVIEW_PROMPT).not.toContain("Return ONLY JSON");
  });
});

describe("the review tool surface", () => {
  it("names its allowlist in the prompt instead of letting the model guess", () => {
    for (const tool of REVIEW_TOOL_ALLOWLIST) {
      expect(SKILL_REVIEW_TOOL_NOTE).toContain(tool);
    }
    expect(REVIEW_TOOL_ALLOWLIST).toContain("skill_manage");
    expect(REVIEW_TOOL_ALLOWLIST).toContain("Skill");
    expect(REVIEW_TOOL_ALLOWLIST).toContain("memory");
  });

  it("keeps read-only inspection available", () => {
    for (const tool of REVIEW_READONLY_TOOLS) expect(REVIEW_TOOL_ALLOWLIST).toContain(tool);
    // Tool names are capitalized in this app: `Skill`, `Read`, `Grep`, `Glob`.
    expect(REVIEW_READONLY_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });

  it("bounds the loop", () => {
    expect(REVIEW_MAX_ITERATIONS).toBeGreaterThan(1);
    expect(REVIEW_MAX_ITERATIONS).toBeLessThanOrEqual(32);
  });
});

describe("reviewActionFromCall", () => {
  it("maps each write action to what a person would call it", () => {
    expect(reviewActionFromCall("skill_manage", { action: "create", name: "loadbox-triage" })).toEqual({
      kind: "created",
      subject: "loadbox-triage",
    });
    expect(reviewActionFromCall("skill_manage", { action: "patch", name: "loadbox-triage" })).toEqual({
      kind: "patched",
      subject: "loadbox-triage",
    });
    expect(
      reviewActionFromCall("skill_manage", {
        action: "write_file",
        name: "loadbox-triage",
        file_path: "references/relay-bounds.md",
      }),
    ).toEqual({ kind: "wrote", subject: "loadbox-triage", file: "references/relay-bounds.md" });
    expect(
      reviewActionFromCall("skill_manage", {
        action: "remove_file",
        name: "loadbox-triage",
        file_path: "references/old.md",
      }),
    ).toEqual({ kind: "removed", subject: "loadbox-triage", file: "references/old.md" });
  });

  it("counts a memory write, never a memory read", () => {
    expect(reviewActionFromCall("memory", { target: "user", content: "prefers terse" })).toEqual({
      kind: "memory",
      subject: "user",
    });
    expect(reviewActionFromCall("memory", { target: "memory" })).toBeUndefined();
    expect(reviewActionFromCall("memory", {})).toBeUndefined();
  });

  it("ignores reads and anything it cannot name", () => {
    expect(reviewActionFromCall("Skill", { name: "loadbox-triage" })).toBeUndefined();
    expect(reviewActionFromCall("read", { path: "x.md" })).toBeUndefined();
    expect(reviewActionFromCall("skill_manage", { action: "write_file", name: "x" })).toBeUndefined();
    expect(reviewActionFromCall("skill_manage", { action: "create" })).toBeUndefined();
  });
});

describe("summarizeReviewActions", () => {
  const tool = (over: Record<string, unknown>) => ({ role: "tool", ...over });

  it("reports what the fork did, once", () => {
    const actions = summarizeReviewActions([
      tool({
        toolName: "Skill",
        toolCallId: "read-1",
        args: { name: "loadbox-triage" },
      }),
      tool({
        toolName: "skill_manage",
        toolCallId: "w-1",
        args: { action: "patch", name: "loadbox-triage" },
      }),
      tool({
        toolName: "skill_manage",
        toolCallId: "w-2",
        args: { action: "patch", name: "loadbox-triage" },
      }),
    ]);
    expect(actions).toHaveLength(1);
    expect(describeReviewAction(actions[0])).toBe("patched 'loadbox-triage'");
  });

  it("skips writes that were already in the replayed transcript", () => {
    // The fork inherits the conversation; unfiltered, it re-reports the parent's
    // own earlier writes as if the review had just made them.
    const actions = summarizeReviewActions(
      [
        tool({ toolName: "skill_manage", toolCallId: "old-1", args: { action: "create", name: "old" } }),
        tool({ toolName: "skill_manage", toolCallId: "new-1", args: { action: "create", name: "fresh" } }),
      ],
      new Set(["old-1"]),
    );
    expect(actions.map(describeReviewAction)).toEqual(["created 'fresh'"]);
  });

  it("skips failed calls and non-tool messages", () => {
    const actions = summarizeReviewActions([
      { role: "assistant", toolName: "skill_manage", args: { action: "create", name: "nope" } },
      tool({ toolName: "skill_manage", toolCallId: "e-1", args: { action: "create", name: "failed" }, isError: true }),
      tool({ toolName: "skill_manage", toolCallId: "ok-1", args: { action: "create", name: "landed" } }),
    ]);
    expect(actions.map(describeReviewAction)).toEqual(["created 'landed'"]);
  });

  it("names the file for support-file actions", () => {
    const actions = summarizeReviewActions([
      tool({
        toolName: "skill_manage",
        toolCallId: "f-1",
        args: { action: "write_file", name: "loadbox-triage", file_path: "references/relay.md" },
      }),
    ]);
    expect(describeReviewAction(actions[0])).toBe("wrote 'loadbox-triage/references/relay.md'");
  });
});

describe("reviewToolsFrom", () => {
  const declared = [
    { name: "Read" },
    { name: "Bash" },
    { name: "Write" },
    { name: "Skill" },
    { name: "skill_manage" },
    { name: "memory" },
    { name: "Grep" },
    { name: "Glob" },
    { name: "TodoWrite" },
    { name: "BrowserPreview" },
  ];

  it("keeps the allowlist and drops everything that could touch the workspace", () => {
    const names = reviewToolsFrom(declared).map((tool) => tool.name);
    expect(names).toEqual(["Read", "Skill", "skill_manage", "memory", "Grep", "Glob"]);
    expect(names).not.toContain("Write");
    expect(names).not.toContain("Bash");
    expect(names).not.toContain("BrowserPreview");
  });

  it("keeps the tool objects themselves, so the write path is the session's", () => {
    const tools = reviewToolsFrom(declared);
    expect(tools[1]).toBe(declared[3]);
  });

  it("passes read-only tools through, and says a review could not write in that session", () => {
    const readOnly = reviewToolsFrom([{ name: "Read" }, { name: "Grep" }]);
    expect(readOnly.map((tool) => tool.name)).toEqual(["Read", "Grep"]);
    // Plan and Goal sessions declare no `skill_manage`, so the trigger skips
    // instead of paying for a fork that cannot land a change.
    expect(canReview(readOnly)).toBe(false);
    expect(canReview([{ name: "Read" }, { name: "Skill" }])).toBe(false);
    expect(canReview(reviewToolsFrom(declared))).toBe(true);
  });
});

describe("skillReviewPolicyFrom", () => {
  it("is on by default, with the review's own gates", () => {
    expect(skillReviewPolicyFrom()).toEqual({
      enabled: true,
      afterToolCalls: REVIEW_DEFAULT_MIN_TOOL_CALLS,
      minIntervalSec: REVIEW_DEFAULT_MIN_INTERVAL_SEC,
      showQuietPasses: false,
    });
  });

  it("reports the quiet passes only when the reader asks for them", () => {
    // A pass that found nothing is the normal answer, so it is off unless the
    // reader turned that one key on — the same silence Hermes keeps.
    expect(skillReviewPolicyFrom().showQuietPasses).toBe(false);
    expect(skillReviewPolicyFrom({ skillReviewShowQuietPasses: true }).showQuietPasses).toBe(true);
    expect(skillReviewPolicyFrom({ skillReviewShowQuietPasses: false }).showQuietPasses).toBe(false);
    // Only an explicit boolean true turns them on; anything else stays silent.
    expect(skillReviewPolicyFrom({ skillReviewShowQuietPasses: "true" }).showQuietPasses).toBe(false);
    expect(skillReviewPolicyFrom({ skillReviewShowQuietPasses: null }).showQuietPasses).toBe(false);
  });

  it("turns off only on an explicit false", () => {
    expect(skillReviewPolicyFrom({ skillReviewAfterTurn: false }).enabled).toBe(false);
    expect(skillReviewPolicyFrom({ skillReviewAfterTurn: true }).enabled).toBe(true);
  });

  it("takes overrides, and ignores values that are not usable numbers", () => {
    expect(skillReviewPolicyFrom({ skillReviewAfterToolCalls: 7, skillReviewMinIntervalSec: 30 })).toEqual({
      enabled: true,
      afterToolCalls: 7,
      minIntervalSec: 30,
      showQuietPasses: false,
    });
    for (const bad of [0, -5, Number.NaN, "10", null]) {
      const policy = skillReviewPolicyFrom({ skillReviewAfterToolCalls: bad });
      expect(policy.afterToolCalls).toBe(REVIEW_DEFAULT_MIN_TOOL_CALLS);
    }
  });
});

describe("accrueReviewToolCalls", () => {
  it("opens the gate on the turn that reaches the threshold", () => {
    // The first turn that meets the minimum must count itself; judging before
    // counting is what kept the review from ever firing.
    expect(accrueReviewToolCalls(0, 3, 3)).toEqual({ sinceLastReview: 3, due: true });
    expect(accrueReviewToolCalls(0, 1, 3)).toEqual({ sinceLastReview: 1, due: false });
  });

  it("carries short turns forward until they add up", () => {
    let total = 0;
    for (const turn of [1, 1, 1]) total = accrueReviewToolCalls(total, turn, 3).sinceLastReview;
    expect(total).toBe(3);
    expect(accrueReviewToolCalls(total, 0, 3).due).toBe(true);
  });

  it("counts a turn with no tool calls as nothing added", () => {
    expect(accrueReviewToolCalls(5, 0, 3)).toEqual({ sinceLastReview: 5, due: true });
  });
});

describe("the review cannot skip without looking", () => {
  it("opens the prompt by requiring a library read", () => {
    const opening = SKILL_REVIEW_PROMPT.split("\n\n")[0];
    expect(opening.startsWith("Before anything else")).toBe(true);
    expect(opening).toContain("`Skill`");
    expect(opening).toMatch(/read first/i);
  });

  it("sends one correction that names the read it skipped", () => {
    expect(SKILL_REVIEW_NO_LOOK_RETRY).toContain("without calling any tool");
    expect(SKILL_REVIEW_NO_LOOK_RETRY).toContain("`Skill`");
  });

  it("counts completed tool calls, so a lookless answer is detectable", () => {
    const collector = new ReviewActionCollector();
    expect(collector.toolCallCount()).toBe(0);
    collector.record({ type: "tool_start", toolCallId: "a", toolName: "Skill" });
    expect(collector.toolCallCount()).toBe(0);
    collector.record({ type: "tool_end", toolCallId: "a" });
    expect(collector.toolCallCount()).toBe(1);
  });
});
