import { homedir } from "node:os";
import { resolveAgentDataHome, resolveAgentsHome } from "@pi-workspace/shared";

/**
 * Roots for agent-owned files.
 *
 * The desktop app publishes `PI_HOME` at startup, so a shipped build keeps
 * skills and prompts under its own data root instead of the user's home
 * directory. A bare checkout publishes nothing and keeps the historical
 * `~/.agents` / `~/.pi` layout, which is what makes the same code testable
 * without a running app.
 */
const inputs = () => ({ env: process.env, platform: process.platform, homeDir: homedir() });

/** `~/.agents` historically; `<PI_HOME>/agents` when the app published a root. */
export function agentsHome(): string {
  return resolveAgentsHome(inputs());
}

/** `~/.pi` historically; `<PI_HOME>/pi` when the app published a root. */
export function agentDataHome(): string {
  return resolveAgentDataHome(inputs());
}
