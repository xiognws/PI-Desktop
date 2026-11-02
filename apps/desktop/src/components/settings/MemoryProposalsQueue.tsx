/**
 * Memory review queue (ADR 0376).
 *
 * An extraction pass writes candidates to `memory_proposals`, never to
 * `memories`; this surface is the only place a human turns one into the other.
 * It is deliberately separate from `MemoryPane` (the store browser): the queue
 * has its own lifecycle (pending vs decided), its own actions, and it is the
 * only writer of `acceptMemoryProposal`.
 *
 * Decisions are irreversible in the sense that matters: accepting writes a
 * memory, rejecting records the decision. Both are shown when `includeDecided`
 * is on so a user can audit what the extractor tried to add.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  api,
  type MemoryKind,
  type MemoryProposal,
  type MemoryScope,
} from "../../lib/api";
import { Badge, Button, Checkbox, cx } from "../ui";

const QUEUE_LIMIT = 100;

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

type Props = {
  /** Bumped by the parent after a mutation elsewhere so the queue refetches. */
  refreshToken?: number;
  /** Called after accept/reject so the store list can reload too. */
  onDecided?: () => void;
};

export function MemoryProposalsQueue({ refreshToken = 0, onDecided }: Props) {
  const { t, i18n } = useTranslation();
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [includeDecided, setIncludeDecided] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listMemoryProposals({
        includeDecided,
        limit: QUEUE_LIMIT,
      });
      setProposals(result.proposals ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [includeDecided]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const accept = async (proposal: MemoryProposal) => {
    setBusyId(proposal.id);
    setNotice(null);
    try {
      const { memory } = await api.acceptMemoryProposal(proposal.id);
      setProposals((prev) =>
        includeDecided
          ? prev.map((item) =>
              item.id === proposal.id
                ? { ...item, decision: "accepted", decidedAt: Date.now() }
                : item,
            )
          : prev.filter((item) => item.id !== proposal.id),
      );
      setNotice(
        memory
          ? t("settings.memoryProposalAccepted", { title: memory.title })
          : t("settings.memoryProposalAccepted", { title: proposal.title }),
      );
      onDecided?.();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (proposal: MemoryProposal) => {
    setBusyId(proposal.id);
    setNotice(null);
    try {
      await api.rejectMemoryProposal(proposal.id);
      setProposals((prev) =>
        includeDecided
          ? prev.map((item) =>
              item.id === proposal.id
                ? { ...item, decision: "rejected", decidedAt: Date.now() }
                : item,
            )
          : prev.filter((item) => item.id !== proposal.id),
      );
      setNotice(t("settings.memoryProposalRejected", { title: proposal.title }));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = proposals.filter((item) => !item.decision).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">
          {includeDecided
            ? t("settings.memoryProposalTitleAll", { count: proposals.length })
            : t("settings.memoryProposalTitle", { count: pendingCount })}
        </p>
        <Checkbox
          className="text-[11px] text-muted"
          checked={includeDecided}
          onChange={() => setIncludeDecided((prev) => !prev)}
          label={t("settings.memoryProposalShowDecided")}
        />
      </div>

      {error ? <p className="text-xs text-red-500">{error}</p> : null}
      {notice ? <p className="text-xs text-muted">{notice}</p> : null}
      {loading ? (
        <p className="text-xs text-muted">{t("settings.memoryProposalLoading")}</p>
      ) : null}

      {!loading && proposals.length === 0 ? (
        <p className="text-xs text-muted">{t("settings.memoryProposalEmpty")}</p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {proposals.map((proposal) => {
          const decided = Boolean(proposal.decision);
          return (
            <li
              key={proposal.id}
              className={cx(
                "rounded-md border border-[var(--border)] px-3 py-1.5",
                decided && "opacity-70",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium">{proposal.title}</span>
                    <Badge>{t(KIND_LABEL_KEY[proposal.kind])}</Badge>
                    <Badge>{t(SCOPE_LABEL_KEY[proposal.scope])}</Badge>
                    {proposal.decision === "accepted" ? (
                      <Badge>{t("settings.memoryProposalStateAccepted")}</Badge>
                    ) : null}
                    {proposal.decision === "rejected" ? (
                      <Badge>{t("settings.memoryProposalStateRejected")}</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[11px] text-muted">
                    {proposal.body}
                  </p>
                  <p className="mt-1 text-[11px] text-muted">
                    {t("settings.memoryProposalMeta", {
                      confidence: proposal.confidence.toFixed(2),
                      origin: proposal.origin,
                      date: new Date(proposal.createdAt).toLocaleString(i18n.language),
                    })}
                  </p>
                  {proposal.tags.length > 0 ? (
                    <p className="mt-1 text-[11px] text-muted">
                      {proposal.tags.map((tag) => (
                        <span key={tag} className="mr-1.5">
                          #{tag}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    disabled={busyId === proposal.id || decided}
                    onClick={() => void accept(proposal)}
                  >
                    {t("settings.memoryProposalAccept")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === proposal.id || decided}
                    onClick={() => void reject(proposal)}
                  >
                    {t("settings.memoryProposalReject")}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
