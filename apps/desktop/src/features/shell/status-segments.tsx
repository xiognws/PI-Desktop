import { useTranslation } from "react-i18next";
import { pendingPermissionsCount, runningSessionsCount } from "../../lib/status-bar";
import { useAppStore } from "../../stores/app-store";
import { AUTOTEST_PIPELINE, autotestPipelineStep } from "../surfaces/autotest/pipeline";

/**
 * The status bar's segments that are not already leaf components.
 *
 * Each one reads its own slice of the store and returns `null` when it has
 * nothing true to say — an absent segment beats a placeholder in a 30px band.
 * They are components rather than render callbacks so a hook belongs to the
 * segment that uses it, and a running turn still repaints two spans instead of
 * the whole bar.
 */

/** The project the chat surface is in; nothing to say until one is open. */
export function ChatProjectSegment() {
  const { t } = useTranslation();
  const workspace = useAppStore((s) => s.workspace);
  if (!workspace?.name) return null;
  return (
    <span className="statusbar-metric" title={workspace.path}>
      <span className="statusbar-label">{t("statusBar.project")}</span>
      <span className="statusbar-value">{workspace.name}</span>
    </span>
  );
}

/**
 * More than one conversation running at once.
 *
 * A single running session already owns the elapsed timer; this row exists to
 * say "and others too", which the timer cannot.
 */
export function ChatRunningSegment() {
  const { t } = useTranslation();
  const running = useAppStore((s) => s.runningSessions);
  const count = runningSessionsCount(running);
  if (count <= 1) return null;
  return (
    <span className="statusbar-metric">
      <span className="statusbar-value">
        {t("statusBar.running")} {count}
      </span>
    </span>
  );
}

/** Approval cards waiting anywhere in the window, in the warning colour. */
export function ChatPendingSegment() {
  const { t } = useTranslation();
  const pending = useAppStore((s) => s.pendingPermissions);
  const count = pendingPermissionsCount(pending);
  if (count <= 0) return null;
  return (
    <span className="statusbar-metric statusbar-metric-warn">
      <span className="statusbar-value">
        {t("statusBar.pending")} {count}
      </span>
    </span>
  );
}

/**
 * The local test service, in the words the surface's own placeholder uses.
 *
 * `idle` reads as starting: the window has not heard from main yet, and the
 * first attach is already on its way.
 */
export function AutotestServiceSegment() {
  const { t } = useTranslation();
  const service = useAppStore((s) => s.autotestService);
  const state = service.status === "idle" ? "starting" : service.status;
  const value =
    state === "ready"
      ? t("autotest.surface.ready", { port: service.port ?? "?" })
      : state === "failed"
        ? t("autotest.surface.failed")
        : t("autotest.surface.starting");
  return (
    <span
      className="statusbar-metric"
      title={state === "failed" ? service.error : undefined}
    >
      <span className="statusbar-label">{t("statusBar.service")}</span>
      <span className="statusbar-value">{value}</span>
    </span>
  );
}

/** The project the workbench page is showing, once its route names one. */
export function AutotestProjectSegment() {
  const { t } = useTranslation();
  const projectName = useAppStore((s) => s.autotestRoute.projectName);
  if (!projectName) return null;
  return (
    <span className="statusbar-metric">
      <span className="statusbar-label">{t("statusBar.project")}</span>
      <span className="statusbar-value">{projectName}</span>
    </span>
  );
}

/**
 * Which of the seven stages the page is on.
 *
 * The page's route is the only progress signal that exists — it is polled, not
 * inferred — so a route that is not a stage (the project list, a detail view)
 * simply has no step to report.
 */
export function AutotestPipelineSegment() {
  const { t } = useTranslation();
  const view = useAppStore((s) => s.autotestRoute.view);
  const step = autotestPipelineStep(view);
  if (!step) return null;
  const total = String(AUTOTEST_PIPELINE.length).padStart(2, "0");
  return (
    <span className="statusbar-metric">
      <span className="statusbar-label">{t("statusBar.pipeline")}</span>
      <span className="statusbar-value">
        {step.step}/{total}
      </span>
    </span>
  );
}
