import type { UpdateMode, UpdatePreference } from "@pi-workspace/shared";

export type WindowsDistribution = "installed" | "zip" | "portable";

/**
 * This build is distributed inside the company intranet, where `github.com` is
 * unreachable. An update check there can only time out and leave a spinner in
 * the UI, so the whole update path stays off until a release ships with an
 * internal update feed. Flip this to `true` (and point `app-update.yml` /
 * `build.publish` at that feed) to bring the updater back.
 */
const PUBLIC_UPDATE_FEED_REACHABLE = false;

export function supportsAutomaticUpdates(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!PUBLIC_UPDATE_FEED_REACHABLE) return false;
  if (!isPackaged) return false;
  if (platform === "win32" || platform === "darwin") return true;
  return platform === "linux" && Boolean(env.APPIMAGE);
}

export function resolveDefaultUpdatePreference(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: WindowsDistribution,
): UpdatePreference {
  if (!supportsAutomaticUpdates(platform, isPackaged, env)) return "manual";
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
): UpdateMode {
  if (!PUBLIC_UPDATE_FEED_REACHABLE) return "disabled";
  if (!isPackaged) return "disabled";
  if (!supportsAutomaticUpdates(platform, isPackaged, env)) return "manual";
  const selected =
    preference ??
    resolveDefaultUpdatePreference(platform, isPackaged, env, distribution);
  return selected === "automatic" ? "in-app" : "manual";
}
