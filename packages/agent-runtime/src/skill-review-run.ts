/**
 * The background skill review's prompt and action bookkeeping.
 *
 * Ported from Hermes' `agent/background_review.py` (`_SKILL_REVIEW_PROMPT`,
 * `_LESSON_LAYER_BLOCK`, `_DO_NOT_CAPTURE_BLOCK`, `summarize_background_review_actions`).
 *
 * The shape is the point. Hermes does not ask a model for a JSON plan of edits: it
 * forks the agent with a restricted tool set and lets it read the library and write
 * through the same validated `skill_manage` path the foreground uses. The
 * JSON-protocol review this replaces had to fit a whole reference document inside a
 * string literal; it was truncated or malformed often enough that the failure mode
 * read as "the review did nothing". A fork that *acts* has no such failure mode —
 * every write is a tool call, validated where every other write is validated.
 *
 * What is deliberately NOT ported yet, and why:
 *
 * - Nothing here: the host now accepts `templates/`, `scripts/` and `assets/`
 *   beside `references/` (ADR 0388), and the prompt below names them.
 * - The read-before-write refusal. The text asks the model to re-read before it
 *   patches (which is what makes a patch land on real spans), but it does not claim
 *   the write is *refused* otherwise: that guard is the next slice of work.
 */

import type { SubagentDefinition } from "@pi-workspace/shared";

/** Tool the review may call, and what each one is for. */
export const REVIEW_SKILL_TOOLS = ["Skill", "skill_manage"] as const;
/** Memory writes are allowed: a review that learns only a preference has nowhere else. */
export const REVIEW_MEMORY_TOOLS = ["memory"] as const;
/**
 * Read-only file tools. Denying them starves the loop: the model naturally inspects
 * a skill's references before rewriting them, and Hermes measured a denial storm
 * (~142 denials + ~204 read-before-write refusals over two days) when it did.
 */
export const REVIEW_READONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

/** Everything the review fork may call. Dispatch stays behind this list. */
export const REVIEW_TOOL_ALLOWLIST: readonly string[] = [
  ...REVIEW_SKILL_TOOLS,
  ...REVIEW_MEMORY_TOOLS,
  ...REVIEW_READONLY_TOOLS,
];

/** Iteration ceiling for one review fork (Hermes uses the same number). */
export const REVIEW_MAX_ITERATIONS = 16;

/**
 * A turn that used fewer tools than this taught nothing worth a completion.
 *
 * One, not three: measured on a live session, the turns that carried the lessons
 * worth keeping were the short ones (a preference, a pitfall, one procedure) and
 * every one of them was skipped as `too-few-tools`. The cooldown, not the tool
 * count, is what keeps the review from running on every turn — a review that
 * reads one exchange costs one small completion.
 */
export const REVIEW_DEFAULT_MIN_TOOL_CALLS = 1;
/** Floor between two reviews of the same session, in seconds. */
export const REVIEW_DEFAULT_MIN_INTERVAL_SEC = 120;

/**
 * The review policy a session launches with, read off the app settings.
 *
 * The keys are not in the typed `AppSettings` (they predate it), so they come in as
 * a record and are read with the defaults the review has always used: on, after
 * three tool calls, and at most once every two minutes. Quiet passes are off by
 * default: Hermes only ever announces a review that wrote something, and a reader
 * who wants the empty passes as well has to ask for that one key.
 */
export function skillReviewPolicyFrom(settings: Record<string, unknown> = {}): {
  enabled: boolean;
  afterToolCalls: number;
  minIntervalSec: number;
  showQuietPasses: boolean;
} {
  const positive = (key: string, fallback: number): number => {
    const value = settings[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    enabled: settings.skillReviewAfterTurn !== false,
    afterToolCalls: positive("skillReviewAfterToolCalls", REVIEW_DEFAULT_MIN_TOOL_CALLS),
    minIntervalSec: positive("skillReviewMinIntervalSec", REVIEW_DEFAULT_MIN_INTERVAL_SEC),
    showQuietPasses: settings.skillReviewShowQuietPasses === true,
  };
}

/**
 * Advance the "tool calls since the last review" counter by the turn that just
 * ended, then say whether the gate opens.
 *
 * The order is the whole function. Counting after the comparison means the first
 * turn that qualifies is measured against zero and thrown away, so a machine that
 * only ever runs one qualifying turn at a time never opens the gate — the row
 * never appears and the log blames `too-few-tools` forever.
 */
export function accrueReviewToolCalls(
  sinceLastReview: number,
  thisTurn: number,
  minToolCalls: number,
): { sinceLastReview: number; due: boolean } {
  const total = sinceLastReview + thisTurn;
  return { sinceLastReview: total, due: total >= minToolCalls };
}

/**
 * The definition the review fork runs under.
 *
 * Not a user-selectable delegate: it never appears in a `Task` catalog, it is
 * spawned by the runtime itself, and its tool list is the allowlist above.
 */
export const SKILL_REVIEW_DEFINITION: SubagentDefinition = {
  name: "skill-review",
  description: "Reviews one finished turn and updates the skill library.",
  tools: [...REVIEW_TOOL_ALLOWLIST],
  // The definition body stays empty on purpose: the review's instructions arrive as
  // the run's own user turn (`SKILL_REVIEW_PROMPT`), which is how Hermes sends them.
  prompt: "",
  // Not a user-authored delegate: the runtime spawns it, no `Task` catalog lists it.
  source: "builtin",
};

/**
 * Shape contract for anything written into a skill.
 *
 * The failure mode this prevents is the hoarding library: one `references/` file per
 * session, incident narration instead of rules, PR numbers and quotes as content,
 * and duplicating what the repo's AGENTS.md or a tool schema already teaches.
 */
const LESSON_LAYER_BLOCK = `What a skill IS: the instructions for doing a class of task the most efficient and correct way, to THIS user's specifications — the procedure, the tools and commands that work, the order, the user's preferences for how the result should look, and the pitfalls that cost time. A future session should be able to follow it and produce what the user wants on the first try. Everything below is about writing that well:
  • Procedure first: the steps in the order they are done, with the concrete commands, tool calls, and decision points. Lessons and pitfalls attach to the step they affect.
  • A pitfall is a generalizable rule + one clause of WHY (the mechanism), imperative. 'Grep the test tree for the SYMBOL before widening a helper signature — hand-rolled mocks reimplement the old shape and fail on a shard you did not run.' Not a narrative of what happened this session.
  • No PR/issue numbers, dates, ticket IDs, or quoted user text as content — the rule must stand without the incident behind it. Keep a short quote ONLY when the quote itself is the clearest statement of the rule.
  • The same lesson learned twice is ONE rule. Before adding, search the skill (and its references/) for the rule already stated; strengthen or clarify it rather than appending a second copy.
  • Not a duplicate of what the environment already teaches: repo AGENTS.md files, tool schema descriptions, and other always-loaded context. A skill carries the WORKFLOW and the pitfalls; it does not restate the codebase map or a tool's parameter list.
  • Always-on rules (standing user preferences, gates that apply to every instance of the task) live in SKILL.md itself, whole. references/ is for depth that is only needed sometimes: a decision table, a recipe, a domain note — each file topical and reusable, never '<date>-<incident>.md'. Prefer extending an existing references/ file over creating one; a skill with dozens of one-off references is the failure shape, not the goal.
  • Fix the skill in place when it is wrong: edit the sentence that misled, do not append 'UPDATE: actually...' underneath it.
`;

/** What looks like a lesson but must never harden into one. */
const DO_NOT_CAPTURE_BLOCK = ` (these become persistent self-imposed constraints that bite you later when the environment changes):
  • Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, 'command not found', unconfigured credentials, uninstalled packages. The user can fix these — they are not durable rules.
  • Negative claims about tools or features ('browser tools do not work', 'X tool is broken', 'cannot use Y from execute_code'). These harden into refusals the agent cites against itself for months after the actual problem was fixed.
  • Session-specific transient errors that resolved before the conversation ended. If retrying worked, the lesson is the retry pattern, not the original failure.
  • One-off task narratives. A user asking 'summarize today's market' or 'analyze this PR' is not a class of work that warrants a skill.

  • Unresolved failures: if the session ended WITHOUT actually finding a working method — you tried several things, none worked, and told the user to check manually — do NOT write those attempts up as a 'reliable workflow' or 'recommended approach'. That presents an untested sequence of failures as validated guidance a future session will trust and repeat. Either say 'Nothing to save', or, only if you are independently confident of a real working alternative (not something you are merely guessing might work), capture ONLY that alternative — never the dead ends, and never dressed up as best practice.

If a tool failed because of setup state, capture the FIX (install command, config step, env var to set) under an existing setup or troubleshooting skill — never 'this tool does not work' as a standalone constraint.
`;

/**
 * The review prompt. Hermes' text verbatim, with this app's tool names:
 * `Skill` loads a document, `skill_manage` writes one, `memory` records a fact
 * about the user or the environment.
 */
/**
 * What the review is told when it answered without calling a single tool.
 *
 * Repeated once, then the pass is recorded as `no-tool-calls`. Kept short on
 * purpose: it is a correction, not a second set of instructions.
 */
export const SKILL_REVIEW_NO_LOOK_RETRY =
  'You answered without calling any tool, so you have not seen what the library already covers. Call `Skill` for the most relevant candidate (or `Grep` the skills directory) now, read what comes back, then decide. If the library genuinely needs nothing, say \'Nothing to save.\' after that.';

export const SKILL_REVIEW_PROMPT = `Before anything else: look at the library. Call \`Skill\` with no arguments to list what exists, or \`Grep\` the skills directory for the topic of this session. Judging whether a lesson is already covered without reading it is the one failure this pass cannot detect from inside — so read first, then decide.

Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a SKILL.md of always-on rules and a small \`references/\` set of topical depth. Not a flat list of narrow one-session skills, and not an umbrella hoarding a references/ file per session. This shapes HOW you update, not WHETHER you update.

${LESSON_LAYER_BLOCK}
Signals to look for (any one of these warrants action):
  • User corrected your style, tone, format, legibility, or verbosity. Frustration signals like 'stop doing X', 'this is too verbose', 'don't format like this', 'why are you explaining', 'just give me the answer', 'you always do Y and I hate it', or an explicit 'remember this' are FIRST-CLASS skill signals, not just memory signals. Update the relevant skill(s) to embed the preference so the next session starts already knowing.
  • User corrected your workflow, approach, or sequence of steps. Encode the correction as a pitfall or explicit step in the skill that governs that class of task.
  • Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged that a future session would benefit from. Capture it.
  • A skill that got loaded or consulted this session turned out to be wrong, missing a step, or outdated. Patch it NOW.

Preference order — prefer the earliest action that fits, but do pick one when a signal above fired:
  1. UPDATE A CURRENTLY-LOADED SKILL. Look back through the conversation for skills the user loaded or you read with \`Skill\`. If any of them covers the territory of the new learning, PATCH that one first — re-load it with \`Skill\` during this review first (see Read-before-write below). It is the skill that was in play, so it is the right one to extend: hand-written, installed, bundled and pinned skills are all yours to improve.
  2. UPDATE AN EXISTING UMBRELLA (list the library, then \`Skill\` the candidate). If no loaded skill fits but an existing class-level skill does, patch it. Add a subsection, a pitfall, or broaden a trigger.
  3. ADD A SUPPORT FILE under an existing umbrella: \`references/<topic>.md\` — topical depth needed only sometimes: a decision table, a reproduction recipe, provider quirks, condensed domain notes. Name it by TOPIC and extend an existing file when one covers the topic; do not create a per-session or per-incident file, and do not paste error transcripts — distill them to the rule. Write it with \`skill_manage\` action \`write_file\`, and add a one-line pointer to it in the umbrella's SKILL.md so a future session knows it exists.
  4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL when no existing skill covers the class, via \`skill_manage\` action \`create\`. The name MUST be at the class level. The name MUST NOT be a specific PR number, error string, feature codename, library-alone name, or 'fix-X / debug-Y / audit-Z-today' session artifact. If the proposed name only makes sense for today's task, it is wrong — fall back to (1), (2), or (3).

Read-before-write: before you patch an existing skill's SKILL.md, load it with \`Skill\` during this review and base the patch on what \`Skill\` just returned. Before you overwrite or remove an existing supporting file, load that exact file first. Content quoted earlier in the conversation does NOT count — a patch has to match text that is really there now. Creating a brand-new skill or adding a new supporting file needs no prior read.

User-preference embedding (important): when the user expressed a style/format/workflow preference, the update belongs in the SKILL.md body, not just in memory. Memory captures 'who the user is and what the current situation and state of your operations are'; skills capture 'how to do this class of task for this user'. When they complain about how you handled a task, the skill that governs that task needs to carry the lesson.

If you notice two existing skills that overlap, you may merge them — but only when the merge is obvious from what \`Skill\` returned in THIS review. Patch the umbrella's SKILL.md so it describes what it now covers, then call \`skill_manage\` with action \`absorb\`, \`name\` set to the redundant skill and \`into\` set to the umbrella. Its resource files move under the umbrella and its document leaves the catalog while staying on disk; nothing is deleted. Say in your reply which skills you merged and why. If the overlap is partial — two documents that each carry something the other lacks — do not absorb: note it in your reply and let a person decide. Never delete a skill here.

Do NOT capture as skills${DO_NOT_CAPTURE_BLOCK}
Before you answer, check one thing: did this session contain a complete reusable PROCEDURE — a sequence the next session facing the same class of task would follow step by step? If it did and you created or patched no skill, say so explicitly in your reply and why (for example: the procedure is already covered by an existing skill, or it is not yet a procedure). A procedure that only exists as a memory entry is invisible to the next session at the moment it needs it.

'Nothing to save.' is a real option but should NOT be the default. If the session ran smoothly with no corrections and produced no new technique, just say 'Nothing to save.' and stop. Otherwise, act.`;

/** Appended by the caller so the model knows the ceiling before it plans. */
export const SKILL_REVIEW_TOOL_NOTE =
  `You can only call ${REVIEW_SKILL_TOOLS.join(", ")}, ${REVIEW_MEMORY_TOOLS.join(", ")} and ` +
  `${REVIEW_READONLY_TOOLS.join(", ")} here. Other tools are denied at runtime — do not attempt them.`;

/**
 * The review fork's tool array: the allowlisted subset of what the session itself
 * declared, in the session's own order.
 *
 * The fork receives the session's *same tool objects*, so a review's write takes
 * the path the foreground write takes — same validation, same host calls — and a
 * tool the session does not have cannot be conjured here. Plan and Goal sessions
 * declare no `skill_manage`, which is why the trigger asks {@link canReview}
 * instead of assuming the tools are there.
 */
export function reviewToolsFrom<T extends { name: string }>(declared: readonly T[]): T[] {
  const allowed = new Set(REVIEW_TOOL_ALLOWLIST);
  return declared.filter((tool) => allowed.has(tool.name));
}

/**
 * Whether a review run could do anything at all.
 *
 * A write tool with nothing to write with is a spawn that pays a full completion
 * and cannot land a single change, so the caller skips before it spends anything.
 */
export function canReview(tools: ReadonlyArray<{ name: string }>): boolean {
  const names = new Set(tools.map((tool) => tool.name));
  return names.has("skill_manage") && names.has("Skill");
}

export type ReviewActionKind = "created" | "patched" | "wrote" | "removed" | "memory";

export type ReviewAction = {
  kind: ReviewActionKind;
  /** Skill id for skill actions, the memory target for memory actions. */
  subject: string;
  /** `references/<topic>.md` for support-file actions. */
  file?: string;
};

/**
 * Which action a successful tool call amounts to.
 *
 * Read from the call's own arguments rather than from the result text: the result
 * says what the host did, the arguments say what was asked for, and the summary has
 * to name the thing a person recognises.
 */
export function reviewActionFromCall(toolName: string, args: unknown): ReviewAction | undefined {
  const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const text = (key: string): string =>
    typeof record[key] === "string" ? (record[key] as string).trim() : "";
  if (toolName === "memory") {
    const target = text("target") || "memory";
    const body = text("content") || text("old_text") || text("text");
    // A read of the store is not an action; only a write with something in it.
    return body ? { kind: "memory", subject: target } : undefined;
  }
  if (toolName !== "skill_manage") return undefined;
  const action = text("action");
  const name = text("name") || text("skill") || text("id");
  if (!name) return undefined;
  const file = text("file_path");
  switch (action) {
    case "create":
      return { kind: "created", subject: name };
    case "patch":
    case "edit":
      return { kind: "patched", subject: name };
    case "write_file":
      return file ? { kind: "wrote", subject: name, file } : undefined;
    case "remove_file":
      return file ? { kind: "removed", subject: name, file } : undefined;
    default:
      return undefined;
  }
}

/** One human-facing line per action, the way Hermes reports a review pass. */
export function describeReviewAction(action: ReviewAction): string {
  const where = action.file ? `${action.subject}/${action.file}` : action.subject;
  return `${action.kind} '${where}'`;
}

/**
 * The actions a review fork actually completed.
 *
 * `priorToolCallIds` are the calls already present in the replayed transcript: the
 * fork inherits the conversation, so without filtering them the summary re-reports
 * yesterday's writes as if they just happened.
 */
export function summarizeReviewActions(
  messages: ReadonlyArray<{
    role?: string;
    toolName?: string;
    toolCallId?: string;
    args?: unknown;
    isError?: boolean;
  }>,
  priorToolCallIds: ReadonlySet<string> = new Set(),
): ReviewAction[] {
  const actions: ReviewAction[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role && message.role !== "tool" && message.role !== "tool_result") continue;
    if (message.isError) continue;
    const id = message.toolCallId ?? "";
    if (id && priorToolCallIds.has(id)) continue;
    const action = reviewActionFromCall(message.toolName ?? "", message.args);
    if (!action) continue;
    const key = describeReviewAction(action);
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
  }
  return actions;
}

/**
 * Collects the review fork's own tool calls from its event stream.
 *
 * `SubagentRunResult` reports counts, not the calls themselves, so the summary has
 * to be built while the fork runs. A call is only reported once its result came back
 * without an error, and a call whose start was never seen is ignored rather than
 * guessed at.
 */
export class ReviewActionCollector {
  private readonly pending = new Map<string, { toolName: string; args: unknown }>();
  private readonly calls: Array<{
    role: "tool";
    toolName: string;
    toolCallId: string;
    args: unknown;
    isError?: boolean;
  }> = [];

  /** Completed tool calls. Zero means the fork answered without reading anything. */
  toolCallCount(): number {
    return this.calls.length;
  }

  /** Feed one event from the fork; anything that is not a tool boundary is ignored. */
  record(event: {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    isError?: boolean;
  }): void {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (!id) return;
    if (event.type === "tool_start") {
      this.pending.set(id, { toolName: event.toolName ?? "", args: event.args });
      return;
    }
    if (event.type !== "tool_end") return;
    const started = this.pending.get(id);
    this.pending.delete(id);
    this.calls.push({
      role: "tool",
      toolName: started?.toolName ?? "",
      toolCallId: id,
      args: started?.args,
      isError: event.isError === true,
    });
  }

  /** The actions the fork completed, ready for {@link describeReviewAction}. */
  actions(priorToolCallIds: ReadonlySet<string> = new Set()): ReviewAction[] {
    return summarizeReviewActions(this.calls, priorToolCallIds);
  }
}
