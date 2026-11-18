/**
 * Which sidecar the desktop starts.
 *
 * The protocol is identical between the Node sidecar and the Rust kernel, so the
 * only thing worth testing here is the decision: that a normal launch is
 * unchanged, that the Rust kernel needs an explicit opt-in, and that a missing
 * binary degrades to Node instead of leaving the app with no agent at all.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { join } from "node:path";

import {
  AGENT_CORE_PATH_ENV,
  AGENT_CORE_SWITCH_ENV,
  agentCoreBinaryCandidates,
  resolveAgentSidecarLaunch,
} from "../electron/main/agent-sidecar-launch.ts";

const NODE_ENTRY = "C:/app/packages/agent-runtime/dist/sidecar.js";

/** Separator-independent path, because `join` produces `\` on Windows. */
const posix = (path) => path.replaceAll("\\", "/");

function resolve({ env = {}, platform = "win32", exists = () => false, resourcesPath } = {}) {
  return resolveAgentSidecarLaunch(
    {
      env,
      platform,
      execPath: "C:/app/electron.exe",
      moduleDir: "C:/app/apps/desktop/electron/main",
      ...(resourcesPath ? { resourcesPath } : {}),
      exists,
    },
    { nodeEntry: NODE_ENTRY },
  );
}

test("a normal launch runs the Node sidecar exactly as before", () => {
  const launch = resolve();
  assert.equal(launch.runtime, "node");
  assert.equal(launch.command, "C:/app/electron.exe");
  assert.deepEqual(launch.args, [
    "--max-old-space-size=2048",
    "--use-system-ca",
    NODE_ENTRY,
  ]);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(launch.fallbackReason, undefined);
});

test("macOS omits the system-CA flag because Electron replaces the roots there", () => {
  const launch = resolve({ platform: "darwin" });
  assert.deepEqual(launch.args, ["--max-old-space-size=2048", NODE_ENTRY]);
});

test("only an explicit opt-in selects the Rust kernel", () => {
  for (const value of ["", "node", "Node", "true", "1", "r\x75st "]) {
    const launch = resolve({ env: { [AGENT_CORE_SWITCH_ENV]: value }, exists: () => true });
    assert.equal(
      launch.runtime,
      value === "r\x75st " ? "rust" : "node",
      `value ${JSON.stringify(value)}`,
    );
  }
});

test("the Rust kernel is started with serve and without ELECTRON_RUN_AS_NODE", () => {
  const launch = resolve({
    env: { [AGENT_CORE_SWITCH_ENV]: "rust", ELECTRON_RUN_AS_NODE: "1" },
    exists: (path) => posix(path).endsWith("target/release/pi-desktop-agent-core.exe"),
  });
  assert.equal(launch.runtime, "rust");
  assert.deepEqual(launch.args, ["serve"]);
  assert.match(posix(launch.command), /target\/release\/pi-desktop-agent-core\.exe$/);
  assert.equal(
    launch.env.ELECTRON_RUN_AS_NODE,
    undefined,
    "a standalone binary must not inherit a mode it does not implement",
  );
});

test("an explicitly configured binary beats the packaged and checkout paths", () => {
  const candidates = agentCoreBinaryCandidates({
    env: { [AGENT_CORE_PATH_ENV]: "D:/builds/kernel/pi-desktop-agent-core.exe" },
    platform: "win32",
    execPath: "C:/app/electron.exe",
    moduleDir: "C:/app/apps/desktop/electron/main",
    resourcesPath: "C:/app/resources",
  });
  assert.equal(posix(candidates[0]), "D:/builds/kernel/pi-desktop-agent-core.exe");
  assert.ok(
    candidates.some((path) => posix(path).startsWith("C:/app/resources/agent-core/")),
    "the packaged location is still searched",
  );
  assert.ok(
    candidates.some((path) => posix(path).includes("target/release")),
    "the development checkout is still searched last",
  );
  // Cargo builds a workspace member into the workspace target directory, which
  // is the repository root here — not the crate's own directory.
  assert.ok(
    candidates.some(
      (path) => posix(path) === "C:/app/target/release/pi-desktop-agent-core.exe",
    ),
    "the workspace target directory is searched",
  );
});

test("a packaged install finds the binary in its resources directory", () => {
  const launch = resolve({
    env: { [AGENT_CORE_SWITCH_ENV]: "rust" },
    resourcesPath: "C:/app/resources",
    exists: (path) =>
      posix(path) === "C:/app/resources/agent-core/pi-desktop-agent-core.exe",
  });
  assert.equal(launch.runtime, "rust");
  assert.equal(
    posix(launch.command),
    "C:/app/resources/agent-core/pi-desktop-agent-core.exe",
  );
});

test("a missing binary degrades to Node instead of leaving the app without an agent", () => {
  const launch = resolve({ env: { [AGENT_CORE_SWITCH_ENV]: "rust" }, exists: () => false });
  assert.equal(launch.runtime, "node");
  assert.equal(launch.command, "C:/app/electron.exe");
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
  assert.match(launch.fallbackReason ?? "", /no pi-desktop-agent-core binary/);
});
