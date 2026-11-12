/**
 * Small JSON preference files the main process keeps in the data directory:
 * the last main-window bounds and the persisted close behavior. Both are
 * best-effort; a missing or malformed file reads as "unset".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloseBehavior } from "@pi-workspace/shared";

export type WindowState = { x: number; y: number; width: number; height: number };

function windowStatePath(dataDir: string) {
  return join(dataDir, "window-state.json");
}

export async function readWindowState(
  dataDir: string,
  minWidth: number,
  minHeight: number,
): Promise<WindowState | null> {
  try {
    const raw = JSON.parse(await readFile(windowStatePath(dataDir), "utf8"));
    const s = {
      x: Number(raw.x),
      y: Number(raw.y),
      width: Number(raw.width),
      height: Number(raw.height),
    };
    if (![s.x, s.y, s.width, s.height].every(Number.isFinite)) return null;
    if (s.width < minWidth || s.height < minHeight) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeWindowState(dataDir: string, state: WindowState) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(windowStatePath(dataDir), JSON.stringify(state), "utf8");
  } catch {
    // best-effort persistence
  }
}

function closeBehaviorPath(dataDir: string) {
  return join(dataDir, "close-behavior.json");
}

export function readCloseBehavior(dataDir: string): CloseBehavior | null {
  try {
    const raw = JSON.parse(readFileSync(closeBehaviorPath(dataDir), "utf8"));
    return raw === "ask" || raw === "tray" || raw === "quit" ? raw : null;
  } catch {
    return null;
  }
}

export function writeCloseBehavior(dataDir: string, behavior: CloseBehavior) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(closeBehaviorPath(dataDir), JSON.stringify(behavior), "utf8");
  } catch {
    // best-effort persistence
  }
}

function startupAnimationPath(dataDir: string) {
  return join(dataDir, "startup-animation.json");
}

/**
 * The boot-animation preference, mirrored for the one reader that runs before
 * host-core answers.
 *
 * The descriptor reaches the renderer as a window creation argument, so it has
 * to be resolved before the first `BrowserWindow` exists — and settings are not
 * readable that early. This mirror is written whenever settings are saved and
 * read by the boot sequence; a missing file reads as "unset" and the animation
 * module falls back to its defaults, which matches a fresh install.
 */
export function readStartupAnimationPreferences(
  dataDir: string,
): { startupAnimation?: unknown } | null {
  try {
    const raw = JSON.parse(readFileSync(startupAnimationPath(dataDir), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = (raw as { startupAnimation?: unknown }).startupAnimation;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { startupAnimation: value };
  } catch {
    return null;
  }
}

export function writeStartupAnimationPreferences(
  dataDir: string,
  settings: { startupAnimation?: unknown } | null,
) {
  const value = settings?.startupAnimation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      startupAnimationPath(dataDir),
      JSON.stringify({ startupAnimation: value }),
      "utf8",
    );
  } catch {
    // best-effort persistence
  }
}
