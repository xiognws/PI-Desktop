import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { latestTurnContextInspector } from "../lib/latest-turn-context";
import { contextBarText, compactTokens, formatElapsed } from "../lib/status-bar";
import { ContextUsageInspector } from "./ContextUsageInspector";

/**
 * The status bar's live numbers belong to the active session and change with
 * every streamed token, so each one is its own leaf: a running turn repaints a
 * couple of spans instead of the whole sidebar.
 */
function useTurnInspector() {
  const messages = useAppStore((s) => s.messages);
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const compactions = useAppStore((s) =>
    s.activeSessionId ? s.sessionCompactions[s.activeSessionId] : undefined,
  );
  return useMemo(
    () => latestTurnContextInspector(messages, providerModels, providers, compactions),
    [messages, providerModels, providers, compactions],
  );
}

/**
 * `[██████░░░░] 61% 42.1k` and, on click, the same detail panel the composer
 * opens: context used/left, cache hit rate, throughput, per-tool tokens. One
 * component owns both, so the bar can never disagree with the composer.
 */
export function StatusBarContext() {
  const { t } = useTranslation();
  const inspector = useTurnInspector();
  const percent = useMemo(() => {
    if (!inspector) return 0;
    const window_ = inspector.contextWindow || 0;
    const used = inspector.usage.inputTokens + inspector.usage.outputTokens;
    if (window_ <= 0) return 0;
    return Math.min(100, Math.round((used / window_) * 100));
  }, [inspector]);
  const tokens = useMemo(() => {
    const usage = inspector?.usage;
    if (!usage) return 0;
    return usage.inputTokens + usage.outputTokens;
  }, [inspector]);

  if (!inspector) return null;
  return (
    <span className="statusbar-metric statusbar-clickable">
      <ContextUsageInspector
        {...inspector}
        trigger={
          <>
            <span className="statusbar-label">{t("statusBar.context")}</span>
            <span className="statusbar-bar">{contextBarText(percent)}</span>
            <span className="statusbar-value">{percent}%</span>
            <span className="statusbar-aside">{compactTokens(tokens)}</span>
          </>
        }
      />
    </span>
  );
}

/**
 * `0:42` while the session is producing. The start is when this bar first saw
 * the session go busy; the store only carries a boolean, and a timer that
 * starts late is honest whereas one reconstructed from message times is not.
 */
export function StatusBarElapsed() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const running = useAppStore((s) => (s.activeSessionId ? s.runningSessions[s.activeSessionId] : false));
  const startedAt = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) {
      startedAt.current = 0;
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [running, sessionId]);

  if (!running) return null;
  return (
    <span className="statusbar-metric">
      <span className="statusbar-dot statusbar-dot-live" aria-hidden />
      <span className="statusbar-value">{formatElapsed(elapsed)}</span>
    </span>
  );
}
