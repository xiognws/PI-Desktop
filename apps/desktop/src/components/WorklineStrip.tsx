import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionCollaborationSummary } from "@pi-workspace/shared";
import { api } from "../lib/api";
import {
  buildWorklines,
  worklineStatusKey,
  worklineTone,
  type WorklineEntry,
} from "../lib/workline-activity";
import { Badge } from "./ui";

/** A visible strip refreshes this often; a background tab does not poll. */
const REFRESH_MS = 4_000;

/**
 * Cross-session worklines: which sessions are running right now, who started
 * them, and what they are working on.
 *
 * The sidebar already answers "is anything under this project running" with a
 * count (`sidebar-project-runs.ts`). That count cannot say *which* session or
 * on whose behalf, so the answer used to require hovering each session in turn.
 * This strip asks the host for the collaboration summary of the sessions that
 * are actually busy — normally zero to a handful — and renders one row each.
 *
 * It renders nothing when no session is busy, so an idle app keeps the previous
 * sidebar layout exactly.
 */
export function WorklineStrip({
  sessions,
  runningSessions,
  pendingPermissions,
  activeSessionId,
  onOpenSession,
}: {
  sessions: readonly { id: string; title: string }[];
  runningSessions: Readonly<Record<string, boolean | undefined>>;
  pendingPermissions: Readonly<Record<string, readonly unknown[] | undefined>>;
  activeSessionId?: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [summaries, setSummaries] = useState<Record<string, SessionCollaborationSummary | undefined>>({});

  // Only busy sessions are worth a host read; an idle session's summary cannot
  // become a workline without a store change that re-runs this effect anyway.
  const busyIds = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            runningSessions[session.id] === true ||
            (pendingPermissions[session.id]?.length ?? 0) > 0,
        )
        .map((session) => session.id),
    [sessions, runningSessions, pendingPermissions],
  );
  const busyKey = busyIds.join(",");

  useEffect(() => {
    if (!busyIds.length) {
      setSummaries({});
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const entries = await Promise.all(
        busyIds.map(async (sessionId) => {
          try {
            return [sessionId, await api.getSessionCollaboration(sessionId)] as const;
          } catch {
            // An unavailable summary is a missing detail, not a missing row.
            return [sessionId, undefined] as const;
          }
        }),
      );
      if (disposed) return;
      setSummaries(Object.fromEntries(entries));
      if (document.visibilityState === "visible") {
        timer = setTimeout(() => void read(), REFRESH_MS);
      }
    };
    const onVisibility = () => {
      if (disposed || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      timer = undefined;
      void read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [busyKey]);

  const entries = useMemo(
    () => buildWorklines(sessions, runningSessions, pendingPermissions, summaries),
    [sessions, runningSessions, pendingPermissions, summaries],
  );
  if (!entries.length) return null;

  return (
    <section className="workline-strip" aria-label={t("sessionCollaboration.worklineAria")}>
      <div className="workline-strip-head">
        <span className="workline-strip-title">{t("sessionCollaboration.worklineTitle")}</span>
        <Badge tone="neutral" className="workline-strip-count">
          {t("sessionCollaboration.worklineActiveCount", { count: entries.length })}
        </Badge>
      </div>
      <ul className="workline-strip-list">
        {entries.map((entry) => (
          <li key={entry.sessionId}>
            <WorklineRow
              entry={entry}
              active={entry.sessionId === activeSessionId}
              onOpenSession={onOpenSession}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorklineRow({
  entry,
  active,
  onOpenSession,
}: {
  entry: WorklineEntry;
  active: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const statusLabel = t(worklineStatusKey(entry.state));
  return (
    <button
      type="button"
      className="workline-row"
      data-workline-state={entry.state}
      aria-current={active ? "page" : undefined}
      onClick={() => onOpenSession(entry.sessionId)}
    >
      <span className="workline-row-mark" data-state={entry.state} aria-hidden />
      <span className="workline-row-body">
        <span className="workline-row-title">{entry.title}</span>
        <span className="workline-row-meta">
          <Badge tone={worklineTone(entry.state)} className="workline-row-state">
            {statusLabel}
          </Badge>
          {entry.delegatedBy ? (
            <span className="workline-row-delegated">
              {t("sessionCollaboration.worklineDelegatedBy", { name: entry.delegatedBy })}
            </span>
          ) : null}
        </span>
        {entry.detail ? <span className="workline-row-detail">{entry.detail}</span> : null}
      </span>
    </button>
  );
}
