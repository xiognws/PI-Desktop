import { resolveSurfaceId, type SurfaceId } from "@pi-workspace/shared";

/**
 * Which surface the window opens on.
 *
 * A UI preference, so it lives where the other renderer-only preferences live
 * (localStorage) rather than in the host database: it changes nothing about a
 * session, and a downgrade that no longer knows the id must simply land on
 * chat instead of failing a settings read.
 */
const STORAGE_KEY = "pi.desktop.surface";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

export function loadSurfacePreference(target: StorageLike | null = storage()): SurfaceId {
  if (!target) return resolveSurfaceId(undefined);
  try {
    // Stored as JSON so a plain string can never be mistaken for a partial
    // record, and an id this build retired still resolves through one rule.
    const raw = target.getItem(STORAGE_KEY);
    return resolveSurfaceId(raw ? JSON.parse(raw) : undefined);
  } catch {
    return resolveSurfaceId(undefined);
  }
}

export function saveSurfacePreference(
  surface: SurfaceId,
  target: StorageLike | null = storage(),
): void {
  if (!target) return;
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(surface));
  } catch {
    // A full or blocked store costs the user nothing but the next launch
    // landing on chat; it must never break navigation.
  }
}
