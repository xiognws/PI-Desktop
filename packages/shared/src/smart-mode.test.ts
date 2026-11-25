import { describe, expect, it } from "vitest";
import {
  DEFAULT_SMART_POLICY,
  decideTurnTier,
  normalizeSmartPolicy,
  normalizeSmartSnapshot,
  normalizeSmartTemplate,
  shouldEscalate,
  smartPairIsDegenerate,
  smartTemplateFromSettings,
  snapshotFromTemplate,
  type SmartModeTemplate,
  type SmartTurnSignals,
} from "./smart-mode.js";

const template: SmartModeTemplate = {
  id: "smart-default",
  name: "Smart",
  main: { providerId: "strong", modelId: "strong-1" },
  sub: { providerId: "cheap", modelId: "cheap-1" },
  policy: DEFAULT_SMART_POLICY,
};

const signals = (patch: Partial<SmartTurnSignals> = {}): SmartTurnSignals => ({
  prompt: "谢谢，很有帮助",
  attachments: 0,
  stagedMode: false,
  turnIndex: 3,
  stickyMain: 0,
  previousTurnUsedTools: false,
  subAvailable: true,
  ...patch,
});

/**
 * The turn router as an opt-in policy.
 *
 * Routing whole turns to the cheap model is no longer the default — the main
 * model supervises and delegates the execution instead — so every routing rule
 * below has to ask for the router explicitly.
 */
const ROUTING_ON = { ...DEFAULT_SMART_POLICY, turnRouting: true };
const routeTurn = (patch: Partial<SmartTurnSignals> = {}) =>
  decideTurnTier(signals(patch), ROUTING_ON);

describe("smart mode policy normalization", () => {
  it("keeps defaults for a missing policy and clamps an unreasonable one", () => {
    expect(normalizeSmartPolicy(null)).toEqual(DEFAULT_SMART_POLICY);
    const clamped = normalizeSmartPolicy({
      escalateAfterToolErrors: 0,
      escalateAfterBudgetUsed: 5,
      stickyMainTurns: -3,
      simplePromptChars: 10,
    });
    expect(clamped.escalateAfterToolErrors).toBe(1);
    expect(clamped.escalateAfterBudgetUsed).toBe(1);
    expect(clamped.stickyMainTurns).toBe(0);
    expect(clamped.simplePromptChars).toBe(80);
    expect(clamped.turnRouting).toBe(DEFAULT_SMART_POLICY.turnRouting);
    expect(clamped.delegateToSub).toBe(DEFAULT_SMART_POLICY.delegateToSub);
  });

  it("refuses half a pair instead of inventing the missing model", () => {
    expect(normalizeSmartTemplate({ id: "x", main: template.main })).toBeNull();
    expect(normalizeSmartTemplate({ id: "x", main: template.main, sub: { providerId: " " , modelId: "" } })).toBeNull();
    expect(normalizeSmartTemplate(null)).toBeNull();
    expect(normalizeSmartTemplate({ ...template, name: "" })?.name).toBe("smart-default");
  });

  it("freezes the pair into a session snapshot", () => {
    const snapshot = snapshotFromTemplate(template);
    template.sub.modelId = "mutated-later";
    expect(snapshot.sub.modelId).toBe("cheap-1");
    expect(normalizeSmartSnapshot(snapshot)).toEqual(snapshot);
    expect(smartPairIsDegenerate({ ...snapshot, sub: { ...snapshot.main } })).toBe(true);
    expect(smartPairIsDegenerate(snapshot)).toBe(false);
  });
});

describe("turn routing", () => {
  it("keeps every turn on the main model unless the router is switched on", () => {
    // The pair's default shape: the main model owns the turn and supervises,
    // `Task` on the cheap half does the execution. A whole turn only leaves the
    // main model when the user opts into routing.
    expect(DEFAULT_SMART_POLICY.turnRouting).toBe(false);
    expect(DEFAULT_SMART_POLICY.delegateToSub).toBe(true);
    expect(decideTurnTier(signals())).toEqual({ tier: "main", reason: "smart-off" });
    expect(decideTurnTier(signals({ prompt: "重构这个模块的分层" }))).toEqual({
      tier: "main",
      reason: "smart-off",
    });
  });

  const cases: Array<[string, Partial<SmartTurnSignals>, string]> = [
    ["an explicit tier outranks every rule", { override: "sub", prompt: "重构整个模块" }, "sub"],
    ["the first turn starts cheap", { turnIndex: 0, prompt: "你好" }, "sub"],
    ["attachments need a model that reads them", { attachments: 2, prompt: "这是什么" }, "main"],
    ["a staged run owns its own definition", { stagedMode: true, prompt: "继续" }, "main"],
    ["a recent escalation sticks", { stickyMain: 1, prompt: "谢谢" }, "main"],
  ];

  it.each(cases)("%s", (_label, patch, tier) => {
    expect(routeTurn(patch).tier).toBe(tier);
  });

  it("routes a short mechanical prompt to the cheap model", () => {
    expect(routeTurn({ prompt: "把这段话翻译成英文：今天天气不错" })).toEqual({
      tier: "sub",
      reason: "mechanical-intent",
    });
    expect(routeTurn({ prompt: "谢谢，很有帮助" })).toEqual({
      tier: "sub",
      reason: "simple-turn",
    });
  });

  it("keeps judgement on the strong model", () => {
    expect(routeTurn({ prompt: "为什么这个测试会间歇失败" })).toEqual({
      tier: "main",
      reason: "heavy-intent",
    });
    expect(routeTurn({ prompt: "重构这个模块的分层" }).tier).toBe("main");
    expect(routeTurn({ prompt: "design a migration for the settings store" }).tier).toBe("main");
  });

  it("starts code, tool and follow-up work on the cheap model", () => {
    // Length is not difficulty and a shell command is not judgement: these all
    // begin cheap, and a stalled turn escalates inside itself.
    expect(routeTurn({ prompt: "看看 src/app.ts 里的实现" })).toEqual({
      tier: "sub",
      reason: "code-prompt",
    });
    expect(routeTurn({ prompt: "```ts\nconst a = 1\n```" }).tier).toBe("sub");
    expect(routeTurn({ prompt: "跑一下测试" })).toEqual({
      tier: "sub",
      reason: "tool-intent",
    });
    expect(routeTurn({ prompt: "谢谢", previousTurnUsedTools: true })).toEqual({
      tier: "sub",
      reason: "tool-followup",
    });
    // The first turn is an instruction, not a hard task.
    expect(routeTurn({ prompt: "先看看仓库结构", turnIndex: 0 })).toEqual({
      tier: "sub",
      reason: "first-turn",
    });
  });

  it("pays for size only when the prompt is genuinely a big job", () => {
    expect(routeTurn({ prompt: "x".repeat(700) }).tier).toBe("sub");
    expect(routeTurn({ prompt: "x".repeat(DEFAULT_SMART_POLICY.mainPromptChars + 1) })).toEqual({
      tier: "main",
      reason: "long-prompt",
    });
  });

  it("one strong turn in five across a typical session", () => {
    // The split the pair is tuned for: judgement and oversized jobs on the strong
    // half, everything else executed cheap. Ten representative prompts.
    const prompts = [
      "先看看仓库结构",
      "跑一下测试",
      "把这段话翻译成英文：今天天气不错",
      "看看 src/app.ts 里的实现",
      "Commit 这些改动",
      "总结一下这个会话",
      "为什么会间歇失败",
      "重构 registry 的分层",
      "帮我把这个函数改名",
      "谢谢",
    ];
    const tiers = prompts.map((prompt, index) => routeTurn({ prompt, turnIndex: index }).tier);
    const main = tiers.filter((tier) => tier === "main").length;
    expect(main).toBeLessThanOrEqual(2);
  });

  it("stays on the strong model when the cheap half is unusable", () => {
    const decision = routeTurn({ prompt: "谢谢", subAvailable: false });
    expect(decision).toEqual({ tier: "main", reason: "simple-turn", downgradedFrom: "sub" });
    // An explicit override is the user's call, not the router's to overrule.
    expect(routeTurn({ prompt: "谢谢", subAvailable: false, override: "sub" }).tier).toBe("sub");
  });

  it("turns routing off without turning smart mode off", () => {
    const decision = decideTurnTier(signals(), { ...DEFAULT_SMART_POLICY, turnRouting: false });
    expect(decision).toEqual({ tier: "main", reason: "smart-off" });
  });
});

describe("in-turn escalation", () => {
  it("only escalates a turn that is actually running cheap", () => {
    expect(shouldEscalate({ onSub: false, consecutiveToolErrors: 9, steps: 99, stepBudget: 100 }))
      .toEqual({ escalate: false });
  });

  it("waits for evidence: repeated tool failures or a spent budget", () => {
    expect(shouldEscalate({ onSub: true, consecutiveToolErrors: 1, steps: 1, stepBudget: 100 }))
      .toEqual({ escalate: false });
    expect(shouldEscalate({ onSub: true, consecutiveToolErrors: 2, steps: 1, stepBudget: 100 }))
      .toEqual({ escalate: true, reason: "tool-errors" });
    expect(shouldEscalate({ onSub: true, consecutiveToolErrors: 0, steps: 60, stepBudget: 100 }))
      .toEqual({ escalate: true, reason: "budget" });
    // A turn with no declared budget never escalates on a ratio it cannot compute.
    expect(shouldEscalate({ onSub: true, consecutiveToolErrors: 0, steps: 90, stepBudget: 0 }))
      .toEqual({ escalate: false });
  });
});

describe("the app-wide pair", () => {
  it("needs both halves, and reads settings defensively", () => {
    expect(smartTemplateFromSettings(null)).toBeNull();
    expect(
      smartTemplateFromSettings({
        smartModeMainProviderId: "strong",
        smartModeMainModelId: "strong-1",
        smartModeSubProviderId: "cheap",
        smartModeSubModelId: "  ",
      }),
    ).toBeNull();
  });

  it("builds a frozen pair whose policy follows the two switches", () => {
    const template = smartTemplateFromSettings({
      smartModeMainProviderId: " strong ",
      smartModeMainModelId: "strong-1",
      smartModeSubProviderId: "cheap",
      smartModeSubModelId: "cheap-1",
      smartModeTurnRouting: false,
      smartModeDelegateToSub: false,
    });
    expect(template?.main).toEqual({ providerId: "strong", modelId: "strong-1" });
    expect(template?.policy.turnRouting).toBe(false);
    expect(template?.policy.delegateToSub).toBe(false);
    // An unset switch keeps the default: routing off, delegation on.
    const fromSettings = smartTemplateFromSettings({
      smartModeMainProviderId: "a",
      smartModeMainModelId: "a-1",
      smartModeSubProviderId: "b",
      smartModeSubModelId: "b-1",
    });
    expect(fromSettings?.policy.turnRouting).toBe(false);
    expect(fromSettings?.policy.delegateToSub).toBe(true);
  });
});
