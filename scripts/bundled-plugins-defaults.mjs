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
  const raw = document?.defaultDisabled;
  if (!Array.isArray(raw)) {
    throw new Error(`${label}: defaultDisabled must be an array of plugin ids`);
  }
  const ids = [];
  for (const id of raw) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`${label}: defaultDisabled entries must be non-empty strings`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, document };
}

/** The declared ids, read from a repository root. */
export function readDefaultDisabledIds(repoRoot) {
  return parseDefaultDisabled(readFileSync(join(repoRoot, DEFAULT_DISABLED_FILE), "utf8")).ids;
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
