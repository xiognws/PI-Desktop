import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutotestWorkbenchSnapshot } from "@pi-workspace/shared";
import { Button, cx, TooltipButton } from "../../../components/ui";
import { IconChevronRight, IconSidebar } from "../../../components/icons";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import type { SurfaceShellProps } from "../registry";

/**
 * The AutoTest surface.
 *
 * The workbench is not a React application — it is a Vue app served by the local
 * FastAPI service the main process supervises — so this surface composites it
 * instead of reimplementing it: it reserves a pane, measures it, and asks main
 * to place the `WebContentsView` there. That is the same seam the plugin work
 * panel uses for its docked views.
 *
 * Three rules follow from "a WebContentsView draws above renderer content":
 *
 * 1. the renderer owns visibility — the view is detached whenever this surface
 *    is not on screen, Settings takes the window, or a blocking overlay opens;
 * 2. the pane keeps a native placeholder underneath, so a slow start or a failed
 *    service is explained instead of leaving a hole;
 * 3. detaching hides rather than destroys, so switching interfaces and coming
 *    back leaves the workbench where the user left it.
 *
 * The sidebar column is the surface's own: the chat sidebar is keyed by
 * conversations, and a test platform navigates by tests, plans and runs.
 */

/** Re-check a failed service without the user having to click anything. */
const FAILED_RETRY_MS = 25_000;

/**
 * The window's resolved palette.
 *
 * The shell publishes it on `<html data-theme>`; the workbench page lives in its
 * own process, so this is what crosses the boundary. Falling back to the OS
 * preference keeps the first paint correct before the attribute exists.
 */
function resolvedTheme(): "light" | "dark" {
  const declared = document.documentElement.dataset.theme;
  if (declared === "light" || declared === "dark") return declared;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function AutoTestSurfaceShell({ overlaysOpen, runtime }: SurfaceShellProps) {
  const { t } = useTranslation();
  const surface = useAppStore((s) => s.surface);
  const page = useAppStore((s) => s.page);
  const collapsed = useAppStore((s) => s.autotestSidebarCollapsed);
  const setCollapsed = useAppStore((s) => s.setAutotestSidebarCollapsed);
  const active = surface === "autotest" && page !== "settings";
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<AutotestWorkbenchSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const attach = useCallback(async () => {
    setBusy(true);
    try {
      setSnapshot(await api.autotestWorkbenchAttach({ theme: resolvedTheme() }));
    } catch (error) {
      setSnapshot({
        status: "failed",
        port: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const measure = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    void api
      .autotestWorkbenchBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })
      .catch(() => undefined);
  }, []);

  // Show while this surface owns the window; hide the moment it does not. An
  // overlay also hides it, because the view would otherwise paint over the
  // dialog instead of behind it. The cleanup matters as much as the branch: this
  // component unmounts when another surface takes over, and a native view left
  // attached would keep drawing the workbench over that surface.
  const visible = active && !overlaysOpen;
  useEffect(() => {
    if (!visible) {
      void api.autotestWorkbenchDetach().catch(() => undefined);
      return;
    }
    void attach().then(() => requestAnimationFrame(measure));
    return () => {
      // surface.unmounted.detach — one marker, so the packaged bundle can be
      // checked for this behaviour without reading the whole chunk.
      void api.autotestWorkbenchDetach().catch(() => undefined);
    };
  }, [attach, measure, visible]);

  // The view is positioned from a measured rect, so it follows resizes.
  useEffect(() => {
    if (!visible || snapshot?.status !== "ready") return;
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(pane);
    return () => observer.disconnect();
  }, [measure, snapshot?.status, visible]);

  useEffect(() => {
    if (!visible || snapshot?.status !== "failed") return;
    const timer = window.setTimeout(() => void attach(), FAILED_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [attach, snapshot?.status, visible]);

  // Following the window's theme is a re-attach, not a reload: the same view is
  // re-shown, and main hands it the other palette.
  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => void attach());
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [attach, visible]);

  const restart = async () => {
    setBusy(true);
    try {
      setSnapshot(await api.autotestWorkbenchRestart());
    } catch (error) {
      setSnapshot({
        status: "failed",
        port: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const state = snapshot?.status ?? "starting";

  const serviceLabel =
    state === "ready"
      ? t("autotest.surface.ready", { port: snapshot?.port ?? "?" })
      : state === "failed"
        ? t("autotest.surface.failed")
        : t("autotest.surface.starting");
  // The shortcut is the chat sidebar's, because it is the same key: it collapses
  // whichever interface is on screen.
  const toggleShortcut = runtime.sidebarToggleShortcut;
  const withShortcut = (label: string) =>
    toggleShortcut ? `${label} (${toggleShortcut})` : label;
  const collapseTooltip = withShortcut(t("nav.collapseSidebar"));
  const expandTooltip = withShortcut(t("nav.expandSidebar"));

  return (
    <div
      className="app-surface-autotest"
      hidden={!active}
      inert={!active ? true : undefined}
    >
      <aside className={cx("autotest-sidebar no-drag", collapsed && "is-collapsed")}>
        {collapsed ? (
          /* The folded column keeps two things reachable: the way back out, and
             the service's state. Everything else is one keystroke away. */
          <div className="autotest-sidebar-rail">
            <TooltipButton
              type="button"
              className="autotest-sidebar-toggle"
              tooltip={expandTooltip}
              ariaLabel={t("nav.expandSidebar")}
              aria-expanded={false}
              data-nav="autotest-expand-sidebar"
              onClick={() => setCollapsed(false)}
            >
              <IconChevronRight size={15} />
            </TooltipButton>
            <span
              className="autotest-service-dot"
              data-state={state}
              title={serviceLabel}
              aria-label={serviceLabel}
              role="status"
            />
          </div>
        ) : (
          <>
            <div className="autotest-sidebar-header">
              <span className="autotest-sidebar-title">{t("surface.autotest")}</span>
              <TooltipButton
                type="button"
                className="autotest-sidebar-toggle"
                tooltip={collapseTooltip}
                ariaLabel={t("nav.collapseSidebar")}
                aria-expanded
                data-nav="autotest-collapse-sidebar"
                onClick={() => setCollapsed(true)}
              >
                <IconSidebar size={15} />
              </TooltipButton>
            </div>
            <div className="autotest-sidebar-body">
              <div className="autotest-service" data-state={state}>
                <span className="autotest-service-dot" aria-hidden />
                <span className="autotest-service-label">{serviceLabel}</span>
              </div>
              {state === "failed" && snapshot?.error ? (
                <p className="autotest-service-detail">{snapshot.error}</p>
              ) : null}
              <div className="autotest-sidebar-actions">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void restart()}
                >
                  {t("autotest.surface.restart")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void api.autotestWorkbenchOpenWindow()}
                >
                  {t("autotest.surface.openWindow")}
                </Button>
              </div>
            </div>
          </>
        )}
      </aside>
      <section className="autotest-main-pane">
        {/* One chrome, not two: once the workbench is up its own header owns the
            top band, so this titlebar only stands in while it is not. */}
        {state === "ready" ? null : (
          <header className="autotest-titlebar no-drag">
            <span className="autotest-titlebar-title">
              {t("autotest.surface.title")}
            </span>
          </header>
        )}
        <div ref={paneRef} className="autotest-pane" data-state={state}>
          {state === "ready" ? null : (
            <div className="autotest-pane-placeholder" role="status">
              <p className="autotest-pane-heading">
                {state === "failed"
                  ? t("autotest.surface.failedTitle")
                  : t("autotest.surface.startingTitle")}
              </p>
              <p className="autotest-pane-detail">
                {state === "failed"
                  ? snapshot?.error || t("autotest.surface.failedDetail")
                  : t("autotest.surface.startingDetail")}
              </p>
              {state === "failed" ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void restart()}
                >
                  {t("autotest.surface.restart")}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
