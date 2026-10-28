import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { latestTurnContextInspector } from "../lib/latest-turn-context";
import {
  calculateContextUsage,
  contextUsageView,
  resolveContextUsageDisplay,
} from "../lib/context-usage";
import { compactTokens, formatElapsed } from "../lib/status-bar";
import { IPC } from "@pi-desktop/shared/protocol";
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

/** Throughput of the newest completed response, or 0 before the first one. */
function useThroughput(inspector: ReturnType<typeof latestTurnContextInspector>) {
  return useMemo(() => {
    const tokens = inspector?.responseOutputTokens ?? 0;
    const ms = inspector?.responseDurationMs ?? 0;
    if (tokens <= 0 || ms <= 0) return 0;
    return Math.round((tokens / ms) * 1000);
  }, [inspector]);
}

/** Cache reads as a share of the prompt actually sent, when reported. */
function useCachePercent(inspector: ReturnType<typeof latestTurnContextInspector>) {
  return useMemo(() => {
    const usage = inspector?.usage;
    if (!usage) return null;
    const cached = usage.cacheReadTokens ?? 0;
    const prompt = usage.inputTokens + cached + (usage.cacheWriteTokens ?? 0);
    if (cached <= 0 || prompt <= 0) return null;
    return Math.round((cached / prompt) * 100);
  }, [inspector]);
}

/**
 * `上下文 [██████░░░░] 61% 42.1k/128k · 38 t/s · 72% 缓存` — one button, and the
 * click opens the composer's own context panel (used/left, cache, throughput,
 * per-tool tokens, timing). Sharing that component is what keeps the two
 * surfaces from ever disagreeing about the same session.
 */
export function StatusBarMetrics() {
  const { t } = useTranslation();
  const inspector = useTurnInspector();
  const displayMode = useAppStore((s) => s.settings?.contextUsageDisplay);
  const throughput = useThroughput(inspector);
  const cachePercent = useCachePercent(inspector);

  // The % follows the user's used/remaining preference, but the bar and the
  // absolute pair always describe *occupancy*: a bar that shrinks as the window
  // fills is unreadable, and "1.0M/1.0M" for an almost empty session is worse.
  const usage = useMemo(
    () => (inspector ? calculateContextUsage(inspector.usage, inspector.contextWindow) : null),
    [inspector],
  );
  const view = useMemo(
    () => (usage ? contextUsageView(usage, resolveContextUsageDisplay(displayMode)) : null),
    [usage, displayMode],
  );

  if (!inspector || !usage || !view) return null;
  const window_ = inspector.contextWindow > 0 ? inspector.contextWindow : 0;
  const mode = resolveContextUsageDisplay(displayMode);
  const percentWord = mode === "used" ? t("statusBar.used") : t("statusBar.left");
  return (
    <span className="statusbar-metric statusbar-clickable">
      <ContextUsageInspector
        {...inspector}
        trigger={
          <>
            <span className="statusbar-label">{t("statusBar.context")}</span>
            <span
              className="statusbar-bar"
              role="img"
              aria-label={`${usage.usedPercent}%`}
            >
              <span
                className="statusbar-bar-fill"
                style={{ width: `${Math.max(2, usage.usedPercent)}%` }}
              />
            </span>
            <span className="statusbar-value">
              {view.percent}% {percentWord}
            </span>
            <span className="statusbar-aside">
              {compactTokens(usage.usedTokens)}
              {window_ > 0 ? `/${compactTokens(window_)}` : ""}
            </span>
          </>
        }
      />
    </span>
  );
}

/** `计划 3` — enabled scheduled tasks, refreshed slowly; clicking opens them. */
export function StatusBarScheduled() {
  const { t } = useTranslation();
  const setPage = useAppStore((s) => s.setPage);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await window.piDesktop?.invoke(IPC.invoke.scheduledList);
        const tasks = result?.ok ? (result.data as Array<{ enabled?: boolean }>) : undefined;
        if (!cancelled && Array.isArray(tasks)) {
          setCount(tasks.filter((task) => task.enabled !== false).length);
        }
      } catch {
        // The status bar is a side channel: a failed poll keeps the last count.
      }
    };
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!count) return null;
  return (
    <button
      type="button"
      className="statusbar-metric statusbar-button"
      onClick={() => setPage("scheduled")}
      title={t("statusBar.scheduled")}
    >
      <span className="statusbar-label">{t("statusBar.scheduled")}</span>
      <span className="statusbar-value">{count}</span>
    </button>
  );
}

/** `本会话 12:03` — how long ago the active conversation was created. */
export function StatusBarSessionAge() {
  const { t } = useTranslation();
  const activeId = useAppStore((s) => s.activeSessionId);
  const createdAt = useAppStore((s) =>
    s.activeSessionId
      ? s.sessions.find((session) => session.id === s.activeSessionId)?.createdAt
      : undefined,
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!createdAt) return;
    const timer = setInterval(() => setTick((value) => value + 1), 30000);
    return () => clearInterval(timer);
  }, [createdAt]);

  if (!activeId || !createdAt) return null;
  const startedAt = new Date(createdAt).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return (
    <span className="statusbar-metric" title={new Date(startedAt).toLocaleString()}>
      <span className="statusbar-label">{t("statusBar.sessionAge")}</span>
      <span className="statusbar-value">{formatElapsed(Date.now() - startedAt)}</span>
    </span>
  );
}

/** `38 t/s` — throughput of the newest completed response. Click = same panel. */
export function StatusBarSpeed() {
  const { t } = useTranslation();
  const inspector = useTurnInspector();
  const throughput = useThroughput(inspector);
  if (!inspector || throughput <= 0) return null;
  return (
    <span className="statusbar-metric statusbar-clickable">
      <ContextUsageInspector
        {...inspector}
        trigger={
          <>
            <span className="statusbar-label">{t("statusBar.speed")}</span>
            <span className="statusbar-value">{throughput} t/s</span>
          </>
        }
      />
    </span>
  );
}

/** `72% 缓存` — cache reads as a share of the prompt. Click = same panel. */
export function StatusBarCache() {
  const { t } = useTranslation();
  const inspector = useTurnInspector();
  const cachePercent = useCachePercent(inspector);
  if (!inspector || cachePercent === null) return null;
  return (
    <span className="statusbar-metric statusbar-clickable">
      <ContextUsageInspector
        {...inspector}
        trigger={
          <>
            <span className="statusbar-label">{t("statusBar.cache")}</span>
            <span className="statusbar-value">{cachePercent}%</span>
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
