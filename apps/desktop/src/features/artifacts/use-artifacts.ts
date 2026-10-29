import { useCallback, useEffect, useMemo, useState } from "react";

import {
  filterArtifacts,
  groupArtifactsBySession,
  type ArtifactRow,
} from "@pi-desktop/shared";

import { api } from "../../lib/api";

/** How many rows the host should return; the page filters client-side. */
const LOAD_LIMIT = 500;

type Status = "loading" | "ready" | "error";

export type ArtifactsWorkspace = {
  status: Status;
  error: string | null;
  /** Total rows the host returned, before the query narrows them. */
  total: number;
  /** Rows the query kept. */
  visible: number;
  groups: ReturnType<typeof groupArtifactsBySession>;
  refresh: () => void;
};

/**
 * Loads the artifact list once per refresh and narrows it in memory. The host
 * call is a single pass over a small table, so there is no debounced search
 * round trip and no pagination state to keep consistent.
 */
export function useArtifacts(query: string): ArtifactsWorkspace {
  const [rows, setRows] = useState<ArtifactRow[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(0);

  const refresh = useCallback(() => setRequestId((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    setStatus((current) => (current === "ready" ? current : "loading"));
    void api
      .listArtifacts({ limit: LOAD_LIMIT })
      .then((result) => {
        if (cancelled) return;
        setRows(result.artifacts ?? []);
        setError(null);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  const groups = useMemo(
    () => groupArtifactsBySession(filterArtifacts(rows, query)),
    [rows, query],
  );

  return {
    status,
    error,
    total: rows.length,
    visible: groups.reduce((count, group) => count + group.rows.length, 0),
    groups,
    refresh,
  };
}
