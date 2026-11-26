/**
 * Smart mode: one conversation served by a pair of models instead of one.
 *
 * The main model keeps the conversation — planning, hard reasoning, the answer a
 * person reads. The sub model is the cheaper one: mechanical turns run on it,
 * and mechanical work inside a main turn is delegated to it. Two rules make that
 * a token saving rather than a coin flip, and both live here because both the
 * renderer and Electron main have to agree on them:
 *
 * - **Routing is deterministic.** No classifier call, no extra request: the
 *   signals that decide a tier are the ones already in hand before dispatch
 *   (prompt text, attachments, staged mode, session history). A turn that costs
 *   nothing to classify is the only kind of classification that can pay for
 *   itself.
 * - **Cheap first, escalate on evidence.** A turn starts on the sub model only
 *   when the signals say it is mechanical; the kernel escalates it to the main
 *   model when the work itself proves otherwise (tool errors, budget). The
 *   escalation reuses the transcript, so nothing is paid for twice except one
 *   re-send to the stronger model.
 *
 * Everything in this module is pure: no storage, no provider access, no I/O.
 * Electron main owns credential resolution and the kernel owns the in-turn
 * escalation; this module only says *which tier* and *why*.
 */

/** One provider/model binding, spelled the way every other model surface does. */
export type SmartBinding = {
  providerId: string;
  modelId: string;
};

/** Which model serves the turn. `main` is the strong one, `sub` the cheap one. */
export type SmartTier = "main" | "sub";

/**
 * Why a turn landed on its tier. Stable strings: they are logged, shown in the
 * transcript's routing notice and counted in the token report, so renaming one
 * is a data migration rather than a refactor.
 */
export type SmartRouteReason =
  /**
   * The turn stays on the main model: no snapshot, or turn routing disabled.
   * The name predates the supervisor/worker split and is kept because these
   * strings are logged and counted.
   */
  | "smart-off"
  /** The user named the tier for this turn. */
  | "user-override"
  /** Attachments need a model that can read them, and the pair does not guarantee it. */
  | "attachments"
  /** A staged plan/goal run: the run's own definition decides, not the router. */
  | "staged-mode"
  /** The first turn of a session is usually an instruction, not a hard task. */
  | "first-turn"
  /** A recent turn escalated, so the next one starts strong. */
  | "sticky-main"
  /** The sub binding cannot be resolved (missing key, disabled provider). */
  | "sub-unavailable"
  /** The prompt is longer than a mechanical turn is expected to be. */
  | "long-prompt"
  /** Code, a stack trace or a file path: the strong model reads it. */
  | "code-prompt"
  /** Words that ask for judgement rather than transformation. */
  | "heavy-intent"
  /** Words that ask for a mechanical transformation, with no tool intent. */
  | "mechanical-intent"
  /** Words that will need tools; a small model can run them, and escalate if stuck. */
  | "tool-intent"
  /** The previous turn used tools, so this one continues that work. */
  | "tool-followup"
  /** Short, no tool intent, and the previous turn needed no tools either. */
  | "simple-turn"
  /** Nothing argued for the cheap model, so quality wins. */
  | "default-main";

/** Turn-level policy. Every field has a default; the renderer edits a copy. */
export type SmartModePolicy = {
  /**
   * Route whole turns to the sub model. Off — the default — keeps every turn on
   * the main model, which supervises and delegates the execution to the sub
   * model through `Task`. Switching it on hands entire turns to the cheap model
   * instead: a cost experiment, not the intended shape, because nothing
   * supervises a cheap turn that stalls.
   */
  turnRouting: boolean;
  /** Consecutive tool failures inside a sub turn that escalate it. */
  escalateAfterToolErrors: number;
  /** Fraction of the step budget (0–1) after which a sub turn escalates. */
  escalateAfterBudgetUsed: number;
  /** Turns held on the main model after an escalation. */
  stickyMainTurns: number;
  /** Character count above which a prompt is never a "simple turn". */
  simplePromptChars: number;
  /**
   * Character count above which the turn goes to the strong model no matter what
   * the words say. Separate from `simplePromptChars` because length alone is not
   * difficulty: a two-line prompt that asks for a 300-line file is the hard case,
   * and a long paste that says "summarize" is not.
   */
  mainPromptChars: number;
  /** `Task` without `model` runs the delegate on the sub model. */
  delegateToSub: boolean;
};

/**
 * The pair is a supervisor and a worker, not two turn routers.
 *
 * The main model owns every turn: it holds the plan, makes the calls that need
 * judgement or deep reasoning, and supervises the rest. The work itself —
 * searching, reading, running commands, editing — goes to the sub model through
 * `Task`, and every report comes back to the main model for review. That is what
 * `delegateToSub` configures, and it is on by default.
 *
 * Routing whole turns to the cheap half is therefore off by default. It was the
 * first shape of this feature and it failed in the field: a cheap turn that
 * answered with a sentence instead of calling a tool ended the turn, nothing
 * escalated, and the strong half never saw the work it was supposed to own. The
 * switch stays for measuring that trade-off, not as a supported default.
 */
export const DEFAULT_SMART_POLICY: SmartModePolicy = {
  // On by default: a pair whose cheap half never serves a turn is just an
  // expensive single model. Turning this off is the explicit choice.
  turnRouting: true,
  escalateAfterToolErrors: 2,
  escalateAfterBudgetUsed: 0.6,
  stickyMainTurns: 1,
  simplePromptChars: 600,
  mainPromptChars: 1800,
  delegateToSub: true,
};

/**
 * A model template: the pair plus its policy, as the user saved it. Templates
 * live in app settings; a session keeps a {@link SmartModeSnapshot} instead so
 * editing a template never rewrites conversations that already exist.
 */
export type SmartModeTemplate = {
  /** Stable id, used as the session snapshot's `templateId`. */
  id: string;
  /** Display name; user-editable, defaults to the pair's own description. */
  name: string;
  main: SmartBinding;
  sub: SmartBinding;
  policy: SmartModePolicy;
};

/**
 * What a session stores. A snapshot, not a reference: the pair a conversation
 * ran on must not change because the template was edited afterwards.
 */
export type SmartModeSnapshot = {
  templateId: string;
  templateName: string;
  main: SmartBinding;
  sub: SmartBinding;
  policy: SmartModePolicy;
};

/** `providerId/modelId`, the key shape the delegation catalog already uses. */
export function smartBindingKey(binding: SmartBinding): string {
  return `${binding.providerId}/${binding.modelId}`;
}

export function sameSmartBinding(
  left: SmartBinding | null | undefined,
  right: SmartBinding | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Coerce a stored or edited policy into a usable one.
 *
 * Settings rows are user-writable and old documents predate new fields, so a
 * missing or nonsensical value must fall back to the default instead of
 * disabling routing or setting a threshold that can never be reached.
 */
export function normalizeSmartPolicy(input?: Partial<SmartModePolicy> | null): SmartModePolicy {
  const source = input ?? {};
  return {
    turnRouting: source.turnRouting ?? DEFAULT_SMART_POLICY.turnRouting,
    escalateAfterToolErrors: Math.round(
      clamp(
        finiteOr(source.escalateAfterToolErrors, DEFAULT_SMART_POLICY.escalateAfterToolErrors),
        1,
        20,
      ),
    ),
    escalateAfterBudgetUsed: clamp(
      finiteOr(source.escalateAfterBudgetUsed, DEFAULT_SMART_POLICY.escalateAfterBudgetUsed),
      0.1,
      1,
    ),
    stickyMainTurns: Math.round(
      clamp(finiteOr(source.stickyMainTurns, DEFAULT_SMART_POLICY.stickyMainTurns), 0, 10),
    ),
    simplePromptChars: Math.round(
      clamp(finiteOr(source.simplePromptChars, DEFAULT_SMART_POLICY.simplePromptChars), 80, 20000),
    ),
    mainPromptChars: Math.round(
      clamp(finiteOr(source.mainPromptChars, DEFAULT_SMART_POLICY.mainPromptChars), 200, 40000),
    ),
    delegateToSub: source.delegateToSub ?? DEFAULT_SMART_POLICY.delegateToSub,
  };
}

const isBinding = (value: unknown): value is SmartBinding =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as SmartBinding).providerId === "string" &&
  (value as SmartBinding).providerId.trim().length > 0 &&
  typeof (value as SmartBinding).modelId === "string" &&
  (value as SmartBinding).modelId.trim().length > 0;

/**
 * Build a template from untrusted input (settings JSON, a migrated snapshot).
 * Returns `null` when either half of the pair is missing: half a pair is not a
 * template, and silently inventing the other half would bill a model the user
 * never chose.
 */
export function normalizeSmartTemplate(input: unknown): SmartModeTemplate | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Partial<SmartModeTemplate>;
  if (!isBinding(raw.main) || !isBinding(raw.sub)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  return {
    id,
    name,
    main: { providerId: raw.main.providerId, modelId: raw.main.modelId },
    sub: { providerId: raw.sub.providerId, modelId: raw.sub.modelId },
    policy: normalizeSmartPolicy(raw.policy),
  };
}

/** Normalize a stored session snapshot, keeping the pair it actually ran on. */
export function normalizeSmartSnapshot(input: unknown): SmartModeSnapshot | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Partial<SmartModeSnapshot>;
  if (!isBinding(raw.main) || !isBinding(raw.sub)) return null;
  return {
    templateId: typeof raw.templateId === "string" ? raw.templateId : "",
    templateName: typeof raw.templateName === "string" ? raw.templateName : "",
    main: { providerId: raw.main.providerId, modelId: raw.main.modelId },
    sub: { providerId: raw.sub.providerId, modelId: raw.sub.modelId },
    policy: normalizeSmartPolicy(raw.policy),
  };
}

/** Freeze a template into the snapshot a session stores. */
export function snapshotFromTemplate(template: SmartModeTemplate): SmartModeSnapshot {
  return {
    templateId: template.id,
    templateName: template.name,
    main: { ...template.main },
    sub: { ...template.sub },
    policy: { ...normalizeSmartPolicy(template.policy) },
  };
}

/**
 * A pair that names the same model twice saves nothing and hides the fact that
 * nothing was configured, so it is reported instead of being silently "on".
 */
export function smartPairIsDegenerate(snapshot: SmartModeSnapshot): boolean {
  return sameSmartBinding(snapshot.main, snapshot.sub);
}

/** Everything the router is allowed to look at. All of it exists before dispatch. */
export type SmartTurnSignals = {
  /** Raw prompt text as the user typed it. */
  prompt: string;
  /** Number of attachments that reached the turn (images, documents, files). */
  attachments: number;
  /** A staged plan/goal run owns this turn's definition. */
  stagedMode: boolean;
  /** Zero-based turn index inside the session's live transcript. */
  turnIndex: number;
  /** Turns left over from a recent escalation. */
  stickyMain: number;
  /** The user named a tier for this turn. */
  override?: SmartTier;
  /** The previous turn in this session called a tool. */
  previousTurnUsedTools: boolean;
  /** The sub binding resolved to a usable provider, model and credential. */
  subAvailable: boolean;
};

export type SmartTurnDecision = {
  tier: SmartTier;
  reason: SmartRouteReason;
  /** Set when the router wanted the sub model but could not use it. */
  downgradedFrom?: SmartTier;
};

/**
 * Prompts that ask for judgement. Kept as separate tables rather than one
 * scoring function: a rule a person can read is a rule a person can overrule,
 * and every hit is reported with its reason code.
 */
const HEAVY_INTENT = [
  "refactor", "architect", "design", "debug", "root cause", "diagnose",
  "why does", "review", "optimi", "migrat", "trade-off", "tradeoff", "strategy",
  "security", "concurren",
  "重构", "架构", "设计", "排查", "定位", "为什么", "根因", "评审", "优化", "迁移",
  "权衡", "规划", "安全", "并发",
] as const;

/** Prompts that ask for a transformation with no judgement involved. */
const MECHANICAL_INTENT = [
  "translate", "summarize", "summarise", "rewrite", "reformat", "format this", "rename",
  "typo", "capitalize", "convert", "shorter", "list the", "what time", "what day",
  "翻译", "润色", "总结", "摘要", "改写", "格式化", "重命名", "改写为", "改成", "列一下",
  "列个", "缩写", "扩充", "校对", "错别字", "几点", "星期几", "多少字",
] as const;

/** Prompts that will need tools, which means the strong model is worth paying for. */
const TOOL_INTENT = [
  "run ", "test", "build", "install", "git ", "commit", "push", "grep", "search the repo",
  "open the file", "read the file", "edit", "write the file", "delete", "execute",
  "运行", "测试", "构建", "编译", "安装", "提交", "推送", "搜索", "查一下代码", "打开",
  "读取", "修改", "删除", "执行", "跑一下", "跑一下测试", "改名", "重命名", "重构一下",
] as const;

const CODE_MARKERS = ["```", "Traceback", "Exception", " at ", "\n    at ", "SELECT ", "def ", "function ", "class "] as const;

const containsAny = (haystack: string, needles: readonly string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

/** A file path with a known source extension: code, not prose. */
const FILE_PATH = /(?:^|\s)[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|h|cpp|hpp|cs|rb|php|swift|sh|ps1|sql|json|ya?ml|toml|md)\b/i;

/**
 * Decide the tier for one turn.
 *
 * Order is the design: every rule that argues for quality runs before any rule
 * that argues for cheapness, so the cheap model only ever gets a turn that
 * nothing objected to. The user's own override outranks all of it.
 */
export function decideTurnTier(
  signals: SmartTurnSignals,
  policy: SmartModePolicy = DEFAULT_SMART_POLICY,
): SmartTurnDecision {
  const useMain = (reason: SmartRouteReason): SmartTurnDecision => ({ tier: "main", reason });
  const degraded = (reason: SmartRouteReason): SmartTurnDecision =>
    signals.subAvailable ? useMain(reason) : { tier: "main", reason, downgradedFrom: "sub" };

  if (signals.override) {
    return { tier: signals.override, reason: "user-override" };
  }
  if (!policy.turnRouting) {
    return useMain("smart-off");
  }
  if (signals.attachments > 0) {
    return useMain("attachments");
  }
  if (signals.stagedMode) {
    return useMain("staged-mode");
  }
  if (signals.stickyMain > 0) {
    return useMain("sticky-main");
  }

  const prompt = signals.prompt ?? "";
  const text = prompt.toLowerCase();
  // Only a prompt too large to be a quick exchange is quality work by size alone;
  // length is not difficulty, and a cheap turn that stalls escalates by itself.
  if (prompt.length > policy.mainPromptChars) {
    return degraded("long-prompt");
  }
  if (containsAny(text, HEAVY_INTENT)) {
    return degraded("heavy-intent");
  }
  // A request to change code or run something is a *work* turn, and work turns are
  // orchestrated: the strong half plans, dispatches each package to the worker, and
  // judges the report before the next package starts. The shell, the file edits and
  // the test runs still happen on the worker, so the paid half spends a handful of
  // steps on judgement rather than the whole turn on typing — which is cheaper than
  // handing the turn to the worker unsupervised and discovering a wrong path or a
  // half-finished edit afterwards.
  if (containsAny(prompt, CODE_MARKERS) || FILE_PATH.test(prompt)) {
    return degraded("code-prompt");
  }
  if (containsAny(text, TOOL_INTENT)) {
    return degraded("tool-intent");
  }
  // Everything below starts cheap. The pair's whole point is that the strong half
  // is paid for judgement, not for running commands: a small model that gets stuck
  // escalates inside the turn, which costs one hand-over instead of a strong turn
  // up front on every mechanical request.
  if (containsAny(text, MECHANICAL_INTENT)) {
    return signals.subAvailable
      ? { tier: "sub", reason: "mechanical-intent" }
      : degraded("mechanical-intent");
  }
  if (signals.turnIndex <= 0) {
    return signals.subAvailable
      ? { tier: "sub", reason: "first-turn" }
      : degraded("first-turn");
  }
  if (signals.previousTurnUsedTools) {
    return signals.subAvailable
      ? { tier: "sub", reason: "tool-followup" }
      : degraded("tool-followup");
  }
  return signals.subAvailable
    ? { tier: "sub", reason: "simple-turn" }
    : degraded("simple-turn");
}

/** What the kernel watches inside a running turn to decide an escalation. */
export type SmartEscalationSignals = {
  /** The turn is currently running on the sub model. */
  onSub: boolean;
  /** Tool failures in a row, reset by any success. */
  consecutiveToolErrors: number;
  /** Steps spent so far. */
  steps: number;
  /** Steps this turn may spend. */
  stepBudget: number;
};

export type SmartEscalationDecision = {
  escalate: boolean;
  reason?: "tool-errors" | "budget";
};

/**
 * Whether a running sub turn should hand over to the main model.
 *
 * An escalation is not free — the main model re-reads the transcript — so it
 * takes evidence that the turn is stuck rather than one unlucky call.
 */
export function shouldEscalate(
  signals: SmartEscalationSignals,
  policy: SmartModePolicy = DEFAULT_SMART_POLICY,
): SmartEscalationDecision {
  if (!signals.onSub) return { escalate: false };
  if (signals.consecutiveToolErrors >= policy.escalateAfterToolErrors) {
    return { escalate: true, reason: "tool-errors" };
  }
  if (signals.stepBudget > 0 && signals.steps / signals.stepBudget >= policy.escalateAfterBudgetUsed) {
    return { escalate: true, reason: "budget" };
  }
  return { escalate: false };
}

/**
 * The app-wide pair, as settings store it.
 *
 * Settings are user-writable JSON, so every field is read defensively: a pair
 * with a missing or blank half is `null`, not a template with an empty model.
 */
export type SmartModeSettings = {
  smartModeMainProviderId?: string | null;
  smartModeMainModelId?: string | null;
  smartModeSubProviderId?: string | null;
  smartModeSubModelId?: string | null;
  smartModeTurnRouting?: boolean;
  smartModeDelegateToSub?: boolean;
};

const clean = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * Build the template the composer's smart entry selects.
 *
 * Returns `null` unless both halves are configured: half a pair would send a
 * turn to a model the user never picked, and a silent default is worse than no
 * smart mode at all.
 */
export function smartTemplateFromSettings(
  settings: SmartModeSettings | null | undefined,
  name = "Smart",
): SmartModeTemplate | null {
  const mainProviderId = clean(settings?.smartModeMainProviderId);
  const mainModelId = clean(settings?.smartModeMainModelId);
  const subProviderId = clean(settings?.smartModeSubProviderId);
  const subModelId = clean(settings?.smartModeSubModelId);
  if (!mainProviderId || !mainModelId || !subProviderId || !subModelId) return null;
  return {
    id: "default",
    name,
    main: { providerId: mainProviderId, modelId: mainModelId },
    sub: { providerId: subProviderId, modelId: subModelId },
    policy: normalizeSmartPolicy({
      // Unset means on: the saving is the default and the switch exists to opt out.
      turnRouting: settings?.smartModeTurnRouting ?? true,
      delegateToSub: settings?.smartModeDelegateToSub,
    }),
  };
}

/** Badge text parts for the composer and the transcript notice. */
export function smartSnapshotLabel(snapshot: SmartModeSnapshot): {
  name: string;
  main: string;
  sub: string;
} {
  const name = snapshot.templateName || snapshot.templateId;
  return {
    name,
    main: smartBindingKey(snapshot.main),
    sub: smartBindingKey(snapshot.sub),
  };
}
