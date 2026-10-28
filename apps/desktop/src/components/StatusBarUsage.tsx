import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { latestTurnContextInspector } from "../lib/latest-turn-context";
import {
  calculateContextUsage,
  contextUsageView,
  resolveContextUsageDisplay,
} from "../lib/context-usage";
import { contextBarText, compactTokens, formatElapsed } from "../lib/status-bar";

/**
 * The status bar's live numbers belong to the active session and change with
 * every streamed token. Each one is its own leaf so a running turn repaints a
 * few spans instead of the whole sidebar.
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

/** `[██████░░░░] 61% 42.1k` — shape first, then the two numbers that explain it. */
export function StatusBarContext() {
  const { t } = useTranslation();
  const inspector = useTurnInspector();
  const displayMode = useAppStore((s) => s.settings?.contextUsageDisplay);
  const view = useMemo(() => {
    if (!inspector) return null;
    const usage = calculateContextUsage(inspector.usage, inspector.contextWindow);
    return contextUsageView(usage, resolveContextUsageDisplay(displayMode));
  }, [inspector, displayMode]);

  if (!view) return null;
  return (
    <span className="statusbar-metric" title={`${view.tokens} / ${inspector?.contextWindow ?? "?"}`}>
      <span className="statusbar-label">{t("statusBar.context")}</span>
      <span className="statusbar-bar">{contextBarText(view.percent)}</span>
      <span className="statusbar-value">{view.percent}%</span>
      <span className="statusbar-aside">{compactTokens(view.tokens)}</span>
    </span>
  );
}

/** `38 t/s` — throughput of the newest completed response, not a running average. */
export function StatusBarSpeed() {
  const { t } = useTranslation();
  const inspector = useTurnInspector();
  const perSecond = useMemo(() => {
    const tokens = inspector?.responseOutputTokens ?? 0;
    const ms = inspector?.responseDurationMs ?? 0;
    if (tokens <= 0 || ms <= 0) return 0;
    return Math.round((tokens / ms) * 1000);
  }, [inspector]);

  if (!perSecond) return null;
  return (
    <span className="statusbar-metric">
      <span className="statusbar-label">{t("statusBar.speed")}</span>
      <span className="statusbar-value">{perSecond} t/s</span>
    </span>
  );
}

/** `72%` cache reads — shown only when the provider actually reported cache tokens. */
export function StatusBarCache() {
  const { t } = useTranslation();
  const inspector = useTurnInspector();
  const percent = useMemo(() => {
    const usage = inspector?.usage;
    if (!usage) return null;
    const cached = usage.cacheReadTokens ?? 0;
    const prompt = usage.inputTokens + cached + (usage.cacheWriteTokens ?? 0);
    if (cached <= 0 || prompt <= 0) return null;
    return Math.round((cached / prompt) * 100);
  }, [inspector]);

  if (percent === null) return null;
  return (
    <span className="statusbar-metric">
      <span className="statusbar-label">{t("statusBar.cache")}</span>
      <span className="statusbar-value">{percent}%</span>
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
