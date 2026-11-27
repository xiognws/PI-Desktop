import type { ComponentType } from "react";
import type { SurfaceId } from "@pi-workspace/shared";
import { StatusBarCredits } from "../../components/StatusBarCredits";
import {
  StatusBarCache,
  StatusBarElapsed,
  StatusBarMetrics,
  StatusBarScheduled,
  StatusBarSessionAge,
  StatusBarSpeed,
  StatusBarTokens,
} from "../../components/StatusBarUsage";
import {
  AutotestPipelineSegment,
  AutotestProjectSegment,
  AutotestServiceSegment,
  ChatPendingSegment,
  ChatProjectSegment,
  ChatRunningSegment,
} from "./status-segments";

/**
 * What each interface tells the window's status bar.
 *
 * The bar itself knows no interface: it draws the row `surface` resolves to, in
 * this order, and nothing else. Adding a surface means adding its row here — the
 * same shape as `features/surfaces/registry.tsx`, and for the same reason.
 *
 * A segment's `id` is also the key its entry in the bar's customize menu
 * toggles, so ids are permanent: renaming one silently un-hides whatever the
 * user had turned off.
 */
export type StatusSegment = {
  id: string;
  /** Draws the segment; a component, so it may read the store with hooks. */
  render: ComponentType;
};

/** One toggleable row of the bar's right-click menu. */
export type StatusMenuEntry = {
  id: string;
  /** i18n key for the row's label. */
  labelKey: string;
};

/** The segments of each surface, in the order the bar draws them. */
export const SURFACE_STATUS_SEGMENTS: Record<SurfaceId, readonly StatusSegment[]> = {
  // Everything the bar has always carried: the conversation is the window's work.
  chat: [
    { id: "project", render: ChatProjectSegment },
    { id: "context", render: StatusBarMetrics },
    { id: "credits", render: StatusBarCredits },
    { id: "tokens", render: StatusBarTokens },
    { id: "speed", render: StatusBarSpeed },
    { id: "cache", render: StatusBarCache },
    { id: "sessionAge", render: StatusBarSessionAge },
    { id: "scheduled", render: StatusBarScheduled },
    { id: "running", render: ChatRunningSegment },
    { id: "timer", render: StatusBarElapsed },
    { id: "pending", render: ChatPendingSegment },
  ],
  // The test platform's environment and where it is: service, project, step.
  autotest: [
    { id: "autotest.service", render: AutotestServiceSegment },
    { id: "autotest.project", render: AutotestProjectSegment },
    { id: "autotest.pipeline", render: AutotestPipelineSegment },
  ],
};

/**
 * The customize menu, per surface.
 *
 * Deliberately not derived from the segments: the menu has kept its own order
 * since before the bar was shared, and `credits` sits at the end of it while the
 * bar draws it third. Segments missing here are simply always shown.
 */
export const SURFACE_STATUS_MENU: Record<SurfaceId, readonly StatusMenuEntry[]> = {
  chat: [
    { id: "project", labelKey: "statusBar.project" },
    { id: "context", labelKey: "statusBar.context" },
    { id: "tokens", labelKey: "statusBar.tokens" },
    { id: "speed", labelKey: "statusBar.speed" },
    { id: "cache", labelKey: "statusBar.cache" },
    { id: "sessionAge", labelKey: "statusBar.sessionAge" },
    { id: "scheduled", labelKey: "statusBar.scheduled" },
    { id: "timer", labelKey: "statusBar.running" },
    { id: "pending", labelKey: "statusBar.pending" },
    { id: "credits", labelKey: "statusBar.creditsUnit" },
  ],
  autotest: [
    { id: "autotest.service", labelKey: "statusBar.service" },
    { id: "autotest.project", labelKey: "statusBar.project" },
    { id: "autotest.pipeline", labelKey: "statusBar.pipeline" },
  ],
};
