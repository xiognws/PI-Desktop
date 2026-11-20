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

test("a normal launch runs the Rust kernel", () => {
  const launch = resolve({ exists: () => true });
  assert.equal(launch.runtime, "rust");
  assert.deepEqual(launch.args, ["serve"]);
  assert.match(posix(launch.command), /target\/release\/nubo-proto\.exe$/);
  assert.equal(
    launch.env.ELECTRON_RUN_AS_NODE,
    undefined,
    "a standalone binary must not inherit a mode it does not implement",
  );
  assert.equal(launch.fallbackReason, undefined);
});

test("macOS omits the system-CA flag because Electron replaces the roots there", () => {
  const launch = resolve({ platform: "darwin", env: { [AGENT_CORE_SWITCH_ENV]: "node" } });
  assert.deepEqual(launch.args, ["--max-old-space-size=2048", NODE_ENTRY]);
});

test("only an explicit rollback selects the Node sidecar", () => {
  for (const value of ["", "rust", "1", "true"]) {
    const launch = resolve({ env: { [AGENT_CORE_SWITCH_ENV]: value }, exists: () => true });
    assert.equal(launch.runtime, "rust", `value ${JSON.stringify(value)}`);
  }
  for (const value of ["node", " Node ", "NODE"]) {
    const launch = resolve({ env: { [AGENT_CORE_SWITCH_ENV]: value }, exists: () => true });
    assert.equal(launch.runtime, "node", `value ${JSON.stringify(value)}`);
    assert.equal(launch.command, "C:/app/electron.exe");
    assert.deepEqual(launch.args, [
      "--max-old-space-size=2048",
      "--use-system-ca",
      NODE_ENTRY,
    ]);
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
  }
});

test("the Rust kernel is started with serve and without ELECTRON_RUN_AS_NODE", () => {
  const launch = resolve({
    env: { ELECTRON_RUN_AS_NODE: "1" },
    exists: (path) => posix(path).endsWith("target/release/nubo-proto.exe"),
  });
  assert.equal(launch.runtime, "rust");
  assert.deepEqual(launch.args, ["serve"]);
  assert.match(posix(launch.command), /target\/release\/nubo-proto\.exe$/);
  assert.equal(
    launch.env.ELECTRON_RUN_AS_NODE,
    undefined,
    "a standalone binary must not inherit a mode it does not implement",
  );
});

test("an explicitly configured binary beats the packaged and workspace paths", () => {
  const candidates = agentCoreBinaryCandidates({
    env: { [AGENT_CORE_PATH_ENV]: "D:/builds/kernel/nubo-proto.exe" },
    platform: "win32",
    execPath: "C:/app/electron.exe",
    moduleDir: "C:/app/apps/desktop/out/main",
    resourcesPath: "C:/app/resources",
  });
  assert.equal(posix(candidates[0]), "D:/builds/kernel/nubo-proto.exe");
  assert.ok(
    candidates.some((path) => posix(path).startsWith("C:/app/resources/agent-core/")),
    "the packaged location is still searched",
  );
  assert.ok(
    candidates.some((path) => posix(path).startsWith("C:/app/target/release/")),
    "the workspace target directory is searched for a source build",
  );
});

test("a standalone kernel checkout is searched when the environment names one", () => {
  const candidates = agentCoreBinaryCandidates({
    env: { PI_AGENT_CORE_HOME: "E:/103_Hermes_rust" },
    platform: "win32",
    execPath: "C:/app/electron.exe",
    moduleDir: "C:/app/apps/desktop/out/main",
  });
  assert.ok(
    candidates.some((path) => posix(path).startsWith("E:/103_Hermes_rust/target/")),
    "PI_AGENT_CORE_HOME is honoured",
  );
});

test("a packaged install finds the binary in its resources directory", () => {
  const launch = resolve({
    resourcesPath: "C:/app/resources",
    exists: (path) => posix(path) === "C:/app/resources/agent-core/nubo-proto.exe",
  });
  assert.equal(launch.runtime, "rust");
  assert.equal(posix(launch.command), "C:/app/resources/agent-core/nubo-proto.exe");
});

test("a missing binary degrades to Node instead of leaving the app without an agent", () => {
  const launch = resolve({ exists: () => false });
  assert.equal(launch.runtime, "node");
  assert.equal(launch.command, "C:/app/electron.exe");
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
  assert.match(launch.fallbackReason ?? "", /no nubo-proto binary/);
});
