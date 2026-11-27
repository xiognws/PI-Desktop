import { describe, expect, it } from "vitest";
import { WORK_TURN_STEPS,
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
  it("routes by default: the cheap half serves the turn unless the user opts out", () => {
    // Saving tokens is the default, not an option to discover: a pair whose cheap
    // half never serves a turn is just an expensive single model. Turning routing
    // off is the explicit choice, and it is asserted below.
    expect(DEFAULT_SMART_POLICY.turnRouting).toBe(true);
    expect(DEFAULT_SMART_POLICY.delegateToSub).toBe(true);
    expect(decideTurnTier(signals())).toEqual({ tier: "sub", reason: "simple-turn" });
    expect(decideTurnTier(signals({ prompt: "重构这个模块的分层" }))).toEqual({
      tier: "main",
      reason: "heavy-intent",
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

  it("orchestrates code and tool work on the strong model", () => {
    // A work turn is dispatched and judged, not typed by the paid half: the strong
    // model plans, hands each package to the worker, and verifies the report. That
    // keeps the shell, the edits and the test runs on the free half while the paid
    // half spends a few steps on judgement instead of the whole turn on typing.
    expect(routeTurn({ prompt: "看看 src/app.ts 里的实现" })).toEqual({
      tier: "main",
      reason: "code-prompt",
    });
    expect(routeTurn({ prompt: "```ts\nconst a = 1\n```" }).tier).toBe("main");
    expect(routeTurn({ prompt: "跑一下测试" })).toEqual({
      tier: "main",
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

  it("supervises the turn after a long one, however short the prompt is", () => {
    // The live case: "继续会话…" started a 758-step, 135-tool-error turn on the cheap
    // half. Words cannot see that; the previous turn's step count can.
    expect(routeTurn({ prompt: "继续", previousTurnSteps: WORK_TURN_STEPS })).toEqual({
      tier: "main",
      reason: "work-followup",
    });
    // One call short of the threshold is still a follow-up, not work.
    expect(routeTurn({ prompt: "继续", previousTurnSteps: WORK_TURN_STEPS - 1 })).toEqual({
      tier: "sub",
      reason: "simple-turn",
    });
    // An unusable cheap half must say so rather than claim it routed there.
    expect(
      decideTurnTier(signals({ prompt: "继续", previousTurnSteps: WORK_TURN_STEPS, subAvailable: false }), ROUTING_ON),
    ).toEqual({ tier: "main", reason: "work-followup", downgradedFrom: "sub" });
  });

  it("pays for size only when the prompt is genuinely a big job", () => {
    expect(routeTurn({ prompt: "x".repeat(700) }).tier).toBe("sub");
    expect(routeTurn({ prompt: "x".repeat(DEFAULT_SMART_POLICY.mainPromptChars + 1) })).toEqual({
      tier: "main",
      reason: "long-prompt",
    });
  });

  it("pays for orchestration on work turns and nothing on conversation", () => {
    // The split the pair is tuned for: a turn that changes the workspace is
    // *dispatched* by the strong half (plan, hand a package to the worker, judge the
    // report), while a turn that only talks stays free. The paid half therefore does
    // a few steps of judgement per work turn instead of the whole turn of typing.
    const work = [
      "跑一下测试",
      "看看 src/app.ts 里的实现",
      "Commit 这些改动",
      "为什么会间歇失败",
      "重构 registry 的分层",
      "帮我把这个函数改名",
    ];
    for (const prompt of work) {
      const decision = routeTurn({ prompt, turnIndex: 2 });
      expect({ prompt, tier: decision.tier }).toEqual({ prompt, tier: "main" });
    }
    const conversation = [
      "先看看仓库结构",
      "把这段话翻译成英文：今天天气不错",
      "总结一下这个会话",
      "谢谢",
    ];
    for (const prompt of conversation) {
      const decision = routeTurn({ prompt, turnIndex: 2 });
      expect({ prompt, tier: decision.tier }).toEqual({ prompt, tier: "sub" });
    }
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

  it("stops a turn whose failures are spread out, or that simply runs too long", () => {
    // 135 failures, none of them in a row: the consecutive trigger never fired on the
    // live turn. Total failures and an absolute step ceiling are what can fire.
    expect(
      shouldEscalate({ onSub: true, consecutiveToolErrors: 1, totalToolErrors: 8, steps: 3, stepBudget: 0 }),
    ).toEqual({ escalate: true, reason: "tool-errors-total" });
    expect(
      shouldEscalate({ onSub: true, consecutiveToolErrors: 0, totalToolErrors: 1, steps: 120, stepBudget: 0 }),
    ).toEqual({ escalate: true, reason: "steps" });
    // Under both limits the turn keeps its cheap attempt.
    expect(
      shouldEscalate({ onSub: true, consecutiveToolErrors: 1, totalToolErrors: 7, steps: 119, stepBudget: 0 }),
    ).toEqual({ escalate: false });
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
    // An explicit `false` is honoured; only an unset switch takes the default.
    const fromSettings = smartTemplateFromSettings({
      smartModeMainProviderId: "a",
      smartModeMainModelId: "a-1",
      smartModeSubProviderId: "b",
      smartModeSubModelId: "b-1",
    });
    // Unset switches keep the defaults: routing on, delegation on.
    expect(fromSettings?.policy.turnRouting).toBe(true);
    expect(fromSettings?.policy.delegateToSub).toBe(true);
  });
});
