import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutotestWorkbenchSnapshot } from "@pi-workspace/shared";
import { Button, cx, TooltipButton } from "../../../components/ui";
import { IconChevronRight, IconSidebar } from "../../../components/icons";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import type { SurfaceShellProps } from "../registry";
import { AUTOTEST_PIPELINE } from "./pipeline";

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
 * What this surface learns goes to the store, not into local state: the service
 * and the page's route are facts the window's status bar reads too, and a switch
 * away must not leave two versions of them. The column is navigation only — the
 * environment strip belongs to the window.
 */

/** Re-check a failed service without the user having to click anything. */
const FAILED_RETRY_MS = 25_000;

/** How often the surface re-reads the page's route, to keep the menu honest. */
const LOCATION_POLL_MS = 1_500;

/** `/project/<id>/<view>` → id and view; `/` → neither. */
function parseLocation(path: string): { projectId: string; view: string } {
  const match = /^\/project\/([^/]+)(?:\/([^/?#]+))?/.exec(path);
  if (!match) return { projectId: "", view: "" };
  return { projectId: decodeURIComponent(match[1]), view: match[2] ?? "" };
}

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
  const service = useAppStore((s) => s.autotestService);
  const setService = useAppStore((s) => s.setAutotestService);
  const route = useAppStore((s) => s.autotestRoute);
  const setRoute = useAppStore((s) => s.setAutotestRoute);
  const active = surface === "autotest" && page !== "settings";
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);

  // One place turns the bridge's answer into window state, so attach, restart and
  // the failure path cannot disagree about what they publish.
  const publish = useCallback(
    (snapshot: AutotestWorkbenchSnapshot) => {
      setService({
        status: snapshot.status === "stopped" ? "idle" : snapshot.status,
        port: snapshot.port ?? undefined,
        error: snapshot.error || undefined,
      });
    },
    [setService],
  );

  const fail = useCallback(
    (error: unknown) => {
      setService({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    },
    [setService],
  );

  const attach = useCallback(async () => {
    setBusy(true);
    try {
      publish(await api.autotestWorkbenchAttach({ theme: resolvedTheme() }));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }, [fail, publish]);

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

  // Nothing has asked the service anything yet is one answer away from starting,
  // so an idle row reads as starting here and everywhere else that reads it.
  const state = service.status === "idle" ? "starting" : service.status;

  // The view is positioned from a measured rect, so it follows resizes.
  useEffect(() => {
    if (!visible || state !== "ready") return;
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(pane);
    return () => observer.disconnect();
  }, [measure, state, visible]);

  useEffect(() => {
    if (!visible || state !== "failed") return;
    const timer = window.setTimeout(() => void attach(), FAILED_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [attach, state, visible]);

  // Following the window's theme is a re-attach, not a reload: the same view is
  // re-shown, and main hands it the other palette.
  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => void attach());
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [attach, visible]);

  // The page can move on its own (a project card opens its pipeline), so the menu
  // follows the page rather than assuming the click that started it.
  useEffect(() => {
    if (!visible || state !== "ready") return;
    let cancelled = false;
    const read = () => {
      void api
        .autotestWorkbenchLocation()
        .then((result) => {
          if (cancelled) return;
          const next = parseLocation(result.path);
          setRoute({ projectId: next.projectId, view: next.view });
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, LOCATION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setRoute, state, visible]);

  const { projectId, view } = route;

  // The project name for the top band: only the service knows it, and it is on
  // loopback with permissive CORS, so the surface asks it directly.
  useEffect(() => {
    if (!projectId || !service.port) {
      setRoute({ projectName: "" });
      return;
    }
    let cancelled = false;
    const port = service.port;
    void fetch(`http://127.0.0.1:${port}/api/projects`)
      .then((response) => response.json())
      .then((payload: { projects?: { id: string; name: string }[] }) => {
        if (cancelled) return;
        setRoute({
          projectName:
            payload.projects?.find((item) => item.id === projectId)?.name ?? "",
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, service.port, setRoute]);

  const go = async (target: string) => {
    const result = await api.autotestWorkbenchNavigate(target).catch(() => null);
    if (!result) return;
    const next = parseLocation(result.path);
    setRoute({ projectId: next.projectId, view: next.view });
  };

  const restart = async () => {
    setBusy(true);
    try {
      publish(await api.autotestWorkbenchRestart());
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const serviceLabel =
    state === "ready"
      ? t("autotest.surface.ready", { port: service.port ?? "?" })
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
              <span className="autotest-sidebar-title">{t("autotest.surface.title")}</span>
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
              {/* The workbench's pipeline, drawn here because its page cannot
                  reach this column. With no project open there is nothing to
                  navigate, so the menu waits for one. The service's own state is
                  not repeated here: the window's status bar and the band above
                  this pane carry it. */}
              {/* The pipeline, always visible: the column is where the work is
                  ordered, and a menu that appears only once a project exists
                  reads as an empty sidebar. Without one the steps stay inert. */}
              <nav className="autotest-nav" data-nav="autotest-menu">
                  {AUTOTEST_PIPELINE.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      className={cx("autotest-nav-item", view === item.path && "is-active")}
                      data-nav={`autotest-nav-${item.path}`}
                      aria-current={view === item.path ? "page" : undefined}
                      aria-disabled={projectId ? undefined : true}
                      onClick={() => projectId && void go(`/project/${projectId}/${item.path}`)}
                    >
                      <span className="autotest-nav-step">{item.step}</span>
                      <span>{item.name}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="autotest-nav-item is-back"
                    data-nav="autotest-nav-home"
                    onClick={() => void go("/")}
                  >
                    全部项目
                  </button>
                </nav>
              {/* The service's controls live at the foot of the column, not in the
                  middle of it: they are maintenance, not workflow. */}
              <div className="autotest-sidebar-footer">
                <button
                  type="button"
                  className="autotest-footer-action"
                  data-nav="autotest-restart-service"
                  disabled={busy}
                  onClick={() => void restart()}
                >
                  {t("autotest.surface.restart")}
                </button>
              </div>
            </div>
          </>
        )}
      </aside>
      <section className="autotest-main-pane">
        {/* The window's top band, at the chat surface's height. The page's own
            title bar is suppressed, so the drag region, the window buttons and
            the status bar below keep the positions users already know. It says
            two things only: which project, and whether the service is up. */}
        <header className="autotest-topbar no-drag">
          <span className="autotest-topbar-title">
            {route.projectName || t("surface.autotest")}
          </span>
          <span className="autotest-topbar-state" data-state={state}>
            {serviceLabel}
          </span>
        </header>
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
                  ? service.error || t("autotest.surface.failedDetail")
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
