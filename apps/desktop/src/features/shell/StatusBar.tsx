import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconClock, IconPlug, IconSettings } from "../../components/icons";
import { NotificationCenter } from "../../components/NotificationCenter";
import { StatusBarMenu, type StatusBarMenuEntry } from "../../components/StatusBarMenu";
import { cx, TooltipButton } from "../../components/ui";
import { useUpdateState } from "../../hooks/use-update-state";
import { api } from "../../lib/api";
import { setStatusBarHidden, useStatusBarPrefs } from "../../lib/status-bar-prefs";
import { useAppStore } from "../../stores/app-store";
import { SURFACE_STATUS_MENU, SURFACE_STATUS_SEGMENTS } from "./surface-status";

/**
 * The window's status bar.
 *
 * It belongs to the window, not to one interface: it spans the shell's bottom
 * edge whichever surface is on screen, and each surface feeds it the segments it
 * has something to say about (`surface-status.ts`). The bar knows no surface by
 * name — it draws the current one's row and nothing else.
 *
 * The left actions, the version chip and the "hide the whole bar" affordance are
 * window chrome and read the same everywhere; only the middle cluster changes.
 * `.sidebar-footer` is the class it has always had: the 30px band, its position
 * and its `.app-shell` reservation are already written against it.
 */
export function StatusBar() {
  const { t } = useTranslation();
  const surface = useAppStore((s) => s.surface);
  const page = useAppStore((s) => s.page);
  const settings = useAppStore((s) => s.settings);
  const setPage = useAppStore((s) => s.setPage);
  const navBack = useAppStore((s) => s.navBack);
  const canNavBack = useAppStore((s) => s.canNavBack);
  const version = useAppStore((s) => s.version);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const update = useUpdateState();
  const prefs = useStatusBarPrefs();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  const segments = SURFACE_STATUS_SEGMENTS[surface].filter(
    (segment) => !prefs.hidden.includes(segment.id),
  );
  const menuEntries: StatusBarMenuEntry[] = SURFACE_STATUS_MENU[surface].map((entry) => ({
    id: entry.id,
    label: t(entry.labelKey),
  }));

  // An update only earns the accent dot once it is actionable — a pending
  // check or a failed one keeps the chip quiet.
  const updateReady =
    update?.status === "available" || update?.status === "downloaded";
  const appVersion = update?.currentVersion || version?.version || "";
  const buildLabel = updateReady
    ? `v${update?.availableVersion ?? appVersion}`
    : update?.status === "checking"
      ? t("updates.checking")
      : appVersion
        ? `v${appVersion}`
        : t("nav.buildUnknown");
  const buildTitle = updateReady
    ? t("updates.available", { version: update?.availableVersion ?? "" })
    : t("nav.checkForUpdates");

  return (
    <>
      <div
        className={cx("sidebar-footer no-drag", prefs.barHidden && "is-bar-hidden")}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuAt({ x: event.clientX, y: window.innerHeight - event.clientY });
        }}
      >
        <div className="footer-actions">
          <TooltipButton
            type="button"
            className={`footer-action ${page === "settings" ? "active" : ""}`}
            data-nav="settings"
            tooltip={t("nav.settings")}
            ariaLabel={t("nav.settings")}
            onClick={() => setPage("settings")}
            aria-pressed={page === "settings"}
          >
            <IconSettings size={14} aria-hidden />
          </TooltipButton>
          <TooltipButton
            type="button"
            className={`footer-action ${page === "plugins" ? "active" : ""}`}
            data-nav="plugins"
            tooltip={t("nav.plugins")}
            ariaLabel={t("nav.plugins")}
            onClick={() => page === "plugins"
              ? (canNavBack() ? navBack() : setPage("chat"))
              : setPage("plugins")}
            aria-pressed={page === "plugins"}
          >
            <IconPlug size={14} aria-hidden />
          </TooltipButton>
          {settings?.scheduledTasksEnabled !== false && (
            <TooltipButton
              type="button"
              className={`footer-action ${page === "scheduled" ? "active" : ""}`}
              data-nav="scheduled"
              tooltip={t("scheduled.title")}
              ariaLabel={t("scheduled.title")}
              onClick={() => setPage("scheduled")}
              aria-pressed={page === "scheduled"}
            >
              <IconClock size={14} aria-hidden />
            </TooltipButton>
          )}
          <NotificationCenter onBeforeOpen={() => setMenuAt(null)} />
        </div>

        <div className="statusbar-info">
          {segments.map((segment) => {
            const Segment = segment.render;
            return <Segment key={segment.id} />;
          })}
        </div>

        <TooltipButton
          type="button"
          className={`footer-build ${updateReady ? "has-update" : ""}`}
          data-nav="build"
          tooltip={buildTitle}
          ariaLabel={buildTitle}
          onClick={() => {
            if (updateReady) {
              setSettingsAnchor("updates.title");
              setSettingsTab("about");
              return;
            }
            void (async () => {
              try {
                await api.updatesCheck();
              } catch { /* ignore */ }
            })();
          }}
        >
          <span className="footer-build-version">{buildLabel}</span>
          {updateReady ? <span className="footer-build-dot" aria-hidden /> : null}
        </TooltipButton>
        {prefs.barHidden ? (
          <button
            type="button"
            className="statusbar-restore no-drag"
            onClick={() => setStatusBarHidden(false)}
            title={t("statusBar.showBar")}
            aria-label={t("statusBar.showBar")}
          >
            <IconClock size={12} aria-hidden />
          </button>
        ) : null}
      </div>
      {menuAt ? (
        <StatusBarMenu
          at={menuAt}
          entries={menuEntries}
          prefs={prefs}
          onClose={() => setMenuAt(null)}
        />
      ) : null}
    </>
  );
}
