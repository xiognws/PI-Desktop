import { useTranslation } from "react-i18next";
import type { SurfaceId } from "@pi-workspace/shared";
import { TooltipButton } from "../../components/ui";
import { IconSettings as SettingsIcon } from "../../components/icons";
import { useAppStore } from "../../stores/app-store";
import { SURFACES } from "./registry";

/**
 * The first column of the window: one glyph per interface.
 *
 * It sits outside every surface's sidebar because switching interfaces replaces
 * that sidebar — a switcher inside it would disappear with it. The rail is also
 * why the shell has a single place to add an interface later: this component
 * never names a surface, it walks the registry.
 *
 * The top cell is a drag spacer, not a button: on Windows/Linux it occupies the
 * same 46px titlebar lane the sidebar header uses, so the window stays draggable
 * there and the macOS traffic-light inset is never covered by a control.
 */
export function SurfaceRail() {
  const { t } = useTranslation();
  const surface = useAppStore((s) => s.surface);
  const setSurface = useAppStore((s) => s.setSurface);
  const setPage = useAppStore((s) => s.setPage);

  return (
    <nav className="surface-rail" aria-label={t("surface.switcher")}>
      <div className="surface-rail-spacer" aria-hidden />
      {SURFACES.map((entry) => {
        const active = entry.id === surface;
        const label = t(entry.labelKey);
        const Icon = entry.icon;
        return (
          <TooltipButton
            key={entry.id}
            type="button"
            className={`surface-rail-button no-drag${active ? " is-active" : ""}`}
            data-nav={`surface-${entry.id}`}
            tooltip={label}
            ariaLabel={label}
            aria-current={active ? "page" : undefined}
            onClick={() => setSurface(entry.id as SurfaceId)}
          >
            <Icon size={17} />
          </TooltipButton>
        );
      })}
      {/* Settings belong to the client, not to a conversation: this column is the
          one place every interface shares, so the entry lives here and stays
          reachable from the AutoTest surface too. */}
      <div className="surface-rail-bottom">
        <TooltipButton
          type="button"
          className="surface-rail-button no-drag"
          data-nav="surface-settings"
          tooltip={t("nav.settings")}
          ariaLabel={t("nav.settings")}
          onClick={() => setPage("settings")}
        >
          <SettingsIcon size={16} />
        </TooltipButton>
      </div>
    </nav>
  );
}
