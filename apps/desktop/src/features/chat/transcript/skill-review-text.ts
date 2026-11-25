import type {
  SkillReviewActionDetail,
  SkillReviewNotice,
} from "../../../stores/app-state";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Reasons that mean "the review did not run", as opposed to "it ran and had
 * something to say". Hermes publishes a summary only for a pass that wrote, so
 * these stay in the log and off the transcript: they describe the scheduler, not
 * anything the reader can act on.
 */
const GATE_REASONS = new Set([
  "disabled",
  "mode",
  "already-running",
  "too-few-tools",
  "cooldown",
  "nothing-new",
  "nothing-to-save",
  "no-tool-calls",
  // A fork that never completed never looked, and its status is the scheduler's
  // bookkeeping ("aborted", "stopped", "failed") rather than a reading of the
  // library. It stays in the log like every other gate. `step-limit` belongs here
  // for the same reason: the pass spent its budget without reaching a verdict.
  "aborted",
  "stopped",
  "failed",
  "step-limit",
]);

/**
 * Whether this notice is worth a line under its turn.
 *
 * A write always reports, and so does a failure — a review that broke is the one
 * thing the row exists to expose. A pass that never ran is not news.
 */
export function skillReviewReports(notice: SkillReviewNotice): boolean {
  if (notice.outcome === "applied") return true;
  if (notice.outcome === "failed") return true;
  const reason = notice.reason ?? "";
  if (reason.startsWith("no-skill-tools")) return false;
  // An upstream hiccup is not a reading of the library either: the fork never
  // reached a verdict, and the reason carries the provider's own code
  // (`provider-error:INCOMPLETE_STREAM`) so the skill-review log still says which
  // way it broke. A rejected request stays a visible failure — it names something
  // the reader can fix.
  if (reason.startsWith("provider-error")) return false;
  return !GATE_REASONS.has(reason);
}

/**
 * What the review row says, kept free of JSX so the wording is testable without a
 * render. The three outcomes mean different things to the reader: a pass that wrote
 * something, one that broke, and the quiet answers a reader can still opt into.
 */
export function skillReviewText(notice: SkillReviewNotice, t: Translate): string {
  if (notice.outcome === "applied") {
    const detail = skillReviewDetail(notice, t);
    return detail
      ? t("chat.skillReviewAppliedDetail", { detail })
      : t("chat.skillReviewApplied", { count: notice.actions.length });
  }
  if (notice.outcome === "failed") return t("chat.skillReviewFailed");
  if (notice.reason === "no-tool-calls") return t("chat.skillReviewNoLook");
  if (notice.reason === "nothing-to-save") return t("chat.skillReviewNothing");
  return t("chat.skillReviewSkipped", { reason: notice.reason ?? "" });
}

/**
 * Which verb a structured write speaks, as an i18n key.
 *
 * The kinds are the runtime's own (`created` / `patched` / `wrote` / `removed` /
 * `memory`), not this file's invention: the same names `describe_review_action`
 * renders in English.
 */
const ACTION_VERB_KEY: Record<string, string> = {
  created: "chat.skillReviewVerbCreated",
  patched: "chat.skillReviewVerbPatched",
  wrote: "chat.skillReviewVerbWrote",
  removed: "chat.skillReviewVerbRemoved",
};

/**
 * One write, in the reader's language: `skill 'x' wrote references/y.md`.
 *
 * The reference implementation prints exactly this line per write, prefixed with a
 * glyph and joined with `·`, rather than a count of what happened — the reader
 * wants to know *which* skill changed and where. A memory write is its own shape,
 * because it has no skill and no file.
 */
export function skillReviewActionText(
  detail: SkillReviewActionDetail,
  t: Translate,
): string {
  const name = detail.subject ?? "";
  if (detail.kind === "memory") return t("chat.skillReviewMemoryAction", { name });
  const verb = t(ACTION_VERB_KEY[detail.kind ?? ""] ?? "chat.skillReviewVerbWrote");
  const file = detail.file ?? "";
  return file
    ? t("chat.skillReviewActionWithFile", { name, verb, file })
    : t("chat.skillReviewAction", { name, verb });
}

/**
 * The writes of one pass, joined into a single sentence.
 *
 * One line, not one line per write: a pass that touched four skills produced four
 * lines of the same shape and pushed the conversation down for no new information.
 * The writes still name themselves — `skill 'x' wrote references/y.md` — so the
 * reader can see what changed; they are separated by `·` inside one line.
 *
 * Falls back to the runtime's own English sentences when a notice arrived from a
 * runtime that does not send the structured form, so a session replayed from an old
 * log renders instead of going blank.
 */
export function skillReviewDetail(notice: SkillReviewNotice, t: Translate): string {
  const details = notice.actionDetails ?? [];
  if (details.length > 0) {
    return details.map((detail) => skillReviewActionText(detail, t)).join(" \u00b7 ");
  }
  return notice.actions.join(" \u00b7 ");
}
