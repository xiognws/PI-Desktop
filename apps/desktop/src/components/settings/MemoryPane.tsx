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

import type { AppSettings } from "@pi-desktop/shared";
import {
  api,
  type MemoryDecayProposal,
  type MemoryProposal,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStats,
} from "../../lib/api";
import { SettingsCard } from "../../features/settings/primitives";
import { Badge, Button, cx, Input, SegmentedControl, SettingsToggle } from "../ui";

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
  // Extraction proposals: review queue, separate from what the store believes.
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filter = scope === "all" ? { limit: PAGE_SIZE } : { scope, limit: PAGE_SIZE };
      const [listed, counted, pending] = await Promise.all([
        api.listMemories(filter),
        api.memoryStats(),
        api.listMemoryProposals({ limit: 50 }),
      ]);
      setRecords(listed.memories);
      setStats(counted.stats);
      setProposals(pending.proposals ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  return { records, setRecords, stats, loading, error, load, proposals };
}

export function MemoryPane() {
  const { t, i18n } = useTranslation();
  const [scope, setScope] = useState<ScopeFilter>("all");
  const { records, setRecords, stats, loading, error, load, proposals } =
    useMemoryData(scope);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tidying, setTidying] = useState(false);
  // Stage-2b decay (ADR 0375): the host proposes, the user retires, restore undoes it.
  const [decay, setDecay] = useState<MemoryDecayProposal[] | null>(null);
  const [decayBusy, setDecayBusy] = useState(false);
  // Extraction is opt-in, so the switch has to be reachable from the surface that
  // shows what it produces (ADR 0376).
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return records;
    return records.filter((record) => {
      const haystack = `${record.title} ${record.body} ${record.tags.join(" ")}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [records, query]);

  useEffect(() => {
    void api
      .getSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  const toggleExtraction = async (next: boolean) => {
    const current = settings;
    if (!current) return;
    const updated = { ...current, memoryExtractAfterTurn: next };
    setSettings(updated);
    try {
      await api.setSettings(updated);
    } catch (cause) {
      setSettings(current);
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const acceptProposal = async (proposal: MemoryProposal) => {
    setBusyId(proposal.id);
    setNotice(null);
    try {
      await api.acceptMemoryProposal(proposal.id);
      await load();
      setNotice(t("settings.memoryProposalAccepted", { title: proposal.title }));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const rejectProposal = async (proposal: MemoryProposal) => {
    setBusyId(proposal.id);
    setNotice(null);
    try {
      await api.rejectMemoryProposal(proposal.id);
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const checkDecay = async () => {
    setDecayBusy(true);
    setNotice(null);
    try {
      const result = await api.decayMemories();
      setDecay(
        (result.proposals ?? []).filter((proposal) => proposal.suggestion === "retire"),
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDecayBusy(false);
    }
  };

  const retire = async (proposal: MemoryDecayProposal) => {
    setBusyId(proposal.id);
    setNotice(null);
    try {
      await api.retireMemory(proposal.id, "decay");
      setDecay((prev) => (prev ?? []).filter((item) => item.id !== proposal.id));
      await load();
      setNotice(t("settings.memoryDecayDone", { title: proposal.title }));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restore = async (record: MemoryRecord) => {
    setBusyId(record.id);
    setNotice(null);
    try {
      await api.restoreMemory(record.id);
      await load();
      setNotice(t("settings.memoryDecayRestored", { title: record.title }));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

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
        <>
          <Button variant="secondary" size="sm" onClick={() => void checkDecay()} disabled={decayBusy}>
            {decayBusy ? t("settings.memoryDecayChecking") : t("settings.memoryDecayCheck")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void tidy()} disabled={tidying}>
            {tidying ? t("settings.memoryTidying") : t("settings.memoryTidy")}
          </Button>
        </>
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

        {settings ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--border)] px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">{t("settings.memoryExtractLabel")}</p>
              <p className="mt-0.5 text-[11px] text-muted">{t("settings.memoryExtractHint")}</p>
            </div>
            <SettingsToggle
              checked={settings.memoryExtractAfterTurn === true}
              label={t("settings.memoryExtractLabel")}
              onChange={() => void toggleExtraction(settings.memoryExtractAfterTurn !== true)}
            />
          </div>
        ) : null}

        {proposals.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium">
              {t("settings.memoryProposalTitle", { count: proposals.length })}
            </p>
            <ul className="flex flex-col gap-1">
              {proposals.map((proposal) => (
                <li
                  key={proposal.id}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium">{proposal.title}</span>
                        <Badge>{t(KIND_LABEL_KEY[proposal.kind])}</Badge>
                        <Badge>{t(SCOPE_LABEL_KEY[proposal.scope])}</Badge>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-[11px] text-muted">
                        {proposal.body}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        disabled={busyId === proposal.id}
                        onClick={() => void acceptProposal(proposal)}
                      >
                        {t("settings.memoryProposalAccept")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === proposal.id}
                        onClick={() => void rejectProposal(proposal)}
                      >
                        {t("settings.memoryProposalReject")}
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {decay !== null ? (
          decay.length === 0 ? (
            <p className="text-xs text-muted">{t("settings.memoryDecayEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {decay.map((proposal) => (
                <li
                  key={proposal.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] px-3 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{proposal.title}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] text-muted">
                      {t("settings.memoryDecayReason", {
                        days: proposal.idleDays,
                        value: proposal.decayedConfidence.toFixed(2),
                      })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === proposal.id}
                      onClick={() => void retire(proposal)}
                    >
                      {t("settings.memoryDecayRetire")}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )
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
                    {record.validUntil ? (
                      <Badge>{t("settings.memoryDecayRetired")}</Badge>
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
                  {record.validUntil ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === record.id}
                      onClick={() => void restore(record)}
                    >
                      {t("settings.memoryDecayRestore")}
                    </Button>
                  ) : null}
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
