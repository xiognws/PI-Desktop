/**
 * Top-level surfaces of the desktop client.
 *
 * A surface is a whole working interface — its own sidebar and main pane —
 * not a destination inside one. Chat is the home surface; AutoTest is the
 * second, and further surfaces are appended to this list as they ship.
 *
 * This module is the single contract: the renderer's surface registry, the
 * persisted preference and (later) any IPC that names a surface all resolve
 * through it, so an id that a build no longer knows can never reach a render
 * path. It carries no React and no DOM, which keeps it testable in Node and
 * usable from the main process.
 */

export const SURFACE_IDS = ["chat", "autotest"] as const;

export type SurfaceId = (typeof SURFACE_IDS)[number];

/** Where a launch lands when nothing valid was stored. */
export const DEFAULT_SURFACE_ID: SurfaceId = "chat";

export function isSurfaceId(value: unknown): value is SurfaceId {
  return (
    typeof value === "string" &&
    (SURFACE_IDS as readonly string[]).includes(value)
  );
}

/**
 * Resolve a stored or requested surface id.
 *
 * A retired or unknown id falls back to chat rather than rendering an empty
 * shell — the same rule `resolveSettingsTab` applies to settings tabs, and the
 * reason a downgrade after adding a surface still opens a usable window.
 */
export function resolveSurfaceId(value: unknown): SurfaceId {
  return isSurfaceId(value) ? value : DEFAULT_SURFACE_ID;
}

/**
 * The AutoTest workbench's own lifecycle, as the renderer sees it.
 *
 * `status` mirrors the Python service the main process supervises; `port` is
 * the loopback port it was told to listen on, present only once ready. The
 * renderer never builds a URL of its own — it asks main to attach, and main
 * decides what is loadable.
 */
export type AutotestWorkbenchStatus = "stopped" | "starting" | "ready" | "failed";

export type AutotestWorkbenchSnapshot = {
  status: AutotestWorkbenchStatus;
  port: number | null;
  /** Why it failed, for the surface's own explanation. Empty when healthy. */
  error: string;
};
