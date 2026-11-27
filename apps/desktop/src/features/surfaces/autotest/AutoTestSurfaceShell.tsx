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

/** How often the surface re-reads the page's route, to keep the menu honest. */
const LOCATION_POLL_MS = 1_500;

/**
 * The workbench's menu, mirrored from `ProjectLayout.vue`'s `NAV`.
 *
 * It is duplicated on purpose: the page cannot render into this window's sidebar,
 * so the labels live here and each click drives the page's router through the
 * navigate channel.
 */
const NAV: { group: string; items: { path: string; name: string }[] }[] = [
  {
    group: "流程",
    items: [
      { path: "pipeline", name: "流水线" },
      { path: "runs", name: "运行记录" },
      { path: "approvals", name: "待审批" },
    ],
  },
  {
    group: "产物",
    items: [
      { path: "cases", name: "用例" },
      { path: "scripts", name: "脚本" },
    ],
  },
  {
    group: "结果",
    items: [
      { path: "executions", name: "执行" },
      { path: "reports", name: "报告" },
      { path: "bugs", name: "缺陷" },
    ],
  },
  {
    group: "资料",
    items: [
      { path: "requirements", name: "项目资料" },
      { path: "knowledge", name: "知识库" },
      { path: "contract", name: "被测件契约" },
    ],
  },
  { group: "其他", items: [{ path: "settings", name: "设置" }] },
];

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
  const active = surface === "autotest" && page !== "settings";
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<AutotestWorkbenchSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [location, setLocation] = useState("/");
  const [projectName, setProjectName] = useState("");

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

  // The page can move on its own (a project card opens its pipeline), so the menu
  // follows the page rather than assuming the click that started it.
  useEffect(() => {
    if (!visible || snapshot?.status !== "ready") return;
    let cancelled = false;
    const read = () => {
      void api
        .autotestWorkbenchLocation()
        .then((result) => {
          if (!cancelled) setLocation(result.path);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, LOCATION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [snapshot?.status, visible]);

  // The project name for the top band: only the service knows it, and it is on
  // loopback with permissive CORS, so the surface asks it directly.
  const { projectId, view } = parseLocation(location);
  useEffect(() => {
    if (!projectId || !snapshot?.port) {
      setProjectName("");
      return;
    }
    let cancelled = false;
    const port = snapshot.port;
    void fetch(`http://127.0.0.1:${port}/api/projects`)
      .then((response) => response.json())
      .then((payload: { projects?: { id: string; name: string }[] }) => {
        if (cancelled) return;
        setProjectName(payload.projects?.find((item) => item.id === projectId)?.name ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, snapshot?.port]);

  const go = async (target: string) => {
    const result = await api.autotestWorkbenchNavigate(target).catch(() => null);
    if (result) setLocation(result.path);
  };

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
              {/* The workbench's own menu, drawn here because its page cannot
                  reach this column. With no project open there is nothing to
                  navigate, so the menu waits for one. */}
              {projectId ? (
                <nav className="autotest-nav" data-nav="autotest-menu">
                  {NAV.map((group) => (
                    <div key={group.group} className="autotest-nav-group">
                      <p className="autotest-nav-heading">{group.group}</p>
                      {group.items.map((item) => (
                        <button
                          key={item.path}
                          type="button"
                          className={cx("autotest-nav-item", view === item.path && "is-active")}
                          data-nav={`autotest-nav-${item.path}`}
                          aria-current={view === item.path ? "page" : undefined}
                          onClick={() => void go(`/project/${projectId}/${item.path}`)}
                        >
                          {item.name}
                        </button>
                      ))}
                    </div>
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
              ) : null}
            </div>
          </>
        )}
      </aside>
      <section className="autotest-main-pane">
        {/* The window's top band, at the chat surface's height. The page's own
            title bar is suppressed, so the drag region, the window buttons and
            the status bar below keep the positions users already know. */}
        <header className="autotest-topbar no-drag">
          <span className="autotest-topbar-title">
            {projectName || t("autotest.surface.title")}
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
