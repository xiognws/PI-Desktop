import { type CSSProperties, lazy, Suspense, useEffect } from "react";
import { ConversationTopbar } from "../../../components/ConversationTopbar";
import {
  IconNewSession,
  IconPanel,
  IconPanelOpen,
} from "../../../components/icons";
import { Sidebar } from "../../../components/Sidebar";
import { cx, TooltipButton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { lazyRoute } from "../../../lib/lazy-retry";
import { PortalVisibilityProvider } from "../../../lib/portal-visibility";
import { workPanelLayout } from "../../../lib/work-panel-resize";
import { CollapsedTitlebarActions, RoutePending } from "../../app/chrome";
import type { SurfaceShellProps } from "../registry";

/**
 * The chat surface: the home interface of the window.
 *
 * It keeps the shell this product has always had — sessions and projects in the
 * sidebar, one destination in the main pane, the optional work panel — and it is
 * the only surface that owns a work panel, a sidebar width, or a composer.
 *
 * It is also the surface that never unmounts: switching to another interface
 * hides it (`hidden` + `inert`, the same treatment the Settings takeover uses),
 * so a running turn, the work panel's tab set, the transcript's reading position
 * and the composer draft survive the trip untouched.
 *
 * Window-level overlays do not live here. Search, toasts, the update banner and
 * the Settings takeover stay in `AppShell`: they must be able to cover whichever
 * surface is on screen, and a dialog rendered inside a hidden shell is not.
 */

const ScheduledPage = lazy(
  lazyRoute(() =>
    import("../../../pages/ScheduledPage").then((module) => ({
      default: module.ScheduledPage,
    })),
  ),
);
const PluginsPage = lazy(
  lazyRoute(() =>
    import("../../../pages/PluginsPage").then((module) => ({
      default: module.PluginsPage,
    })),
  ),
);
const ArtifactsPage = lazy(
  lazyRoute(() =>
    import("../../../pages/ArtifactsPage").then((module) => ({
      default: module.ArtifactsPage,
    })),
  ),
);
const ToolsPage = lazy(
  lazyRoute(() =>
    import("../../../pages/ToolsPage").then((module) => ({
      default: module.ToolsPage,
    })),
  ),
);
const loadChatSurface = () => import("../../../components/ChatSurface");
const ChatSurface = lazy(() =>
  lazyRoute(loadChatSurface)().then((module) => ({
    default: module.ChatSurface,
  })),
);
const loadWorkPanel = () => import("../../../components/workpanel/WorkPanel");
const WorkPanel = lazy(() =>
  lazyRoute(loadWorkPanel)().then((module) => ({ default: module.WorkPanel })),
);

export function ChatSurfaceShell({ runtime }: SurfaceShellProps) {
  const {
    t,
    ready,
    page,
    surface,
    activeSessionId,
    workPanelOpen,
    searchOpen,
    setSearchOpen,
    sidebarCollapsed,
    sidebarEntering,
    sidebarExiting,
    sidebarWidth,
    sidebarWidthMax,
    handleSidebarWidthChange,
    handleSidebarWidthCommit,
    handleSidebarResizeCollapse,
    toggleSidebar,
    reopenSidebar,
    autoCollapseSidebar,
    contentWidth,
    runMenuCommand,
    handleSidebarAnimationEnd,
    presentedWorkPanelOpen,
    workPanelExiting,
    workPanelExitGeneration,
    finishWorkPanelExit,
    togglePresentedWorkPanel,
    workPanelMaximized,
    toggleWorkPanelMaximize,
    sidebarToggleShortcut,
    workPanelToggleTooltip,
    requestedWorkPanelWidth,
  } = runtime;

  useEffect(() => {
    void loadChatSurface().catch((error: unknown) => {
      console.error("Failed to preload the chat surface", error);
    });
  }, []);

  useEffect(() => {
    if (!ready || page !== "chat" || !workPanelOpen) return;
    void loadWorkPanel().catch((error: unknown) => {
      console.error("Failed to preload the work panel", error);
    });
  }, [page, ready, workPanelOpen]);

  const pendingWorkPanelWidth = workPanelLayout({
    containerWidth: contentWidth,
    sidebarWidth,
    sidebarCollapsed,
    requestedPanelWidth: requestedWorkPanelWidth,
    maximized: workPanelMaximized,
  }).panelWidth;

  // Settings takes over the window and another surface owns it while active;
  // in both cases chat stays mounted but must not answer input.
  const hidden = page === "settings" || surface !== "chat";

  return (
    <PortalVisibilityProvider visible={!hidden}>
      <div
        className="app-chat-shell"
        hidden={hidden}
        inert={hidden ? true : undefined}
      >
        {!sidebarCollapsed || sidebarExiting ? (
          <Sidebar
            className={cx(sidebarEntering && "is-entering", sidebarExiting && "is-exiting")}
            onAnimationEnd={handleSidebarAnimationEnd}
            onToggleSidebar={toggleSidebar}
            sidebarToggleShortcut={sidebarToggleShortcut}
            sidebarWidth={sidebarWidth}
            widthMax={sidebarWidthMax}
            onWidthChange={handleSidebarWidthChange}
            onWidthCommit={handleSidebarWidthCommit}
            onResizeCollapse={handleSidebarResizeCollapse}
          />
        ) : null}

        {workPanelMaximized && (
          /* MainChat is absent; the panel header owns dragging while this
             pass-through row keeps the shell controls available. */
          <div
            className={cx(
              "window-chrome-row",
              !sidebarCollapsed && "sidebar-expanded",
            )}
          >
            {sidebarCollapsed && (
              <CollapsedTitlebarActions
                onToggleSidebar={toggleSidebar}
                onNewTask={() => void runMenuCommand("newTask")}
                sidebarToggleShortcut={sidebarToggleShortcut}
              />
            )}
            {!sidebarCollapsed && (
              <TooltipButton
                type="button"
                className="title-nav-btn"
                tooltip={t("nav.newTask")}
                ariaLabel={t("nav.newTask")}
                data-nav="new-task"
                onClick={() => void runMenuCommand("newTask")}
              >
                <IconNewSession size={15} />
              </TooltipButton>
            )}
            <div className="window-chrome-drag" aria-hidden />
          </div>
        )}

        {!workPanelMaximized && (
          <section className="main-pane">
            {page === "chat" ? (
              <ConversationTopbar
                sidebarCollapsed={sidebarCollapsed}
                workPanelOpen={presentedWorkPanelOpen}
                onToggleSidebar={toggleSidebar}
                onNewTask={() => void runMenuCommand("newTask")}
                onOpenSearch={() => setSearchOpen(true)}
              />
            ) : (
              <div
                className={cx(
                  "main-titlebar",
                  presentedWorkPanelOpen && "work-panel-open",
                )}
              >
                {sidebarCollapsed && (
                  <div className="main-titlebar-left no-drag">
                    <CollapsedTitlebarActions
                      onToggleSidebar={reopenSidebar}
                      onNewTask={() => void runMenuCommand("newTask")}
                      sidebarToggleShortcut={sidebarToggleShortcut}
                    />
                  </div>
                )}
              </div>
            )}

            <Suspense fallback={<RoutePending />}>
              {page === "scheduled" ? (
                <div className="route-surface route-page">
                  <ScheduledPage />
                </div>
              ) : page === "plugins" ? (
                <div className="route-surface route-page">
                  <PluginsPage />
                </div>
              ) : page === "artifacts" ? (
                <div className="route-surface route-page">
                  <ArtifactsPage />
                </div>
              ) : page === "tools" ? (
                <div className="route-surface route-page">
                  <ToolsPage />
                </div>
              ) : (
                <ChatSurface visible={page === "chat"} />
              )}
            </Suspense>
          </section>
        )}

        {(presentedWorkPanelOpen || workPanelExiting) && (
          <Suspense
            fallback={
              <aside
                className="work-panel work-panel-pending"
                role="status"
                aria-label={t("app.loadingView")}
                style={
                  {
                    "--work-panel-width": `${pendingWorkPanelWidth}px`,
                  } as CSSProperties
                }
              >
                <span className="route-pending-indicator" aria-hidden />
              </aside>
            }
          >
            <WorkPanel
              panelBlocked={searchOpen}
              exiting={workPanelExiting}
              onExitAnimationEnd={() =>
                finishWorkPanelExit(workPanelExitGeneration.current)
              }
              containerWidth={contentWidth}
              sidebarWidth={sidebarWidth}
              sidebarCollapsed={sidebarCollapsed}
              sidebarExiting={sidebarExiting}
              onAutoCollapseSidebar={autoCollapseSidebar}
              maximized={workPanelMaximized}
              onToggleMaximize={toggleWorkPanelMaximize}
            />
          </Suspense>
        )}

        <TooltipButton
          type="button"
          className="app-work-panel-toggle no-drag"
          tooltip={workPanelToggleTooltip}
          ariaLabel={workPanelToggleTooltip}
          aria-pressed={workPanelOpen || presentedWorkPanelOpen}
          disabled={!activeSessionId && !presentedWorkPanelOpen && !workPanelExiting}
          onClick={togglePresentedWorkPanel}
        >
          <span className="app-work-panel-toggle-icon" aria-hidden>
            <IconPanel size={15} />
            <IconPanelOpen size={15} />
          </span>
        </TooltipButton>
      </div>
    </PortalVisibilityProvider>
  );
}
