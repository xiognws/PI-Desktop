#!/usr/bin/env node
/**
 * Headless end-to-end check for the Rust kernel as this app's agent runtime.
 *
 * The desktop's agent is now `crates/agent-core` (binary `nubo-proto serve`). This
 * script proves the pieces that only exist when the real processes are wired
 * together, without starting Electron and without touching a user's running app:
 *
 *   1. host-core (real binary) owns the session store and the tools.
 *   2. The kernel answers `sidecar.configure` / `agent.prompt` and streams
 *      `agent.event` frames.
 *   3. Those frames, translated by the same adapter the main process uses, are
 *      persistable: `session.appendMessage` accepts them and `session.get` reads
 *      them back.
 *   4. A *fresh* kernel process restores that transcript from host-core — the
 *      "reopen the app" case — which `agent.tokenReport` reports as history
 *      tokens.
 *
 * The provider is the kernel's own scripted one, so this costs nothing and needs
 * no network. A failure here is a real wiring failure, not a flaky endpoint.
 *
 *   node scripts/e2e-agent-kernel.mjs
 *   node scripts/e2e-agent-kernel.mjs --keep    # leave the temp profile behind
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { adaptKernelEvent } from "../apps/desktop/electron/main/kernel/kernel-adapter.ts";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const keep = process.argv.includes("--keep");
const dataDir = mkdtempSync(join(tmpdir(), "pi-kernel-e2e-"));
const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push(`${name}${detail ? ` (${detail})` : ""}`);
}

function kernelBinary() {
  const configured = process.env.PI_DESKTOP_AGENT_BIN?.trim();
  const names = process.platform === "win32" ? ["nubo-proto.exe"] : ["nubo-proto"];
  const candidates = [
    ...(configured ? [configured] : []),
    ...names.flatMap((name) => [join(root, "target", "debug", name), join(root, "target", "release", name)]),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `no kernel binary found (looked for ${names.join(", ")} under target/debug and target/release); ` +
        "run `cargo build -p agent-core --bin nubo-proto` first",
    );
  }
  return found;
}

/**
 * host-core as the sidecar's reverse-proxy link.
 *
 * `SidecarHostLink` also wants notifications and an exit hook; this harness has
 * no UI to feed, so notifications are dropped (the kernel's own events arrive on
 * its stdio channel) and the exit hook resolves the link.
 */
function hostLink(host) {
  return {
    call: (method, params) => host.call(method, params),
    onNotification: () => () => {},
    onExit: (handler) => {
      let done = false;
      void host.exitPromise.then((info) => {
        if (done) return;
        done = true;
        handler(info);
      });
      return () => {
        done = true;
      };
    },
  };
}

/** Start one kernel process over stdio, wired to the real host. */
function startKernel(binary) {
  const events = [];
  const dropped = [];
  const sidecar = new AgentSidecar({
    launch: {
      command: binary,
      args: ["serve"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PI_DESKTOP_DATA_DIR: dataDir },
    },
    onStderr: (text) => {
      if (process.env.DEBUG_KERNEL) process.stderr.write(text);
    },
  });
  sidecar.onNotification((method, params) => {
    if (method !== "agent.event") return;
    // The same translation the main process runs. A frame it cannot address is
    // counted, not silently ignored.
    const envelope = adaptKernelEvent(params);
    if (envelope) events.push(envelope);
    else dropped.push(params);
  });
  return { sidecar, events, dropped };
}

const waitFor = async (predicate, { timeoutMs = 20_000, label = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};

let host;
let kernel;
try {
  const hostBinary = resolveHostBinary();
  const binary = kernelBinary();
  console.log(`host-core : ${hostBinary}`);
  console.log(`kernel    : ${binary}`);
  console.log(`profile   : ${dataDir}`);

  host = new Host(hostBinary, dataDir, { quiet: false });
  await host.start(PROTOCOL_VERSION);
  const session = await host.call("session.create", { title: "kernel e2e" });
  const sessionId = session?.session?.id ?? session?.session?.sessionId ?? session?.id;
  check("host-core creates a session", Boolean(sessionId), JSON.stringify(session)?.slice(0, 120));
  if (!sessionId) throw new Error("session.create returned no id");

  // ---- first turn: prompt, stream, persist -------------------------------
  kernel = startKernel(binary);
  kernel.sidecar.setHost(hostLink(host));
  const configured = await kernel.sidecar.call("sidecar.configure", { dataDir });
  check("kernel answers sidecar.configure", configured?.mode === "host-proxy", JSON.stringify(configured));

  const turnId = "turn-e2e-1";
  const userMessageId = "user-e2e-1";
  const accepted = await kernel.sidecar.call("agent.prompt", {
    sessionId,
    turnId,
    content: "say hello for the kernel e2e",
    userMessageId,
    provider: { kind: "scripted", script: [{ text: "hello-from-kernel-e2e" }] },
  });
  check("agent.prompt is accepted", accepted?.accepted === true, JSON.stringify(accepted));

  await waitFor(
    () => kernel.events.some((event) => event.event.type === "agent_end"),
    { label: "agent_end" },
  );

  const types = kernel.events.map((event) => event.event.type);
  check("turn_start precedes message_end", types.indexOf("turn_start") < types.indexOf("message_end"));
  check("usage is reported", types.includes("usage"));
  check("every frame was addressable", kernel.dropped.length === 0, `${kernel.dropped.length} dropped`);

  // The turn installed the kernel's built-in declarations. Asking for the count
  // is what proves the desktop's model sees the same tool surface the Node
  // runtime offered — a set that silently emptied would still stream a reply.
  const declared = await kernel.sidecar.call("sidecar.configure", { dataDir });
  check(
    "the kernel declares its built-in tool set",
    typeof declared?.tools === "number" && declared.tools >= 24,
    `tools=${declared?.tools}`,
  );

  const assistantEnd = kernel.events.find(
    (event) => event.event.type === "message_end" && event.event.message?.role === "assistant",
  );
  check(
    "the assistant message carries the answer",
    assistantEnd?.event.message?.content === "hello-from-kernel-e2e",
    JSON.stringify(assistantEnd?.event.message ?? null).slice(0, 160),
  );

  // Persist the way Electron main does: the kernel only emits, main writes.
  const userRow = {
    id: userMessageId,
    role: "user",
    content: "say hello for the kernel e2e",
    createdAt: new Date().toISOString(),
    status: "complete",
  };
  await host.call("session.appendMessage", { sessionId, message: userRow, turnId });
  await host.call("session.appendMessage", {
    sessionId,
    message: assistantEnd.event.message,
    turnId,
  });

  const stored = await host.call("session.get", { id: sessionId });
  const rows = stored?.session?.messages ?? [];
  check("host-core stored the user row", rows.some((row) => row.id === userMessageId));
  check(
    "host-core stored the kernel's answer",
    rows.some((row) => row.role === "assistant" && row.content === "hello-from-kernel-e2e"),
  );

  kernel.sidecar.dispose?.();
  kernel = null;

  // ---- second turn in a fresh process: history must come from host-core ---
  kernel = startKernel(binary);
  const bridgeCalls = [];
  const link = hostLink(host);
  kernel.sidecar.setHost({
    ...link,
    call: (method, params) => {
      bridgeCalls.push(method);
      return link.call(method, params);
    },
  });
  await kernel.sidecar.call("sidecar.configure", { dataDir });
  const second = await kernel.sidecar.call("agent.prompt", {
    sessionId,
    turnId: "turn-e2e-2",
    content: "second turn, the transcript must come back from host-core",
    userMessageId: "user-e2e-2",
    provider: { kind: "scripted", script: [{ text: "second-answer" }] },
  });
  check("the reopened kernel accepts a prompt", second?.accepted === true, JSON.stringify(second));
  await waitFor(
    () => kernel.events.some((event) => event.event.type === "agent_end"),
    { label: "second agent_end" },
  );
  check(
    "the reopened kernel asked host-core for the transcript",
    bridgeCalls.includes("session.get"),
    `bridge calls: ${[...new Set(bridgeCalls)].join(", ") || "none"}`,
  );

  const report = await kernel.sidecar.call("agent.tokenReport", {
    sessionId,
    mode: "agent",
    provider: {
      kind: "scripted",
      script: [{ text: "unused" }],
      modelConfig: { contextWindow: 128000 },
    },
  });
  const historyTokens = report?.request?.historyTokens ?? 0;
  check(
    "the restored transcript is priced into the next request",
    historyTokens > 0,
    `historyTokens=${historyTokens} request=${JSON.stringify(report?.request ?? null)}`,
  );

  console.log("\nchecks:");
  for (const entry of checks) {
    console.log(`  ${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.ok ? "" : `  ${entry.detail ?? ""}`}`);
  }
  console.log(`\nevents: ${kernel.events.length + 0} (second process)`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(`\nERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  try {
    kernel?.sidecar?.dispose?.();
  } catch {
    /* the process is going away either way */
  }
  try {
    await host?.stop?.();
  } catch {
    /* ignore */
  }
  if (!keep) rmSync(dataDir, { recursive: true, force: true });
  else console.log(`kept profile: ${dataDir}`);
}

if (failures.length > 0) {
  console.error(`\nRESULT: FAIL (${failures.length}): ${failures.join(" | ")}`);
  process.exitCode = 1;
} else {
  console.log(`\nRESULT: PASS (${checks.length} checks)`);
}
