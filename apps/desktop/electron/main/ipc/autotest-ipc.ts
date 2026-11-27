import { IPC, type AutotestWorkbenchSnapshot } from "@pi-workspace/shared";
import { autotestWorkbenchUrl } from "../../autotest/window";
import type { AutotestWorkbenchView, WorkbenchBounds } from "../../autotest/workbench-view";
import { isWorkbenchTheme } from "../../autotest/workbench-theme";
import type { AutotestService } from "../../autotest/service";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "./types";

/**
 * The AutoTest surface's channels.
 *
 * The renderer owns *where* the workbench sits and *when* it is visible; main
 * owns the service and the one `WebContentsView`, because a native view always
 * draws above renderer content. Every answer here is the same snapshot shape, so
 * the surface has one state machine instead of a set of flags that can disagree.
 *
 * `attach` starts the service when it is stopped: reaching the surface is itself
 * the first use, exactly as opening the old detached window was.
 */
export type AutotestIpcDependencies = {
  registrar: IpcRegistrar;
  service: AutotestService;
  view: AutotestWorkbenchView;
  /** The detached window the application menu opens, reused by the surface. */
  openWindow: () => void;
  logger?: Pick<Logger, "app">;
};

function normalizeBounds(value: unknown): WorkbenchBounds | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const read = (key: string): number | null => {
    const candidate = raw[key];
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : null;
  };
  const x = read("x");
  const y = read("y");
  const width = read("width");
  const height = read("height");
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

/** The renderer's resolved theme, or null when it sent nothing usable. */
function themeFrom(value: unknown): "light" | "dark" | null {
  if (!value || typeof value !== "object") return null;
  const theme = (value as { theme?: unknown }).theme;
  return isWorkbenchTheme(theme) ? theme : null;
}

export function registerAutotestIpc({
  registrar,
  service,
  view,
  openWindow,
  logger,
}: AutotestIpcDependencies): void {
  const snapshot = (): AutotestWorkbenchSnapshot => {
    const state = service.state();
    return {
      status: state.status,
      // A port from a previous run is not an address: only a ready service has one.
      port: state.status === "ready" ? state.port : null,
      error: state.error,
    };
  };

  registrar.handle(IPC.invoke.autotestWorkbenchStatus, async () => snapshot());

  registrar.handle(IPC.invoke.autotestWorkbenchAttach, async (raw: unknown) => {
    // The surface is the only caller that knows the window's resolved theme; the
    // page cannot read it across processes.
    const theme = themeFrom(raw);
    if (theme) view.applyTheme(theme);
    if (service.state().status === "stopped") {
      await service.ensureStarted();
    }
    const current = snapshot();
    const url = autotestWorkbenchUrl(current.port);
    const bounds = view.lastBounds();
    // A rect from an earlier visit still describes the pane: place the page as
    // soon as it is attachable instead of waiting for a resize event.
    if (current.status === "ready" && url && bounds) view.show(url, bounds);
    if (current.status === "failed") {
      logger?.app(
        "runtime",
        "warn",
        `[autotest] surface could not start the service: ${current.error}`,
      );
    }
    return current;
  });

  registrar.handleWithEvent(
    IPC.invoke.autotestWorkbenchBounds,
    async (_event, raw: unknown) => {
      const bounds = normalizeBounds(raw);
      if (!bounds) return;
      const url = autotestWorkbenchUrl(service.state().port);
      if (service.state().status !== "ready" || !url) return;
      // `show` attaches when it is not attached yet, so the first measurement
      // after a start is also what puts the view on screen.
      view.show(url, bounds);
    },
  );

  registrar.handle(IPC.invoke.autotestWorkbenchDetach, async () => {
    view.hide();
  });

  registrar.handle(IPC.invoke.autotestWorkbenchRestart, async () => {
    await service.restart();
    // The page may have been loaded from a port the restarted service dropped.
    view.reload();
    return snapshot();
  });

  registrar.handle(IPC.invoke.autotestWorkbenchOpenWindow, async () => {
    openWindow();
  });
}
