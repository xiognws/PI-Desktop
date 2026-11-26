import { useTranslation } from "react-i18next";
import { formatCompactTokenCount, type SessionUsageTotals } from "@pi-workspace/shared";
import { sessionTokensSplit } from "../../../lib/status-bar";

/**
 * `18.8K · 主 12.0K · 副 6.8K` — the session's tokens, and in smart mode which model
 * spent them. The split is omitted when nothing was delegated, so a single-model
 * session reads as one number rather than "main 100%, worker 0".
 */
export function SessionTokenTotals({ totals }: { totals: SessionUsageTotals }) {
  const { t } = useTranslation();
  const split = sessionTokensSplit(totals);
  if (split.total <= 0) return null;
  const values = [formatCompactTokenCount(split.total)];
  if (split.worker > 0) {
    values.push(`${t("chat.usageMainModel")} ${formatCompactTokenCount(split.main)}`);
    values.push(`${t("chat.usageWorkerModel")} ${formatCompactTokenCount(split.worker)}`);
  }
  return (
    <div className="context-inspector-summary-row">
      <strong>{t("chat.usageSessionTotal")}</strong>
      <span className="context-inspector-summary-values">{values.join(" · ")}</span>
    </div>
  );
}
