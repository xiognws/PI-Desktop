#!/usr/bin/env node
/**
 * The kernel against a real model, through the same wiring the app uses.
 *
 * `e2e-agent-kernel.mjs` proves the plumbing with a scripted provider: no
 * network, no cost, and no evidence that a model can actually do work on this
 * kernel. This run uses a real endpoint so the turn has to survive the thing the
 * harness cannot fake — a provider stream, a tool round trip the model asked for
 * on its own, and host-core writing the result.
 *
 *   node scripts/e2e-agent-kernel-live.mjs
 *   node scripts/e2e-agent-kernel-live.mjs --model wk-deepseek-v4.1-flash-011
 *
 * The model id is pinned: whatever `config.yaml` calls its default is an alias the
 * gateway may re-point, and a capability run against the wrong model fails in
 * ways that look like kernel bugs.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { adaptKernelEvent } from "../apps/desktop/electron/main/kernel/kernel-adapter.ts";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

/**
 * The gateway this machine actually serves models from. It is pinned here rather
 * than read from a config file on purpose: this script runs outside Electron, so
 * there is no provider resolver to borrow, and a silent fallback to some other
 * endpoint would make a pass mean nothing.
 */
const BASE_URL = arg("base-url", "http://127.0.0.1:28787/v1");
const MODEL = arg("model", "wk-deepseek-v4.1-flash-011");
const API_KEY = process.env.KERNEL_LIVE_API_KEY ?? "local-proxy";

const scratchRoot = process.env.PI_KERNEL_LIVE_TMP ?? "E:/99_Hermes/tmp";
mkdirSync(scratchRoot, { recursive: true });
const dataDir = mkdtempSync(join(scratchRoot, "kernel-live-"));
const workspace = join(dataDir, "workspace");
mkdirSync(workspace, { recursive: true });
const NOTE = "the answer line is: kernel-live-ok";
writeFileSync(join(workspace, "note.txt"), `${NOTE}\n`, "utf8");

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(`${name}${detail ? ` (${detail})` : ""}`);
}

function kernelBinary() {
  const configured = process.env.PI_DESKTOP_AGENT_BIN?.trim();
  const names = process.platform === "win32" ? ["nubo-proto.exe"] : ["nubo-proto"];
  const candidates = [
    ...(configured ? [configured] : []),
    ...names.flatMap((name) => [join(root, "target", "debug", name), join(root, "target", "release", name)]),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("no kernel binary under target/debug or target/release");
  return found;
}

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
    const envelope = adaptKernelEvent(params);
    if (envelope) events.push(envelope);
    else dropped.push(params);
  });
  return { sidecar, events, dropped };
}

const waitFor = async (predicate, { timeoutMs = 180_000, label = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
};

let host;
let kernel;
let exitCode = 0;
try {
  console.log(`endpoint  : ${BASE_URL}`);
  console.log(`model     : ${MODEL}`);
  console.log(`workspace : ${workspace}`);

  host = new Host(resolveHostBinary(), dataDir, { quiet: true });
  await host.start(PROTOCOL_VERSION);
  const created = await host.call("session.create", { title: "kernel live", projectPath: workspace });
  const sessionId = created?.session?.id ?? created?.id;
  check("host-core creates a session", Boolean(sessionId), JSON.stringify(created)?.slice(0, 120));

  kernel = startKernel(kernelBinary());
  kernel.sidecar.setHost(hostLink(host));
  const configured = await kernel.sidecar.call("sidecar.configure", { dataDir });
  check("kernel answers sidecar.configure", configured?.mode === "host-proxy");

  // Electron main does this before every prompt, and host-core will not let a
  // tool write into a turn it never opened — `TodoWrite` comes back as
  // `TOOL_TURN_CANCELLED` without it.
  await host.call("session.configure", { id: sessionId, mode: "agent" });
  const begun = await host.call("session.beginTurn", {
    sessionId,
    providerId: "local-proxy",
    modelId: MODEL,
  });
  const turnId = String(begun?.turnId ?? "").trim();
  check("host-core opened the turn", turnId.length > 0, JSON.stringify(begun).slice(0, 120));

  const accepted = await kernel.sidecar.call("agent.prompt", {
    sessionId,
    turnId,
    mode: "agent",
    workspaceRoot: workspace,
    projectPath: workspace,
    modelId: MODEL,
    content:
      "Two steps, in this order. 1) Use the Read tool on note.txt. " +
      "2) Use TodoWrite to record exactly two items: the first completed with the line you read, " +
      "the second pending and called 'report'. Then reply with the single word DONE and nothing else.",
    provider: { kind: "openai", baseUrl: BASE_URL, apiKey: API_KEY, name: "local-proxy" },
  });
  check("agent.prompt is accepted", accepted?.accepted === true, JSON.stringify(accepted));

  await waitFor(() => kernel.events.some((event) => event.event.type === "agent_end"), {
    label: "agent_end",
  });

  const events = kernel.events.map((event) => event.event);
  check("every frame was addressable", kernel.dropped.length === 0, `${kernel.dropped.length} dropped`);
  check("usage is reported", events.some((event) => event.type === "usage"));

  const starts = events.filter((event) => event.type === "tool_start");
  const ends = events.filter((event) => event.type === "tool_end");
  const toolNames = starts.map((event) => event.toolName);
  console.log(`tools run : ${toolNames.join(", ") || "(none)"}`);

  check("the model read the file", toolNames.includes("Read"), toolNames.join(","));
  check("the model wrote the checklist", toolNames.includes("TodoWrite"), toolNames.join(","));
  const failed = ends.filter((event) => event.isError === true);
  check(
    "no tool call failed",
    failed.length === 0,
    JSON.stringify(failed.map((event) => [event.toolCallId, String(event.result ?? "").slice(0, 300)])),
  );

  const read = ends.find((event) => {
    const start = starts.find((candidate) => candidate.toolCallId === event.toolCallId);
    return start?.toolName === "Read";
  });
  check(
    "the file's content came back to the model",
    JSON.stringify(read?.result ?? "").includes("kernel-live-ok"),
    JSON.stringify(read?.result ?? null).slice(0, 200),
  );

  // The checklist the user watches is host-core's, so the proof is in the table —
  // not in the kernel's transcript, which would pass even if nothing was written.
  const todos = await host.call("todos.get", { sessionId });
  const items = todos?.todos ?? todos?.items ?? [];
  check("host-core stored the checklist", items.length === 2, JSON.stringify(todos).slice(0, 240));
  check(
    "the first item is completed and the second pending",
    items[0]?.status === "completed" && items[1]?.status === "pending",
    JSON.stringify(items.map((item) => [item.status, item.content])).slice(0, 240),
  );

  const answer = events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message.content ?? "")
    .join("")
    .trim();
  check("the model answered", answer.length > 0, JSON.stringify(answer).slice(0, 120));
  check("the answer is the requested word", answer.includes("DONE"), JSON.stringify(answer).slice(0, 120));

  // Close the durable turn the way main does, so host-core does not leave a turn
  // running for a session nobody is prompting any more.
  await host.call("session.endTurn", { sessionId, turnId, status: "complete" });

  // The kernel only emits; main persists. Nothing in this harness wrote the
  // transcript yet, so append the two rows the same way `persistence-outbox`
  // does and read them back — that is what proves an adapted frame is storable.
  const assistantRow = events.find(
    (event) => event.type === "message_end" && event.message?.role === "assistant",
  )?.message;
  if (assistantRow) {
    await host.call("session.appendMessage", {
      sessionId,
      turnId,
      message: {
        id: "user-live-1",
        role: "user",
        content: "read note.txt and record the checklist",
        createdAt: new Date().toISOString(),
        status: "complete",
      },
    });
    await host.call("session.appendMessage", { sessionId, turnId, message: assistantRow });
  }
  const after = await host.call("session.get", { id: sessionId, messageLimit: 50 });
  const rows = after?.session?.messages ?? [];
  check(
    "host-core kept both rows",
    rows.some((row) => row.role === "user") && rows.some((row) => row.role === "assistant"),
    `${rows.length} rows`,
  );
} catch (error) {
  check("run completed without throwing", false, String(error?.message ?? error));
  exitCode = 1;
} finally {
  try {
    kernel?.sidecar?.dispose?.();
  } catch {}
  try {
    await host?.stop?.();
  } catch {}
  if (!process.argv.includes("--keep")) rmSync(dataDir, { recursive: true, force: true });
}

console.log("\nchecks:");
for (const entry of checks) {
  console.log(`  ${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.ok || !entry.detail ? "" : ` — ${entry.detail}`}`);
}
const failedCount = checks.filter((entry) => !entry.ok).length;
console.log(`\nRESULT: ${failedCount === 0 ? "PASS" : "FAIL"} (${checks.length} checks)`);
process.exit(failedCount === 0 ? exitCode : 1);
