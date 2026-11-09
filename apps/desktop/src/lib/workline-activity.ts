/**
 * Workline projection for the sidebar.
 *
 * A "workline" is a session that is doing something right now: running a turn,
 * waiting for a permission, or queued behind one. The sidebar already counted
 * them per project (`sidebar-project-runs.ts`); this module answers the next
 * question — which ones, on whose behalf, and what are they doing — without
 * re-deriving any of it in the renderer.
 *
 * Inputs are the two things the renderer already holds (the store's
 * `runningSessions` / `pendingPermissions`) plus the host's own collaboration
 * summary for a session. Nothing here infers success from text, and nothing
 * invents a session that the host did not report.
 */
import type { SessionCollaborationSummary } from "@pi-workspace/shared";

/** Ordered by how much they need the user: blocked first, then busy. */
export const WORKLINE_STATE_ORDER = ["waiting", "running", "queued", "idle"] as const;

export type WorklineState = (typeof WORKLINE_STATE_ORDER)[number];

export type WorklineEntry = {
  sessionId: string;
  title: string;
  state: WorklineState;
  /** Title of the session that started this one, when the host knows it. */
  delegatedBy?: string;
  /** First line of the task the session is working on, bounded. */
  detail?: string;
};

const DETAIL_LIMIT = 120;

export function worklineState(
  running: boolean,
  waitingForPermission: boolean,
  status: SessionCollaborationSummary["status"] | undefined,
): WorklineState {
  // A permission prompt outranks everything: the turn cannot proceed without
  // the user, and a status of "running" would hide that.
  if (waitingForPermission) return "waiting";
  if (status === "queued") return "queued";
  if (running || status === "running") return "running";
  return "idle";
}

/** Sidebar badge tone: only a blocked run needs the user's attention. */
export function worklineTone(state: WorklineState): "warning" | "neutral" {
  return state === "waiting" ? "warning" : "neutral";
}

/** Reuses the collaboration status strings the hover card already ships. */
export function worklineStatusKey(state: WorklineState): string {
  switch (state) {
    case "waiting":
      return "sessionCollaboration.statusPermission";
    case "running":
      return "sessionCollaboration.statusRunning";
    case "queued":
      return "sessionCollaboration.statusQueued";
    default:
      return "sessionCollaboration.statusIdle";
  }
}

export function worklineDetail(summary: SessionCollaborationSummary | undefined): string | undefined {
  const text = summary?.currentTask?.text;
  if (typeof text !== "string") return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > DETAIL_LIMIT ? `${line.slice(0, DETAIL_LIMIT).trimEnd()}…` : line;
}

/**
 * Only sessions that are actually busy are worklines. A session that reported
 * a completion and went idle is history, not live work — the inbox row and the
 * session itself already carry it.
 */
export function buildWorklines(
  sessions: readonly { id: string; title: string }[],
  runningSessions: Readonly<Record<string, boolean | undefined>>,
  pendingPermissions: Readonly<Record<string, readonly unknown[] | undefined>>,
  summaries: Readonly<Record<string, SessionCollaborationSummary | undefined>>,
): WorklineEntry[] {
  const entries: WorklineEntry[] = [];
  for (const session of sessions) {
    const summary = summaries[session.id];
    const waiting = (pendingPermissions[session.id]?.length ?? 0) > 0;
    const state = worklineState(runningSessions[session.id] === true, waiting, summary?.status);
    if (state === "idle") continue;
    const delegatedBy = summary?.createdBySession?.title?.trim();
    const detail = worklineDetail(summary);
    entries.push({
      sessionId: session.id,
      title: session.title,
      state,
      ...(delegatedBy ? { delegatedBy } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  return entries.sort((left, right) => {
    const rank = WORKLINE_STATE_ORDER.indexOf(left.state) - WORKLINE_STATE_ORDER.indexOf(right.state);
    if (rank !== 0) return rank;
    return left.title.localeCompare(right.title);
  });
}
