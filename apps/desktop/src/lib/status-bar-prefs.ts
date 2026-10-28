import { useEffect, useState } from "react";

/**
 * Which status bar items the user turned off, and whether the bar is hidden.
 *
 * These are preferences about one window's chrome, not session state: they are
 * kept per installation in local storage and broadcast with a window event so
 * the bar and its context menu stay in step without a store slice.
 */
export type StatusBarPrefs = { hidden: string[]; barHidden: boolean };

const STORAGE_KEY = "pi-desktop.statusbar.prefs";
const CHANGE_EVENT = "pi-desktop:statusbar-prefs";

const EMPTY: StatusBarPrefs = { hidden: [], barHidden: false };

export function readStatusBarPrefs(): StatusBarPrefs {
  if (typeof localStorage === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<StatusBarPrefs>;
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((id) => typeof id === "string") : [],
      barHidden: parsed.barHidden === true,
    };
  } catch {
    return EMPTY;
  }
}

export function writeStatusBarPrefs(next: StatusBarPrefs): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage must not break the bar.
  }
  window.dispatchEvent(new CustomEvent<StatusBarPrefs>(CHANGE_EVENT, { detail: next }));
}

export function toggleStatusBarItem(id: string, visible: boolean): StatusBarPrefs {
  const current = readStatusBarPrefs();
  const hidden = visible
    ? current.hidden.filter((item) => item !== id)
    : [...new Set([...current.hidden, id])];
  const next = { ...current, hidden };
  writeStatusBarPrefs(next);
  return next;
}

export function setStatusBarHidden(barHidden: boolean): StatusBarPrefs {
  const next = { ...readStatusBarPrefs(), barHidden };
  writeStatusBarPrefs(next);
  return next;
}

export function useStatusBarPrefs(): StatusBarPrefs {
  const [prefs, setPrefs] = useState<StatusBarPrefs>(readStatusBarPrefs);
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<StatusBarPrefs>).detail;
      setPrefs(detail ?? readStatusBarPrefs());
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return prefs;
}
