/**
 * Bundled plugins that ship with the application but must not start by
 * themselves.
 *
 * A bundled plugin's initial enabled state is the manifest's
 * `enabledByDefault` (`crates/host-core/src/plugins/registry.rs`, ADR 0105 /
 * ADR 0241). Packages arrive from the marketplace with their own default, so
 * the product's own answer has to be stamped onto the manifest while the
 * package is expanded — that is the only copy host-core ever reads.
 *
 * `scripts/bundled-plugins-default-disabled.json` is that list. It is
 * deliberately separate from `scripts/bundled-plugins-excluded.json`: that file
 * decides what may never be bundled, this one decides what is bundled but
 * starts off. Keeping them apart means neither decision hides inside the other
 * — a plugin that is retired and must not ship is not the same thing as one
 * that ships for a user to switch on.
 *
 * The flag is a *default*, never a policy: host-core carries the previous
 * `enabled` value across every launch, so a user who enabled or disabled the
 * plugin keeps that state through an upgrade.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DISABLED_FILE = "scripts/bundled-plugins-default-disabled.json";

/** Parse the declaration file. Throws with the file name, never silently. */
export function parseDefaultDisabled(text, label = DEFAULT_DISABLED_FILE) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
  const ids = readIdList(document?.defaultDisabled, label, "defaultDisabled");
  // Platform-scoped entries: a plugin that cannot run on a platform must not
  // arrive enabled there, where it would list as a working tool and then open an
  // empty panel.
  const rawPlatforms = document?.defaultDisabledOnPlatforms ?? {};
  if (rawPlatforms === null || typeof rawPlatforms !== "object" || Array.isArray(rawPlatforms)) {
    throw new Error(`${label}: defaultDisabledOnPlatforms must be an object of platform → plugin ids`);
  }
  const byPlatform = {};
  for (const [platform, value] of Object.entries(rawPlatforms)) {
    if (platform.startsWith("//")) continue;
    if (!/^[a-z][a-z0-9]*$/.test(platform)) {
      throw new Error(`${label}: defaultDisabledOnPlatforms keys must be platform names, got "${platform}"`);
    }
    byPlatform[platform] = readIdList(value, label, `defaultDisabledOnPlatforms.${platform}`);
  }
  return { ids, byPlatform, document };
}

/** Validate one list of plugin ids. */
function readIdList(raw, label, field) {
  if (!Array.isArray(raw)) {
    throw new Error(`${label}: ${field} must be an array of plugin ids`);
  }
  const ids = [];
  for (const id of raw) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`${label}: ${field} entries must be non-empty strings`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The declared ids for one platform, read from a repository root.
 *
 * The platform argument exists so a test can ask "what would a Windows build
 * disable" without pretending to run on Windows.
 */
export function readDefaultDisabledIds(repoRoot, platform = process.platform) {
  const parsed = parseDefaultDisabled(readFileSync(join(repoRoot, DEFAULT_DISABLED_FILE), "utf8"));
  const ids = [...parsed.ids];
  for (const id of parsed.byPlatform[platform] ?? []) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Apply the declaration to one package manifest.
 *
 * Returns the manifest to write plus whether it differs from what the package
 * shipped. Everything else in the manifest is preserved verbatim, because the
 * rest of it still belongs to the publisher.
 */
export function withDefaultDisabled(manifest, ids) {
  const listed = ids instanceof Set ? ids.has(manifest.id) : ids.includes(manifest.id);
  if (!listed || manifest.enabledByDefault === false) {
    return { manifest, changed: false };
  }
  return { manifest: { ...manifest, enabledByDefault: false }, changed: true };
}
