import { lazy, type ComponentType } from "react";
import { SURFACE_IDS, type SurfaceId } from "@pi-workspace/shared";
import { IconChat, IconListChecks } from "../../components/icons";
import { lazyRoute } from "../../lib/lazy-retry";
import type { AppShellRuntime } from "../app/useAppShellRuntime";

/**
 * The surface registry.
 *
 * One row per interface: what it is called, which icon stands for it on the
 * rail, how it is loaded, and whether it must stay mounted while another
 * interface is on screen. Adding a surface is an append here plus an entry in
 * `SURFACE_IDS` — the rail, the shortcuts, the search entries and the persisted
 * preference all read those two lists instead of growing another branch in the
 * shell.
 */

/**
 * What every surface shell receives.
 *
 * `runtime` is the one shell runtime the window booted with (sidebar geometry,
 * work panel, search state). Non-chat surfaces do not own any of it, but they
 * are rendered by the same window and must not call the hook a second time —
 * that would register every listener twice.
 */
export type SurfaceShellProps = {
  runtime: AppShellRuntime;
  /** A window-level overlay (global search) is up and covers the surface. */
  overlaysOpen: boolean;
};

export type SurfaceDescriptor = {
  id: SurfaceId;
  /** i18n key for the rail label and its tooltip. */
  labelKey: string;
  /** Rail glyph, drawn at the sidebar's row size. */
  icon: ComponentType<{ size?: number }>;
  /** Renders the surface's own sidebar and main pane. */
  shell: ComponentType<SurfaceShellProps>;
  /**
   * Keep mounted even while another surface is active.
   *
   * Only the home surface needs this: a running turn keeps streaming into the
   * store either way, but the transcript's scroll position, the work panel's
   * tabs and the composer draft are renderer state and would be lost on a
   * remount.
   */
  keepMounted?: boolean;
};

const ChatSurfaceShell = lazy(
  lazyRoute(() =>
    import("./chat/ChatSurfaceShell").then((module) => ({
      default: module.ChatSurfaceShell,
    })),
  ),
);

const AutoTestSurfaceShell = lazy(
  lazyRoute(() =>
    import("./autotest/AutoTestSurfaceShell").then((module) => ({
      default: module.AutoTestSurfaceShell,
    })),
  ),
);

export const SURFACES: readonly SurfaceDescriptor[] = [
  {
    id: "chat",
    labelKey: "surface.chat",
    icon: IconChat,
    shell: ChatSurfaceShell,
    keepMounted: true,
  },
  {
    id: "autotest",
    labelKey: "surface.autotest",
    icon: IconListChecks,
    shell: AutoTestSurfaceShell,
  },
];

/**
 * A registry that has drifted from the shared id list would silently drop an
 * interface from the rail, so the mismatch is reported once at module load.
 * `surface-registry.test.mjs` pins the same invariant mechanically.
 */
const registered = new Set(SURFACES.map((surface) => surface.id));
for (const id of SURFACE_IDS) {
  if (!registered.has(id)) {
    console.error(`[surfaces] no descriptor registered for surface "${id}"`);
  }
}

export function surfaceDescriptor(id: SurfaceId): SurfaceDescriptor {
  return SURFACES.find((surface) => surface.id === id) ?? SURFACES[0];
}
