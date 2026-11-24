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
  const cases: Array<[string, Partial<SmartTurnSignals>, string]> = [
    ["an explicit tier outranks every rule", { override: "sub", prompt: "重构整个模块" }, "sub"],
    ["the first turn orients the session", { turnIndex: 0, prompt: "你好" }, "main"],
    ["attachments need a model that reads them", { attachments: 2, prompt: "这是什么" }, "main"],
    ["a staged run owns its own definition", { stagedMode: true, prompt: "继续" }, "main"],
    ["a recent escalation sticks", { stickyMain: 1, prompt: "谢谢" }, "main"],
  ];

  it.each(cases)("%s", (_label, patch, tier) => {
    expect(decideTurnTier(signals(patch)).tier).toBe(tier);
  });

  it("routes a short mechanical prompt to the cheap model", () => {
    expect(decideTurnTier(signals({ prompt: "把这段话翻译成英文：今天天气不错" }))).toEqual({
      tier: "sub",
      reason: "mechanical-intent",
    });
    expect(decideTurnTier(signals({ prompt: "谢谢，很有帮助" }))).toEqual({
      tier: "sub",
      reason: "simple-turn",
    });
  });

  it("keeps judgement, code and tool work on the strong model", () => {
    expect(decideTurnTier(signals({ prompt: "为什么这个测试会间歇失败" })).tier).toBe("main");
    expect(decideTurnTier(signals({ prompt: "看看 src/app.ts 里的实现" })).tier).toBe("main");
    expect(decideTurnTier(signals({ prompt: "```ts\nconst a = 1\n```" })).tier).toBe("main");
    expect(decideTurnTier(signals({ prompt: "跑一下测试" })).tier).toBe("main");
    expect(decideTurnTier(signals({ prompt: "x".repeat(700) })).tier).toBe("main");
    expect(decideTurnTier(signals({ prompt: "谢谢", previousTurnUsedTools: true })).tier).toBe("main");
  });

  it("stays on the strong model when the cheap half is unusable", () => {
    const decision = decideTurnTier(signals({ prompt: "谢谢", subAvailable: false }));
    expect(decision).toEqual({ tier: "main", reason: "simple-turn", downgradedFrom: "sub" });
    // An explicit override is the user's call, not the router's to overrule.
    expect(decideTurnTier(signals({ prompt: "谢谢", subAvailable: false, override: "sub" })).tier).toBe("sub");
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
    // An unset switch keeps the default; only an explicit `false` turns it off.
    expect(
      smartTemplateFromSettings({
        smartModeMainProviderId: "a",
        smartModeMainModelId: "a-1",
        smartModeSubProviderId: "b",
        smartModeSubModelId: "b-1",
      })?.policy.turnRouting,
    ).toBe(true);
  });
});
