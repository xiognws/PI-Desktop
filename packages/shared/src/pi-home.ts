/**
 * Where this product keeps everything a user owns: database, browser profile,
 * skills, agent prompts, plugin data.
 *
 * The desktop app decides the actual root once, at startup, and publishes it as
 * `PI_HOME` before any writer runs. That publication is what makes the answer to
 * "which directory is live" have exactly one answer: the resolver below prefers
 * the published root and only falls back to the historical home-directory
 * layout when nothing was published (a bare checkout, a test, a CLI).
 *
 * Kept free of `node:` imports on purpose: this module is bundled into the
 * renderer as well, and a `node:os` import there would break the build.
 */

/** Environment variable carrying the resolved root to every child process. */
export const PI_HOME_ENV = "PI_HOME";

/** Folder name `D:\<name>` on Windows, `~/.<name>` elsewhere as a fallback. */
export const PI_HOME_DIR_NAME = "PiWorkspace";

/** Subdirectories a full installation owns below the root. */
export const PI_HOME_SUBDIRECTORIES = [
  "data",
  "userdata",
  "agents",
  "pi",
  "pi-diff-view",
  "pi-workbuddy-connect",
] as const;

export type PiHomeInputs = {
  env?: Record<string, string | undefined>;
  platform?: string;
  homeDir?: string;
};

/**
 * The root that holds every file this product writes.
 *
 * Order: explicit `PI_HOME`, then the release root the desktop app published,
 * then the platform default. The Windows default is a fixed drive path rather
 * than a home-directory dotfile because the database must not sit on the system
 * drive; other platforms keep the conventional hidden directory.
 */
export function resolvePiHome({ env = {}, platform = process.platform, homeDir = "" }: PiHomeInputs = {}): string {
  const published = env[PI_HOME_ENV]?.trim();
  if (published) return published;
  if (platform === "win32") return `D:\\${PI_HOME_DIR_NAME}`;
  const base = homeDir.trim() || ".";
  return `${base}/.${PI_HOME_DIR_NAME.toLowerCase()}`;
}

/** Root-relative path for a subdirectory, without a `node:path` dependency. */
export function piHomeSubdirectory(name: string, inputs: PiHomeInputs = {}): string {
  const root = resolvePiHome(inputs).replace(/[\\/]+$/, "");
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root}${separator}${name}`;
}

/**
 * Directory holding skills. The historical layout is `~/.agents`; under a
 * published root it is `<root>/agents`, which is the same shape one level down.
 */
export function resolveAgentsHome(inputs: PiHomeInputs = {}): string {
  const published = (inputs.env ?? {})[PI_HOME_ENV]?.trim();
  if (published) return piHomeSubdirectory("agents", inputs);
  const base = (inputs.homeDir ?? "").trim() || ".";
  return `${base}/.agents`;
}

/** Directory holding agent prompts and sessions; historical `~/.pi/agent`. */
export function resolveAgentDataHome(inputs: PiHomeInputs = {}): string {
  const published = (inputs.env ?? {})[PI_HOME_ENV]?.trim();
  if (published) return piHomeSubdirectory("pi", inputs);
  const base = (inputs.homeDir ?? "").trim() || ".";
  return `${base}/.pi`;
}
