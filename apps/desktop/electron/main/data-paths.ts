import { cpSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_IDENTIFIER } from "@pi-workspace/shared";

/**
 * The two directories that define an installation, and the development split
 * between them.
 *
 * A packaged build and a `pnpm dev` host must not share them: the
 * name-derived `userData` — where Electron keeps the single-instance lock,
 * renderer `localStorage`, and the plugin panel partitions — and the data
 * directory below the user's home, where host-core keeps `pi.sqlite` beside the
 * persistence outbox and the log tree. Sharing them meant a shipped app that
 * was already running held the lock, so the development launch quit on
 * arrival; a development host that won the race instead put a second host-core
 * over the same single-writer database, which is the divergence D236 exists to
 * prevent. Neither is workable while someone debugs against the app they use.
 *
 * Only the development side moves, and only these two names differ, so a
 * shipped and a development installation never collide on either directory.
 * `PI_DESKTOP_DATA_DIR` still overrides either profile outright.
 *
 * ## Storage identity is not branding
 *
 * Neither name is derived from `APP_NAME`. The display name is branding and
 * may change again; these names address data a user already has, so changing
 * one relocates real files. The retired identifiers below are therefore kept
 * and handed to `adoptDirectory`, so an installation that predates a rename is
 * adopted on first launch instead of being abandoned — which, to the user, is
 * indistinguishable from data loss.
 */

/** `userData` directory of a development installation, beside the shipped one. */
export const DEVELOPMENT_INSTALLATION_NAME = `${DATA_IDENTIFIER} Dev`;

/** Data directory of a shipped installation, below the user's home. */
export const INSTALLATION_DATA_DIR_NAME = ".piworkspace";

/** Data directory of a development installation, below the user's home. */
export const DEVELOPMENT_DATA_DIR_NAME = ".piworkspace-dev";

/**
 * Identifiers earlier releases wrote. Nothing may create these again; they
 * exist only as adoption sources for a profile that already has them.
 */
export const LEGACY_INSTALLATION_NAME = "PI-Desktop";
export const LEGACY_DEVELOPMENT_INSTALLATION_NAME = "PI-Desktop Dev";
export const LEGACY_INSTALLATION_DATA_DIR_NAME = ".pi-desktop";
export const LEGACY_DEVELOPMENT_DATA_DIR_NAME = ".pi-desktop-dev";
/** The development profile of a `main` checkout, before the rename. */
export const LEGACY_DEVELOPMENT_MAIN_DIR_NAME = ".pi-desktop-dev-main";

export type DataDirInput = {
  /** `PI_DESKTOP_DATA_DIR`; an explicit directory wins over either profile. */
  override: string | undefined;
  /** True for a development build. */
  development: boolean;
  /** The user's home directory. */
  home: string;
};

/**
 * The data directory one installation owns.
 *
 * `PI_DESKTOP_DATA_DIR` stays the escape hatch it always was: an explicit
 * directory wins, which is how the E2E harnesses, the capture rig, and
 * side-by-side profiles keep choosing their own root. The result is absolute,
 * because it reaches host-core as a child-process environment variable from a
 * working directory that need not be this one, and because `homedir()` is the
 * only other input that could be relative. Without an override the profile
 * picks the name, and that name is the whole difference between the two
 * installations.
 */
export function resolveDataDir({
  override,
  development,
  home,
}: DataDirInput): string {
  const explicit = override?.trim();
  if (explicit) return resolve(explicit);
  return resolve(
    join(
      home,
      development ? DEVELOPMENT_DATA_DIR_NAME : INSTALLATION_DATA_DIR_NAME,
    ),
  );
}

/**
 * The data directory this process owns.
 *
 * Electron main passes its own verdict for `development`, because only it can
 * ask `app.isPackaged`, and it publishes the resolved directory back to
 * `PI_DESKTOP_DATA_DIR` at boot. That publication is what keeps the plugin
 * runtime — which resolves this root from the environment rather than taking
 * it as a parameter — on one directory instead of falling back to the shipped
 * default, which would strand a development host's plugin data inside the
 * packaged profile.
 */
export function desktopDataDir(
  development: boolean = process.env.PI_DESKTOP_DEV === "1",
): string {
  return resolveDataDir({
    override: process.env.PI_DESKTOP_DATA_DIR,
    development,
    home: homedir(),
  });
}

/**
 * Where a shipped installation keeps *everything* it writes.
 *
 * The system drive is small, shared with the OS, and the first thing a user
 * notices filling up: caches, the database, plugin data and the Playwright
 * browsers all used to land there. A release therefore claims one folder of its
 * own on a non-system fixed drive (`D:\PiWorkspace`, then `E:`, ...) and keeps
 * the database, Electron's user data and the browser cache inside it. The
 * folder name is the storage identifier, so two installations never share a
 * root.
 *
 * `override` (`PI_DESKTOP_DATA_ROOT`) wins, and when no other drive exists the
 * caller keeps the old home-directory layout rather than failing to start.
 */
export function resolveReleaseDataRoot(input: {
  override?: string;
  candidates: readonly string[];
}): string | null {
  const explicit = input.override?.trim();
  if (explicit) return resolve(explicit);
  const first = input.candidates.find((candidate) => candidate.trim().length > 0);
  return first ? resolve(first) : null;
}

/**
 * Give `target` the contents of the first `source` that exists, once.
 *
 * `rename` is preferred: it is atomic, needs no extra space, and for a data
 * root that is hundreds of megabytes that is the difference between an instant
 * launch and a long copy. A `rename` across volumes fails on Windows and falls
 * back to a recursive copy. A source is never deleted, so a move that fails
 * part-way leaves the originals where the next launch finds them again.
 *
 * Returns true when `target` exists because of this call.
 */
export function adoptDirectory(
  target: string,
  sources: readonly string[],
  label: string,
): boolean {
  if (existsSync(target)) return false;
  const source = sources.find((candidate) => existsSync(candidate));
  if (!source) return false;
  try {
    renameSync(source, target);
    console.log(`[data-path] adopted ${label}: ${source} -> ${target}`);
    return true;
  } catch {
    try {
      cpSync(source, target, { recursive: true });
      console.log(`[data-path] copied ${label}: ${source} -> ${target}`);
      return true;
    } catch (error) {
      console.warn(`[data-path] could not adopt ${label} (${source}):`, error);
      return false;
    }
  }
}

/**
 * Adopt a pre-rename home profile onto the current name.
 *
 * Only reached when this machine has no non-system data drive, or on a
 * platform that never had one: everywhere else the whole data root moves in
 * one step (see `data-root.ts`), which carries this directory with it.
 */
export function adoptLegacyHomeProfile(home: string, development: boolean): void {
  const target = join(
    home,
    development ? DEVELOPMENT_DATA_DIR_NAME : INSTALLATION_DATA_DIR_NAME,
  );
  const sources = development
    ? [
        join(home, LEGACY_DEVELOPMENT_DATA_DIR_NAME),
        join(home, LEGACY_DEVELOPMENT_MAIN_DIR_NAME),
      ]
    : [join(home, LEGACY_INSTALLATION_DATA_DIR_NAME)];
  adoptDirectory(target, sources, "home profile");
}

/** The Electron `app` surface this helper needs; kept structural so tests need no Electron. */
export type UserDataApp = {
  commandLine: { hasSwitch(name: string): boolean };
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
};

/**
 * Give a development build its own `userData` so the single-instance lock
 * does not collide with a shipped app that is already running (D236, ADR 0094).
 * An explicit `--user-data-dir` wins, because that is how the E2E harnesses
 * point a build at a throwaway profile.
 */
export function applyDevelopmentUserData(
  app: UserDataApp,
  development: boolean,
): void {
  if (development && !app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath(
      "userData",
      join(app.getPath("appData"), DEVELOPMENT_INSTALLATION_NAME),
    );
  }
}
