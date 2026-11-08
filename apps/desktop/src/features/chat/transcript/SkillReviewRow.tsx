import { useTranslation } from "react-i18next";

import { useAppStore } from "../../../stores/app-store";
import { skillReviewReports, skillReviewText } from "./skill-review-text";

/**
 * One quiet line under a finished turn reporting the self-improvement review.
 *
 * The review runs after the turn on a fork the transcript never shows, so without
 * this row a review that wrote a skill would be indistinguishable from one that
 * never ran. That is the whole scope of the row: Hermes announces a review only
 * when it landed something (or broke), so a pass that found nothing and a gate
 * that never opened stay in the log rather than in the conversation.
 *
 * The notice arrives after its turn has already rendered, so it cannot be part of
 * that turn's entry. It is keyed by session and drawn as the history list's
 * trailing slot, which is the row directly under the turn that produced it.
 *
 * The runtime stamps the notice with its own turn id, and the transcript keys its
 * rows by renderer ids; the two never compare, so the position — not the stamp —
 * decides where the row lands.
 */
export function SkillReviewRow({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const notice = useAppStore((state) => state.skillReviewBySession[sessionId]);
  // The switch hides the row, never the review: a user who turned the report off
  // still gets the skill library updated, they just do not want the line.
  const visible = useAppStore((state) => state.settings?.skillReviewVisible !== false);
  if (!visible) return null;
  if (!notice) return null;
  if (!skillReviewReports(notice)) return null;
  // The actions are the row's whole content: "it patched these skills" is what a
  // reader acts on, so they are printed for every outcome that wrote, not only
  // when the wording falls back to an empty pluralised count.
  const detail = notice.actions.join(" · ");
  return (
    <div className="skill-review-row" data-outcome={notice.outcome} role="status">
      <span className="skill-review-text">{skillReviewText(notice, t)}</span>
      {detail ? (
        <span className="skill-review-detail" title={detail}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}
