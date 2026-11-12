/**
 * Structured memory panel (ADR 0393).
 *
 * Read-mostly: the agent retains memories through its tool and the runtime
 * recalls them by relevance, so this page is where a person audits the store,
 * pins what must always be present, searches it, and forgets what is wrong.
 * The `memory` / `user` flat entry list this page used to render is retired —
 * one store, grouped by kind and scope instead of by two prompt targets.
 *
 * Search is a recall on the host, not a client-side filter: the index and the
 * ranking live there, and this page only decides what to ask for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, type MemoryRecord, type MemoryStats } from "../../lib/api";
import { LatestWinsGate } from "../../lib/latest-wins";
import { memoryView, sortMemoryRecords, type MemoryScopeFilter } from "../../lib/memory-view";
import { SettingsCard } from "../../features/settings/primitives";
import { Button, Input, SegmentedControl } from "../ui";
import { MEMORY_SCOPE_LABEL_KEY, MemoryList } from "./MemoryList";

const SCOPE_FILTERS: readonly MemoryScopeFilter[] = ["all", "global", "project", "session"];

/** Typing settles before a recall is asked for; the host is not a keystroke fan-out. */
const SEARCH_DELAY_MS = 250;

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function MemoryPane() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<MemoryScopeFilter>("all");
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tidying, setTidying] = useState(false);
  // Only the newest read may land; a slow list must not overwrite fresh hits.
  const gateRef = useRef<LatestWinsGate | null>(null);
  if (gateRef.current === null) gateRef.current = new LatestWinsGate();

  const loadStats = useCallback(async () => {
    try {
      const counted = await api.memoryStats();
      setStats(counted.stats);
    } catch {
      // The counts are context only; a page that can list memories stays usable.
    }
  }, []);

  const refresh = useCallback(async () => {
    const gate = gateRef.current;
    if (!gate) return;
    const token = gate.begin();
    setLoading(true);
    setError(null);
    try {
      const view = await memoryView(api, { scope, query });
      if (!gate.isCurrent(token)) return;
      setRecords(view.records);
      // Counts describe the whole store, so a recall result does not change them.
      if (!view.recalled) await loadStats();
    } catch (cause) {
      if (gate.isCurrent(token)) setError(describe(cause));
    } finally {
      if (gate.isCurrent(token)) setLoading(false);
    }
  }, [scope, query, loadStats]);

  useEffect(() => {
    // An empty query restores the list immediately; a typed one waits for the
    // debounce window so recall runs against what the person meant to type.
    const timer = window.setTimeout(() => void refresh(), trimmed ? SEARCH_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [refresh, trimmed]);

  const togglePin = async (record: MemoryRecord) => {
    setBusyId(record.id);
    setNotice(null);
    try {
      const { memory } = await api.updateMemory({ id: record.id, pinned: !record.pinned });
      setRecords((previous) =>
        sortMemoryRecords(previous.map((item) => (item.id === memory.id ? memory : item))),
      );
      await loadStats();
    } catch (cause) {
      setNotice(describe(cause));
    } finally {
      setBusyId(null);
    }
  };

  const forget = async (record: MemoryRecord) => {
    const confirmed = window.confirm(t("settings.memoryDeleteConfirm", { title: record.title }));
    if (!confirmed) return;
    setBusyId(record.id);
    setNotice(null);
    try {
      await api.forgetMemory({ id: record.id });
      setRecords((previous) => previous.filter((item) => item.id !== record.id));
      await loadStats();
    } catch (cause) {
      setNotice(describe(cause));
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
      await refresh();
    } catch (cause) {
      setNotice(describe(cause));
    } finally {
      setTidying(false);
    }
  };

  const scopeOptions = useMemo(
    () =>
      SCOPE_FILTERS.map((value) => ({
        value,
        label: value === "all" ? t("settings.memoryFilterAll") : t(MEMORY_SCOPE_LABEL_KEY[value]),
      })),
    [t],
  );

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

        {!loading && records.length === 0 ? (
          <p className="text-xs text-muted">
            {trimmed ? t("settings.memoryEmptyFiltered") : t("settings.memoryEmpty")}
          </p>
        ) : null}

        {records.length > 0 ? (
          <MemoryList
            records={records}
            busyId={busyId}
            onTogglePin={(record) => void togglePin(record)}
            onForget={(record) => void forget(record)}
          />
        ) : null}
      </div>
    </SettingsCard>
  );
}
