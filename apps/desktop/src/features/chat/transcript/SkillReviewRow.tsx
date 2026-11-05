import { useTranslation } from "react-i18next";

import { useAppStore } from "../../../stores/app-store";
import { skillReviewText } from "./skill-review-text";

/**
 * One quiet line under a finished turn reporting the self-improvement review.
 *
 * The review runs after the turn on a fork the transcript never shows, so without
 * this row a pass that found nothing is visually identical to one that never ran —
 * which is exactly the ambiguity that made "skills stopped updating" hard to see.
 * A pass that wrote something also lists what it wrote; a pass that did not stays
 * one line.
 */
export function SkillReviewRow({ turnId }: { turnId: string }) {
  const { t } = useTranslation();
  const notice = useAppStore((state) => state.skillReviewByTurn[turnId]);
  if (!notice) return null;
  const detail = notice.actions.join(" · ");
  return (
    <div className="skill-review-row" data-outcome={notice.outcome}>
      <span className="skill-review-text">{skillReviewText(notice, t)}</span>
      {detail ? (
        <span className="skill-review-detail" title={detail}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}
