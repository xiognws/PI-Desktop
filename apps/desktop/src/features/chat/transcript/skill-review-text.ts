import type { SkillReviewNotice } from "../../../stores/app-state";

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
  // library. It stays in the log like every other gate.
  "aborted",
  "stopped",
  "failed",
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
  return !GATE_REASONS.has(reason);
}

/**
 * What the review row says, kept free of JSX so the wording is testable without a
 * render. The three outcomes mean different things to the reader: a pass that wrote
 * something, one that broke, and the quiet answers a reader can still opt into.
 */
export function skillReviewText(notice: SkillReviewNotice, t: Translate): string {
  if (notice.outcome === "applied") {
    const detail = notice.actions.join(" · ");
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
 * The review's writes as one line each, the way Hermes prints them.
 *
 * Hermes renders a memory/skill write from the review as its own line with a
 * glyph (`display.review.memory_op_line`, `skill_patched_verbose`), not as one
 * sentence summarising the pass — the reader wants to see *which* skill changed
 * and what it says, and a summary hides exactly that. The op strings come from
 * the runtime as `created 'x'`, `patched 'x'`, `memory 'memory'`.
 */
export function skillReviewLines(notice: SkillReviewNotice): string[] {
  if (notice.outcome !== "applied") return [];
  return notice.actions.map((action) => {
    const verb = action.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    const glyph =
      verb === "memory" ? "\u{1F9E0}" : verb === "patched" ? "\u{270E}" : verb === "deleted" ? "\u{2212}" : "\u{270D}";
    return `${glyph} ${action}`;
  });
}
