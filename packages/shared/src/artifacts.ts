/**
 * Artifacts: the files a session produced through a Write/Edit tool
 * (04-data-storage §4.9). Host-core owns the rows; this module holds the
 * shapes the renderer renders plus the pure grouping/filtering it does, so the
 * page component stays a renderer and the rules stay testable.
 */

/** One row of `artifacts.list`, already narrowed by the host. */
export type ArtifactRow = {
  sessionId: string;
  /** Null when the session row is gone but its artifacts remain. */
  sessionTitle?: string | null;
  /** Absolute path as the tool received it. */
  path: string;
  /** `write` or `edit` today; treated as opaque elsewhere. */
  op: string;
  /** ISO timestamp of the last time this session touched the file. */
  updatedAt: string;
};

export type ArtifactListFilter = {
  sessionId?: string;
  limit?: number;
};

/** Ops the UI has a label for; anything else renders through `op.other`. */
export const ARTIFACT_OPS = ["write", "edit"] as const;

export type ArtifactOp = (typeof ARTIFACT_OPS)[number];

/** i18n key for an op, falling back so an unknown op never renders empty. */
export function artifactOpKey(op: string): string {
  return (ARTIFACT_OPS as readonly string[]).includes(op)
    ? `artifacts.op.${op}`
    : "artifacts.op.other";
}

/** Last path segment; the list shows the file name and the directory beside it. */
export function artifactFileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** Everything before the file name, without a trailing separator. */
export function artifactDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : "";
}

/**
 * Case-insensitive substring match over the file name, the directory, the op
 * and the session title: the four things a user types when looking for "that
 * file the agent wrote".
 */
export function filterArtifacts(rows: ArtifactRow[], query: string): ArtifactRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    `${row.path}\n${row.sessionTitle ?? ""}\n${row.op}`.toLowerCase().includes(needle),
  );
}

export type ArtifactGroup = {
  sessionId: string;
  /** Null when the session was deleted; the UI labels it separately. */
  sessionTitle: string | null;
  rows: ArtifactRow[];
};

/**
 * Newest session first, newest file first inside it. Rows whose session is gone
 * keep their own group instead of disappearing: the file is still on disk.
 */
export function groupArtifactsBySession(rows: ArtifactRow[]): ArtifactGroup[] {
  const groups = new Map<string, ArtifactGroup>();
  for (const row of rows) {
    const existing = groups.get(row.sessionId);
    const title = row.sessionTitle?.trim() ? row.sessionTitle : null;
    if (existing) {
      existing.rows.push(row);
      existing.sessionTitle = existing.sessionTitle ?? title;
      continue;
    }
    groups.set(row.sessionId, { sessionId: row.sessionId, sessionTitle: title, rows: [row] });
  }
  const ordered = [...groups.values()];
  for (const group of ordered) {
    group.rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  ordered.sort((a, b) => (b.rows[0]?.updatedAt ?? "").localeCompare(a.rows[0]?.updatedAt ?? ""));
  return ordered;
}
