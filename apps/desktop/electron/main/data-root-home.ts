import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * A home-relative directory this installation owns, paired with the directory
 * inside the data root that should hold its content.
 *
 * Several bundled plugins resolve their own state with `os.homedir()` instead
 * of the host APIs — `~/.agents/skills` for learned skills, `~/.pi/agent` for
 * prompt fragments and the user profile, `~/.pi-desktop` for plugin data — so a
 * data root alone does not keep them off the system drive. A directory link at
 * the home level does, without patching plugins that the marketplace re-delivers
 * on every sync.
 */
export type HomeLink = {
  readonly home: string;
  readonly target: string;
  readonly label: string;
};

export type HomeLinkResult = {
  readonly label: string;
  readonly home: string;
  readonly target: string;
  /**
   * `linked` — a junction/symlink now sits at `home`.
   * `kept` — `home` was already a link, so it was left untouched.
   * `skipped` — the link could not be created; `error` says why and the layout
   * stays usable, it just keeps writing under the home directory.
   */
  readonly state: "linked" | "kept" | "skipped";
  /** True when content was merged into the target before the link replaced the directory. */
  readonly merged: boolean;
  readonly error?: string;
};

/** The home-level directories every installation redirects onto the data drive. */
export const HOME_LINK_DIRS = {
  /** User skills and subagents; also reachable through `PI_DESKTOP_AGENTS_DIR`. */
  agents: ".agents",
  /** Agent home state written by plugins that resolve paths themselves. */
  pi: ".pi",
  /** The data directory used before the relocation. */
  legacyData: ".pi-desktop",
} as const;

/** The links every installation needs, in the order they are applied. */
export function planHomeLinks(input: {
  /** The user's home directory. */
  home: string;
  /** The installation folder this build claimed on the data drive. */
  root: string;
  /** The resolved data directory — what `PI_DESKTOP_DATA_DIR` ends up pointing at. */
  dataDir: string;
}): HomeLink[] {
  return [
    // Global capabilities: user skills and subagents, shared by every profile.
    {
      home: join(input.home, HOME_LINK_DIRS.agents),
      target: join(input.root, "agents"),
      label: "global capabilities",
    },
    // Agent home state written by plugins that never ask the host for a path.
    { home: join(input.home, HOME_LINK_DIRS.pi), target: join(input.root, "pi"), label: "agent home state" },
    // The pre-relocation data directory; plugin data written there belongs with
    // the data root the host now uses.
    { home: join(input.home, HOME_LINK_DIRS.legacyData), target: input.dataDir, label: "legacy data directory" },
  ];
}

/**
 * Merge every home link and point it at the data root.
 *
 * Merging is copy-then-remove rather than a plain move: a target that already
 * exists wins per file, so a plugin that kept writing to the old location after
 * the database moved does not overwrite the live copy with a stale one. When any
 * step fails the original directory is left in place — losing user files is worse
 * than writing them to the system drive.
 */
export function applyHomeLinks(
  links: readonly HomeLink[],
  log: Pick<Console, "log" | "warn"> = console,
): HomeLinkResult[] {
  return links.map((link) => applyHomeLink(link, log));
}

function applyHomeLink(link: HomeLink, log: Pick<Console, "log" | "warn">): HomeLinkResult {
  const base = { label: link.label, home: link.home, target: link.target };
  if (isLink(link.home)) {
    // Never rewrite a link someone else created; say so when it points away from
    // this root, because that is a second copy of the data rather than a redirect.
    const pointedAt = readLinkTarget(link.home);
    if (pointedAt && pointedAt !== normalizeTarget(link.target)) {
      log.warn(`[data-root] kept ${link.home} -> ${pointedAt} (this root would use ${link.target})`);
    }
    return { ...base, state: "kept", merged: false };
  }
  if (existsSync(link.home) && !isDirectory(link.home)) {
    const error = `${link.home} is not a directory`;
    log.warn(`[data-root] cannot link ${link.label}: ${error}`);
    return { ...base, state: "skipped", merged: false, error };
  }

  const merged = mergeInto(link.home, link.target, link.label, log);
  if (merged.error) return { ...base, state: "skipped", merged: false, error: merged.error };

  try {
    mkdirSync(link.target, { recursive: true });
  } catch (error) {
    const message = `cannot create ${link.target}: ${messageOf(error)}`;
    log.warn(`[data-root] cannot link ${link.label}: ${message}`);
    return { ...base, state: "skipped", merged: merged.merged, error: message };
  }
  try {
    // A junction is the one link type Windows grants without elevation, and the
    // host and every plugin follow it transparently.
    symlinkSync(link.target, link.home, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const message = `cannot link ${link.home} -> ${link.target}: ${messageOf(error)}`;
    log.warn(`[data-root] cannot link ${link.label}: ${message}`);
    return { ...base, state: "skipped", merged: merged.merged, error: message };
  }
  log.log(`[data-root] linked ${link.label}: ${link.home} -> ${link.target}`);
  return { ...base, state: "linked", merged: merged.merged };
}

/**
 * Remove links whose target is gone.
 *
 * A link left over from a previous launch points at a data drive that is not
 * mounted right now. Writing through it fails instead of falling back, so the
 * link is dropped (the link only — never its target) and that directory is
 * recreated as a plain directory by whoever writes to it next.
 */
export function dropDanglingHomeLinks(
  home: string,
  log: Pick<Console, "log" | "warn"> = console,
): string[] {
  const dropped: string[] = [];
  for (const name of Object.values(HOME_LINK_DIRS)) {
    const path = join(home, name);
    if (!isLink(path) || existsSync(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      dropped.push(path);
      log.warn(`[data-root] dropped dangling link ${path}`);
    } catch (error) {
      log.warn(`[data-root] cannot drop dangling link ${path}: ${messageOf(error)}`);
    }
  }
  return dropped;
}

/** Copy what the target is missing, then drop the source so the link can take its place. */
function mergeInto(
  from: string,
  to: string,
  label: string,
  log: Pick<Console, "log" | "warn">,
): { merged: boolean; error?: string } {
  if (!existsSync(from)) return { merged: false };
  try {
    mkdirSync(to, { recursive: true });
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  } catch (error) {
    const message = `cannot copy ${from} -> ${to}: ${messageOf(error)}`;
    log.warn(`[data-root] cannot move ${label}: ${message}`);
    return { merged: false, error: message };
  }
  try {
    rmSync(from, { recursive: true, force: true });
  } catch (error) {
    const message = `copied to ${to} but could not clear ${from}: ${messageOf(error)}`;
    log.warn(`[data-root] cannot move ${label}: ${message}`);
    return { merged: false, error: message };
  }
  log.log(`[data-root] moved ${label}: ${from} -> ${to}`);
  return { merged: true };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Where a link points, normalized for comparison, or nothing when it cannot be read. */
function readLinkTarget(path: string): string | undefined {
  try {
    return normalizeTarget(readlinkSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Compare two paths in one spelling: Windows answers a junction read with a
 * `\\?\` prefix and treats drive letters case insensitively.
 */
function normalizeTarget(value: string): string {
  const plain = value.startsWith("\\\\?\\") ? value.slice(4) : value;
  const slashed = plain.split("\\").join("/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
