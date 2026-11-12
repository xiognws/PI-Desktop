import { useTranslation } from "react-i18next";

import { useAppStore } from "../../../stores/app-store";
import { skillReviewLines, skillReviewReports, skillReviewText } from "./skill-review-text";

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
  // One line per write, glyph first — the shape Hermes uses for a review's memory
  // and skill operations. A single "N updates" sentence told the reader that
  // something happened but not what, which is the part they act on.
  const lines = skillReviewLines(notice);
  return (
    <div className="skill-review-row" data-outcome={notice.outcome} role="status">
      {lines.length > 0 ? (
        <ul className="skill-review-lines">
          {lines.map((line) => (
            <li key={line} className="skill-review-line">
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <span className="skill-review-text">{skillReviewText(notice, t)}</span>
      )}
    </div>
  );
}