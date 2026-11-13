import type { UpdateMode, UpdatePreference } from "@pi-workspace/shared";

export type WindowsDistribution = "installed" | "zip" | "portable";

/**
 * This build ships no update feed at all: `build.publish` and the packaged
 * `app-update.yml` are gone, so `electron-updater` has nothing to resolve and
 * every check would only time out (github.com is unreachable from the intranet
 * this build is distributed in). The whole update path therefore stays off.
 * Bringing it back means adding a feed to `build.publish` and flipping this
 * flag — nothing else reads it.
 */
const PUBLIC_UPDATE_FEED_REACHABLE = false;

/**
 * Whether this build ships with a reachable update feed. Exported so the shipped
 * default can be asserted directly, and so callers (tests, a future internal
 * release channel) can exercise the policy below without editing the constant.
 */
export const UPDATE_FEED_REACHABLE = PUBLIC_UPDATE_FEED_REACHABLE;

export type UpdatePolicyOptions = {
  /** Defaults to the shipped flag above. */
  feedReachable?: boolean;
};

const feedReachable = (options?: UpdatePolicyOptions): boolean =>
  options?.feedReachable ?? PUBLIC_UPDATE_FEED_REACHABLE;

export function supportsAutomaticUpdates(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  options?: UpdatePolicyOptions,
): boolean {
  if (!feedReachable(options)) return false;
  if (!isPackaged) return false;
  if (platform === "win32" || platform === "darwin") return true;
  return platform === "linux" && Boolean(env.APPIMAGE);
}

export function resolveDefaultUpdatePreference(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: WindowsDistribution,
  options?: UpdatePolicyOptions,
): UpdatePreference {
  if (!supportsAutomaticUpdates(platform, isPackaged, env, options)) return "manual";
  if (
    platform === "win32" &&
    (Boolean(env.PORTABLE_EXECUTABLE_FILE) || distribution === "zip" || distribution === "portable")
  ) {
    return "manual";
  }
  return "automatic";
}

export function resolveStoredUpdatePreference(
  value: unknown,
  fallback: UpdatePreference,
): UpdatePreference {
  return value === "automatic" || value === "manual" ? value : fallback;
}

export function resolveEffectiveUpdatePreference(
  preference: UpdatePreference,
  automaticSupported: boolean,
): UpdatePreference {
  return automaticSupported ? preference : "manual";
}

export function resolveUpdateMode(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: WindowsDistribution,
  preference?: UpdatePreference,
  options?: UpdatePolicyOptions,
): UpdateMode {
  if (!feedReachable(options)) return "disabled";
  if (!isPackaged) return "disabled";
  if (!supportsAutomaticUpdates(platform, isPackaged, env, options)) return "manual";
  const selected =
    preference ??
    resolveDefaultUpdatePreference(platform, isPackaged, env, distribution);
  return selected === "automatic" ? "in-app" : "manual";
}
