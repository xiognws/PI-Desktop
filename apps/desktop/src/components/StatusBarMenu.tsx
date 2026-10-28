import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  type StatusBarPrefs,
  setStatusBarHidden,
  toggleStatusBarItem,
} from "../lib/status-bar-prefs";

export type StatusBarMenuEntry = { id: string; label: string; locked?: boolean };

/**
 * Right-click menu for the status bar: what the bar shows, and whether it shows
 * at all. Every listed item can be toggled except the version chip — hiding the
 * surface that holds the way back would strand the user.
 */
export function StatusBarMenu({
  at,
  entries,
  prefs,
  onClose,
}: {
  at: { x: number; y: number };
  entries: readonly StatusBarMenuEntry[];
  prefs: StatusBarPrefs;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="statusbar-menu"
      role="menu"
      style={{ left: at.x, bottom: Math.max(8, at.y) }}
    >
      <div className="statusbar-menu-title">{t("statusBar.customize")}</div>
      {entries.map((entry) => {
        const visible = entry.locked || !prefs.hidden.includes(entry.id);
        return (
          <label key={entry.id} className="statusbar-menu-row">
            <input
              type="checkbox"
              checked={visible}
              disabled={entry.locked}
              onChange={(event) => toggleStatusBarItem(entry.id, event.target.checked)}
            />
            <span>{entry.label}</span>
          </label>
        );
      })}
      <div className="statusbar-menu-separator" />
      <button
        type="button"
        className="statusbar-menu-row is-action"
        onClick={() => {
          setStatusBarHidden(true);
          onClose();
        }}
      >
        {t("statusBar.hideBar")}
      </button>
    </div>
  );
}
