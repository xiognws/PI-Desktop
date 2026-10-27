/**
 * Durable memory panel (ADR 0371).
 *
 * Read-mostly: the agent writes memories through its tool, and this surface is
 * where a user audits, pins, searches and deletes them. Search and scope
 * filtering happen client-side over the first page because a session's memory
 * count is small; the host still owns paging for callers that need it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  api,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStats,
} from "../../lib/api";
import { SettingsCard } from "../../features/settings/primitives";
import { Badge, Button, cx, Input, SegmentedControl } from "../ui";

const PAGE_SIZE = 200;

const SCOPE_FILTERS = ["all", "global", "project", "session"] as const;
type ScopeFilter = (typeof SCOPE_FILTERS)[number];

const KIND_LABEL_KEY: Record<MemoryKind, string> = {
  fact: "settings.memoryKindFact",
  preference: "settings.memoryKindPreference",
  decision: "settings.memoryKindDecision",
  pitfall: "settings.memoryKindPitfall",
  procedure: "settings.memoryKindProcedure",
};

const SCOPE_LABEL_KEY: Record<MemoryScope, string> = {
  global: "settings.memoryScopeGlobal",
  project: "settings.memoryScopeProject",
  session: "settings.memoryScopeSession",
};

function useMemoryData(scope: ScopeFilter) {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filter = scope === "all" ? { limit: PAGE_SIZE } : { scope, limit: PAGE_SIZE };
      const [listed, counted] = await Promise.all([
        api.listMemories(filter),
        api.memoryStats(),
      ]);
      setRecords(listed.memories);
      setStats(counted.stats);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  return { records, setRecords, stats, loading, error, load };
}

export function MemoryPane() {
  const { t, i18n } = useTranslation();
  const [scope, setScope] = useState<ScopeFilter>("all");
  const { records, setRecords, stats, loading, error, load } = useMemoryData(scope);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tidying, setTidying] = useState(false);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return records;
    return records.filter((record) => {
      const haystack = `${record.title} ${record.body} ${record.tags.join(" ")}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [records, query]);

  const togglePin = async (record: MemoryRecord) => {
    setBusyId(record.id);
    setNotice(null);
    try {
      const { memory } = await api.updateMemory({ id: record.id, pinned: !record.pinned });
      setRecords((prev) => prev.map((item) => (item.id === memory.id ? memory : item)));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const forget = async (record: MemoryRecord) => {
    const confirmed = window.confirm(
      t("settings.memoryDeleteConfirm", { title: record.title }),
    );
    if (!confirmed) return;
    setBusyId(record.id);
    setNotice(null);
    try {
      await api.forgetMemory({ id: record.id });
      setRecords((prev) => prev.filter((item) => item.id !== record.id));
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const tidy = async () => {
    setTidying(true);
    setNotice(null);
    try {
      const result = await api.tidyMemories();
      setNotice(t("settings.memoryTidyDone", { count: result.removed }));
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTidying(false);
    }
  };

  const scopeOptions = SCOPE_FILTERS.map((value) => ({
    value,
    label:
      value === "all" ? t("settings.memoryFilterAll") : t(SCOPE_LABEL_KEY[value]),
  }));

  return (
    <SettingsCard
      title={t("settings.memory")}
      description={t("settings.memoryIntro")}
      action={
        <Button variant="secondary" size="sm" onClick={() => void tidy()} disabled={tidying}>
          {tidying ? t("settings.memoryTidying") : t("settings.memoryTidy")}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("settings.memorySearchPlaceholder")}
            aria-label={t("settings.memorySearchPlaceholder")}
            className="min-w-[14rem] flex-1"
          />
          <SegmentedControl
            label={t("settings.memoryFilterLabel")}
            value={scope}
            onChange={(value) => setScope(value)}
            options={scopeOptions}
          />
        </div>

        {stats ? (
          <p className="text-xs text-muted">
            {t("settings.memoryStatsLine", {
              live: stats.live,
              pinned: stats.pinned,
              total: stats.total,
            })}
          </p>
        ) : null}

        {error ? <p className="text-xs text-red-500">{error}</p> : null}
        {notice ? <p className="text-xs text-muted">{notice}</p> : null}
        {loading ? <p className="text-xs text-muted">{t("settings.memoryLoading")}</p> : null}

        {!loading && visible.length === 0 ? (
          <p className="text-xs text-muted">
            {query.trim() ? t("settings.memoryEmptyFiltered") : t("settings.memoryEmpty")}
          </p>
        ) : null}

        <ul className="flex flex-col gap-2">
          {visible.map((record) => (
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
                    <Badge>{t(KIND_LABEL_KEY[record.kind])}</Badge>
                    <Badge>{t(SCOPE_LABEL_KEY[record.scope])}</Badge>
                    {record.pinned ? <Badge>{t("settings.memoryPinned")}</Badge> : null}
                    {record.supersededBy ? (
                      <Badge>{t("settings.memorySuperseded")}</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{record.body}</p>
                  <p className="mt-1 text-[11px] text-muted">
                    {t("settings.memoryMeta", {
                      used: record.useCount,
                      date: new Date(record.lastUsedAt ?? record.createdAt).toLocaleDateString(
                        i18n.language,
                      ),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === record.id}
                    onClick={() => void togglePin(record)}
                  >
                    {record.pinned ? t("settings.memoryUnpin") : t("settings.memoryPin")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === record.id}
                    onClick={() => void forget(record)}
                  >
                    {t("settings.memoryDelete")}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </SettingsCard>
  );
}
