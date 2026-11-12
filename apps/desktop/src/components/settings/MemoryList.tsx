/**
 * One memory row, rendered from the structured store (ADR 0393).
 *
 * Presentational only: the pane owns loading, search and mutations, this file
 * owns what a row shows — kind, tags, pin state, how often it was recalled,
 * when it was last used, and the body behind a disclosure. Keeping it free of
 * fetching is what lets a test render real rows through server rendering.
 */
import { useTranslation } from "react-i18next";

import { formatMemoryLastUsed } from "../../lib/memory-view";
import type { MemoryKind, MemoryRecord, MemoryScope } from "../../lib/api";
import { Badge, Button, cx } from "../ui";
import { SettingsDisclosure } from "./SettingsDisclosure";

export const MEMORY_KIND_LABEL_KEY: Record<MemoryKind, string> = {
  fact: "settings.memoryKindFact",
  preference: "settings.memoryKindPreference",
  decision: "settings.memoryKindDecision",
  pitfall: "settings.memoryKindPitfall",
  procedure: "settings.memoryKindProcedure",
};

export const MEMORY_SCOPE_LABEL_KEY: Record<MemoryScope, string> = {
  global: "settings.memoryScopeGlobal",
  project: "settings.memoryScopeProject",
  session: "settings.memoryScopeSession",
};

export function MemoryList({
  records,
  busyId,
  onTogglePin,
  onForget,
}: {
  records: readonly MemoryRecord[];
  /** The row whose pin/forget request is in flight, if any. */
  busyId: string | null;
  onTogglePin: (record: MemoryRecord) => void;
  onForget: (record: MemoryRecord) => void;
}) {
  const { t, i18n } = useTranslation();
  const now = Date.now();

  return (
    <ul className="flex flex-col gap-2">
      {records.map((record) => {
        const lastUsed = formatMemoryLastUsed(record.lastUsedAt, i18n.language, now);
        return (
          <li
            key={record.id}
            className={cx(
              "rounded-md border border-[var(--border)] px-3 py-2",
              record.supersededBy && "opacity-60",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{record.title}</span>
                  <Badge>{t(MEMORY_KIND_LABEL_KEY[record.kind])}</Badge>
                  <Badge>{t(MEMORY_SCOPE_LABEL_KEY[record.scope])}</Badge>
                  {record.pinned ? (
                    <Badge tone="success">{t("settings.memoryPinned")}</Badge>
                  ) : null}
                  {record.supersededBy ? (
                    <Badge tone="warning">{t("settings.memorySuperseded")}</Badge>
                  ) : null}
                </div>
                {record.tags.length > 0 ? (
                  <ul className="mt-1 flex flex-wrap gap-1" aria-label={t("settings.memoryTags")}>
                    {record.tags.map((tag) => (
                      <li key={tag}>
                        <Badge>{tag}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-1 text-2xs text-muted">
                  {t("settings.memoryUsedCount", { count: record.useCount })}
                  {" · "}
                  {lastUsed
                    ? t("settings.memoryLastUsed", { when: lastUsed })
                    : t("settings.memoryNeverUsed")}
                </p>
                <SettingsDisclosure title={t("settings.memoryBody")} className="mt-1">
                  <p className="whitespace-pre-wrap text-xs text-muted">{record.body}</p>
                </SettingsDisclosure>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={record.pinned}
                  disabled={busyId === record.id}
                  onClick={() => onTogglePin(record)}
                >
                  {record.pinned ? t("settings.memoryUnpin") : t("settings.memoryPin")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId === record.id}
                  onClick={() => onForget(record)}
                >
                  {t("settings.memoryDelete")}
                </Button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
