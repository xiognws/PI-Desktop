/**
 * Local model entry sources.
 *
 * A "source" is one desktop app whose signed-in models this build can expose in
 * the model list. WorkBuddy is the only source today. Adding another vendor
 * (Trae, Qoder, …) means: write its `detect` + `startBridge` pair in its own
 * module, add one entry to {@link localModelSources}, and nothing else — the
 * service, the provider-row registration, and the bridge lifecycle are shared.
 *
 * Nothing here is required at runtime: a machine without the app reports
 * `installed: false`, no row is created, and the rest of the app is unaffected.
 */
import type { WorkBuddyEnvironment } from "./paths.ts";
import { detectWorkBuddy } from "./detect.ts";
import { startWorkBuddyBridge } from "./bridge.ts";
import type { WorkBuddyDiscovery } from "./types.ts";

/** A loopback OpenAI-compatible endpoint the model list can point at. */
export type LocalEntryBridge = {
  baseUrl: string;
  close: () => Promise<void>;
};

export type LocalModelSource = {
  /** Stable id; also the log/scope key. */
  id: string;
  /** Provider-row display name. */
  name: string;
  /** Provider-row marker the source owns. Must be unique across sources. */
  vendorKey: string;
  /** Inspect the machine. Never throws, never returns credentials. */
  detect: (environment: WorkBuddyEnvironment) => WorkBuddyDiscovery;
  /** Start the loopback gateway for one source. */
  startBridge: (options: {
    /** Re-read the account on every request so the model list stays current. */
    detect: () => WorkBuddyDiscovery;
    log?: (event: Record<string, unknown>) => void;
  }) => Promise<LocalEntryBridge>;
};

/** WorkBuddy: Tencent CodeBuddy desktop, reached through its own chat endpoint. */
export const workBuddySource: LocalModelSource = {
  id: "workbuddy",
  name: "WorkBuddy",
  vendorKey: "workbuddy",
  detect: detectWorkBuddy,
  startBridge: async ({ detect, log }) => {
    const bridge = await startWorkBuddyBridge({ discovery: detect, log });
    return { baseUrl: bridge.baseUrl, close: bridge.close };
  },
};

/** Every local source this build exposes, in display order. */
export function localModelSources(): LocalModelSource[] {
  return [workBuddySource];
}
