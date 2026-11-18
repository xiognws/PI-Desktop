/**
 * Which agent sidecar this build starts.
 *
 * The desktop runs an out-of-process agent over stdio NDJSON JSON-RPC. Two
 * implementations answer that protocol: the Node sidecar this build has always
 * shipped, and the Rust kernel that is being brought to parity — its own project,
 * checked out beside this one. Both speak the same methods, so the choice is a launch detail and not
 * a contract — which is why it is decided here, by one pure function, instead of
 * branching inside the transport.
 *
 * The Rust kernel stays opt-in until the parity run is green: a build that
 * silently changed the thing running a user's session would be a failure this
 * whole port exists to avoid. `PI_AGENT_CORE=rust` opts in, anything else keeps
 * Node.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Opt-in switch. Only the literal `rust` selects the Rust kernel. */
export const AGENT_CORE_SWITCH_ENV = "PI_AGENT_CORE";
/** Explicit path to the kernel binary, for a machine that built it elsewhere. */
export const AGENT_CORE_PATH_ENV = "PI_AGENT_CORE_BIN";
/**
 * Where the kernel's own checkout lives, for a build from source.
 *
 * The kernel is its own project (`E:\103_Hermes_rust`), not a crate of this
 * repository, so its `target/` directory is not next to this source tree.
 */
export const AGENT_CORE_HOME_ENV = "PI_AGENT_CORE_HOME";
export const AGENT_CORE_DEFAULT_HOME = "E:/103_Hermes_rust";

export const AGENT_CORE_BINARY_NAME = "pi-desktop-agent-core";

export type AgentSidecarRuntime = "node" | "rust";

export type ResolvedAgentSidecarLaunch = {
  runtime: AgentSidecarRuntime;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * Set when the Rust kernel was asked for but could not be started. It is not
   * an error: a developer who has not built the crate yet, or an install whose
   * resources predate the binary, must still get a working agent.
   */
  fallbackReason?: string;
};

export type ResolveAgentSidecarLaunchInput = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** `process.execPath` — Electron itself, which runs the Node sidecar as Node. */
  execPath: string;
  /** Directory of the compiled main-process module, for the dev checkout paths. */
  moduleDir: string;
  /** `process.resourcesPath` when packaged, so `<resources>/agent-core/…` is found. */
  resourcesPath?: string;
  /** Existence probe, injected so the search order is testable without a disk. */
  exists?: (path: string) => boolean;
};

/**
 * Where the kernel binary can be, most specific first.
 *
 * An explicit path wins over everything: it is the only way to point the app at
 * a build outside the repository, which is what a parity run against a
 * candidate binary needs.
 */
export function agentCoreBinaryCandidates(
  input: ResolveAgentSidecarLaunchInput,
): string[] {
  const { env, resourcesPath } = input;
  const explicit = env[AGENT_CORE_PATH_ENV];
  const candidates: string[] = [];
  if (explicit && explicit.trim()) candidates.push(explicit.trim());
  if (resourcesPath) {
    candidates.push(join(resourcesPath, "agent-core", `${AGENT_CORE_BINARY_NAME}.exe`));
    candidates.push(join(resourcesPath, "agent-core", AGENT_CORE_BINARY_NAME));
  }
  // A source build: the kernel has its own checkout and therefore its own
  // target directory.
  const home = env[AGENT_CORE_HOME_ENV]?.trim() || AGENT_CORE_DEFAULT_HOME;
  for (const profile of ["release", "debug"]) {
    const directory = join(home, "target", profile);
    candidates.push(join(directory, `${AGENT_CORE_BINARY_NAME}.exe`));
    candidates.push(join(directory, AGENT_CORE_BINARY_NAME));
  }
  return candidates;
}

/**
 * The Node launch the desktop has always used.
 *
 * Electron runs Node code out of process by being Node: its own executable with
 * `ELECTRON_RUN_AS_NODE`. On macOS the system-CA flag is omitted — Electron 43
 * replaces the bundled roots there instead of adding them (issue #1187), so the
 * sidecar merges system and bundled CAs itself. TLS verification is never
 * bypassed either way.
 */
function nodeLaunch(input: ResolveAgentSidecarLaunchInput, entry: string): ResolvedAgentSidecarLaunch {
  return {
    runtime: "node",
    command: input.execPath,
    args: [
      "--max-old-space-size=2048",
      ...(input.platform === "darwin" ? [] : ["--use-system-ca"]),
      entry,
    ],
    env: { ...input.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function resolveAgentSidecarLaunch(
  input: ResolveAgentSidecarLaunchInput,
  options: { nodeEntry: string },
): ResolvedAgentSidecarLaunch {
  const requested = (input.env[AGENT_CORE_SWITCH_ENV] ?? "").trim();
  if (requested !== "rust") {
    return nodeLaunch(input, options.nodeEntry);
  }
  const exists = input.exists ?? existsSync;
  const binary = agentCoreBinaryCandidates(input).find((candidate) => exists(candidate));
  if (!binary) {
    return {
      ...nodeLaunch(input, options.nodeEntry),
      fallbackReason: `${AGENT_CORE_SWITCH_ENV}=rust but no ${AGENT_CORE_BINARY_NAME} binary was found`,
    };
  }
  // `serve` selects the stdio transport. The environment is the host's, minus
  // the one variable that would make an Electron executable behave as Node:
  // this binary is standalone and must not inherit a mode it does not implement.
  const env = { ...input.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    runtime: "rust",
    command: binary,
    args: ["serve"],
    env,
  };
}
