import { useEffect, useState } from "react";
import type { SessionUsageTotals } from "@pi-workspace/shared";
import { api } from "../../../lib/api";

type Loaded = { sessionId: string; key: string; totals: SessionUsageTotals };

/**
 * The host's whole-session token rollup while the inspector is open.
 *
 * The renderer only holds a window of the transcript, so summing loaded messages would
 * undercount a long session; this asks the ledger instead. The previous figure stays on
 * screen until a refresh lands, and a result for another session or an older refresh key
 * is dropped rather than shown against the wrong turn.
 */
export function useSessionTokenTotals({
  enabled,
  sessionId,
  refreshKey,
  load = api.sessionUsageTotals,
}: {
  enabled: boolean;
  sessionId?: string;
  refreshKey: string;
  load?: (sessionId: string) => Promise<{ totals: SessionUsageTotals } | undefined>;
}): SessionUsageTotals | undefined {
  const [loaded, setLoaded] = useState<Loaded>();

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let current = true;
    load(sessionId).then(
      (result) => {
        if (current && result?.totals) setLoaded({ sessionId, key: refreshKey, totals: result.totals });
      },
      () => {
        // A side channel: a failed poll keeps the last total on screen.
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, sessionId, refreshKey, load]);

  if (!loaded || loaded.sessionId !== sessionId || loaded.key !== refreshKey) return undefined;
  return loaded.totals;
}
