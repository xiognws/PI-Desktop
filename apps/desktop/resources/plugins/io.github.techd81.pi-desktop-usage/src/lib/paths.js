"use strict";

/**
 * Where the two sides keep their session files.
 *
 * The only reason these are overridable is testing: the plugin never writes to
 * either root, and both live outside the open workspace, so nothing here can be
 * reached through the host filesystem gateway.
 */

const os = require("node:os");
const path = require("node:path");

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ cli: string, desktop: string }}
 */
function resolveRoots(env = process.env) {
  const home = env.PI_DESKTOP_USAGE_HOME || os.homedir();
  return {
    cli: env.PI_DESKTOP_USAGE_CLI_ROOT || path.join(home, ".pi", "agent", "sessions"),
    desktop: env.PI_DESKTOP_USAGE_DESKTOP_ROOT || path.join(home, ".pi-desktop", "sessions"),
  };
}

module.exports = { resolveRoots };
