import { type CSSProperties, lazy, Suspense } from "react";
import { ExtensionPromptHost } from "../../components/ExtensionPromptDialog";
import { LifecycleConfirmationDialog } from "../../components/LifecycleConfirmationDialog";
import { ProjectCreateDialog } from "../../components/ProjectCreateDialog";
import { SearchDialog } from "../../components/SearchDialog";
import { StartupRecovery } from "../../components/StartupRecovery";
import { ToastHost } from "../../components/Toast";
import { UpdateBanner } from "../../components/UpdateBanner";
import { cx } from "../../components/ui";
import { WindowControls } from "../../components/WindowControls";
import { useCopyTex } from "../../hooks/use-copy-tex";
import { api } from "../../lib/api";
import { lazyRoute } from "../../lib/lazy-retry";
import { PluginRendererHost } from "../../plugins/renderer-host/PluginRendererHost";
import { SurfaceHost } from "../surfaces/SurfaceHost";
import { SurfaceRail } from "../surfaces/SurfaceRail";
import { StatusBar } from "../shell/StatusBar";
import { RoutePending } from "./chrome";
import { useAppShellRuntime } from "./useAppShellRuntime";

/**
 * The window.
 *
 * Three layers, in this order: the surface rail (which interface), the surface
 * itself (its own sidebar and main pane), and the window-level chrome that must
 * be able to cover any of them — the Settings takeover, global search, toasts,
 * the update banner, the backend banners, the dialogs, the splash and the native
 * window controls.
 *
 * Nothing here names an interface. Adding a surface means appending to
 * `SURFACE_IDS` and to `features/surfaces/registry.tsx`; the rail draws it, the
 * shortcuts reach it, search lists it, and the window keeps opening on whichever
 * one the user left.
 */

const SettingsPage = lazy(
  lazyRoute(() =>
    import("../../pages/SettingsPage").then((module) => ({
      default: module.SettingsPage,
    })),
  ),
);

export function AppShell() {
  const runtime = useAppShellRuntime();
  const {
    t,
    ready,
    page,
    searchOpen,
    searchMode,
    setSearchOpen,
    sidebarCollapsed,
    workPanelMaximized,
    backendDown,
    archMismatch,
    setArchMismatch,
    appShellRef,
    sidebarWidth,
    showSplash,
    splash,
    startupPhase,
    startupWaitedMs,
    retryStartup,
    startupRetrying,
  } = runtime;
  useCopyTex();

  // A boot that never reaches the shell gets a surface it can act on instead of
  // a window that only knows how to wait (issue #831). Rendered as a direct child
  // of the shell so it can layer above the splash and below the window controls.
  const startupRecovery =
    startupPhase === "starting" ? null : (
      <StartupRecovery
        phase={startupPhase}
        waitedMs={startupWaitedMs}
        onRetry={retryStartup}
        retrying={startupRetrying}
        down={backendDown}
      />
    );

  return (
    <div
      ref={appShellRef}
      className={cx(
        "app-shell",
        !ready && "app-shell-boot",
        page === "settings" && ready && "settings-mode",
        sidebarCollapsed && "sidebar-collapsed",
        workPanelMaximized && "work-panel-maximized",
        showSplash && "is-booting",
      )}
      style={{ "--ds-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="app-scenic-backdrop" aria-hidden />
      {ready ? (
        <>
          {/* Settings replaces the whole window, so the rail goes with it. */}
          {page === "settings" ? null : <SurfaceRail />}
          <SurfaceHost runtime={runtime} overlaysOpen={searchOpen} />

          {/* The window's bottom band. It is drawn once here, not inside a
              surface, so it spans the whole window and every interface feeds it
              its own segments; Settings takes the window and the band with it. */}
          {page === "settings" ? null : <StatusBar />}

          {/* Backend health follows the window, not one interface: it has to be
              readable from whichever surface is on screen. */}
          {backendDown && (
            <div
              className={`backend-banner no-drag ${backendDown.fatal ? "fatal" : "warn"}`}
              role="status"
            >
              <span className="backend-dot" aria-hidden />
              <span>
                {backendDown.fatal
                  ? backendDown.message === "GLIBC_UNSUPPORTED"
                    ? t("status.unsupportedGlibc")
                    : backendDown.message === "DB_SCHEMA_TOO_NEW"
                      ? t("status.dbSchemaTooNew", {
                          found: backendDown.schema?.found ?? "?",
                          supported: backendDown.schema?.supported ?? "?",
                        })
                      : t("status.fatal")
                  : t("status.restarting")}
              </span>
              {backendDown.fatal && (
                <button
                  type="button"
                  className="backend-action"
                  onClick={() => void api.openLogs()}
                >
                  {t("status.openLogs")}
                </button>
              )}
            </div>
          )}

          {archMismatch && (
            <div className="backend-banner no-drag warn" role="status">
              <span className="backend-dot" aria-hidden />
              <span>
                {t("status.archMismatch", {
                  buildArch: t(
                    `status.archNames.${archMismatch.platform}.${archMismatch.processArch}`,
                    { defaultValue: archMismatch.processArch },
                  ),
                  machineArch: t(
                    `status.archNames.${archMismatch.platform}.${archMismatch.machineArch}`,
                    { defaultValue: archMismatch.machineArch },
                  ),
                })}
              </span>
              <button
                type="button"
                className="backend-action"
                onClick={() => setArchMismatch(null)}
              >
                {t("status.dismissArchMismatch")}
              </button>
            </div>
          )}

          <SearchDialog
            open={searchOpen}
            mode={searchMode}
            onClose={() => setSearchOpen(false)}
          />
          <ToastHost anchorElement={null} />
          <PluginRendererHost />
          <ExtensionPromptHost />
          <UpdateBanner />
          {page === "settings" ? (
            <Suspense fallback={<RoutePending />}>
              <SettingsPage />
            </Suspense>
          ) : null}
        </>
      ) : null}
      {/* Outside pane stacking; skip splash so the band cannot cover boot chrome. */}
      {/* `showSplash` stays true for as long as the shell is not ready, so a
          bare `!showSplash` test would leave the recovery surface without any
          window controls — the only ones a frameless Windows/Linux window has.
          The controls therefore follow the boot surface that is actually up. */}
      {(ready && !showSplash) || startupPhase !== "starting" ? (
        <WindowControls />
      ) : null}
      <ProjectCreateDialog />
      <LifecycleConfirmationDialog />
      {splash}
      {startupRecovery}
    </div>
  );
}
