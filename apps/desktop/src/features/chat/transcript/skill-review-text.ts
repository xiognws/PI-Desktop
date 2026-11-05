import type { SkillReviewNotice } from "../../../stores/app-state";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * What the review row says, kept free of JSX so the wording is testable without a
 * render. The four outcomes mean different things to the reader: a pass that wrote
 * something, one that looked and found nothing, one that never looked (the failure
 * the row exists to expose), and one that broke.
 */
export function skillReviewText(notice: SkillReviewNotice, t: Translate): string {
  if (notice.outcome === "applied") {
    return t("chat.skillReviewApplied", { count: notice.actions.length });
  }
  if (notice.outcome === "failed") return t("chat.skillReviewFailed");
  if (notice.reason === "no-tool-calls") return t("chat.skillReviewNoLook");
  if (notice.reason === "nothing-to-save") return t("chat.skillReviewNothing");
  return t("chat.skillReviewSkipped", { reason: notice.reason ?? "" });
}
