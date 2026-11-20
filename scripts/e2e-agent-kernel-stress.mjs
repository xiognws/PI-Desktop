#!/usr/bin/env node
/**
 * Drive real model turns through the packaged kernel and host-core, forcing tool
 * calls every turn, and count what Kaspersky's behaviour engine logged while it
 * ran.
 *
 * The point is the process surface, not the answer: each turn makes the model run
 * shell commands, write, read and search files, so the kernel -> host-core ->
 * tools.execute path spawns real subprocesses repeatedly. That is the shape a
 * behaviour engine scores.
 *
 *   node scripts/e2e-agent-kernel-stress.mjs --turns 10
 *
 * Provider: `--base-url` / `--model` / key from `PI_STRESS_API_KEY` (or
 * `HERMES_CUSTOM_LOCAL_PROXY_API_KEY`). Defaults to the local intranet gateway.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const TURNS = Number(arg("turns", "10"));
const TURN_TIMEOUT_MS = Number(arg("turn-timeout-ms", "240000"));
const BASE_URL = arg("base-url", "http://127.0.0.1:28787/v1");
const MODEL = arg("model", "wk-deepseek-v4.1-flash-011");
const API_KEY =
  process.env.PI_STRESS_API_KEY ?? process.env.HERMES_CUSTOM_LOCAL_PROXY_API_KEY ?? "";

const unpacked = join(root, "apps", "desktop", "release", "win-unpacked");
const packagedKernel = join(unpacked, "resources", "agent-core", process.platform === "win32" ? "nubo-proto.exe" : "nubo-proto");
const KERNEL = arg("kernel", packagedKernel);
const packagedHost = join(unpacked, "resources", "bin", process.platform === "win32" ? "pi-desktop-host-core.exe" : "pi-desktop-host-core");

const dataDir = join(tmpdir(), `pi-kernel-stress-${Date.now()}`);
const workspace = join(dataDir, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "notes.txt"), "alpha\nbeta\ngamma-needle\n");

const PROMPT = process.env.PI_STRESS_PROMPT ?? [
  "You are a stress-test agent. Do these steps one at a time, using the tools:",
  "1. Bash: `echo stress-hello`",
  "2. Write: create `stress.txt` with the text `written-by-model`",
  "3. Read: read `stress.txt` back",
  "4. Grep: search for `needle` in the workspace",
  "5. Bash: `dir` (or `ls`) to list the workspace",
  "6. Bash: delete `stress.txt`",
  "Answer with one short line when done. Do not skip any step.",
].join("\n");

function kesRecords() {
  const xml =
    spawnSync("wevtutil", ["qe", "Kaspersky Endpoint Security", "/c:200", "/rd:true", "/f:xml"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout ?? "";
  const records = [];
  for (const block of xml.match(/(<Event\b[\s\S]*?<\/Event>)/g) ?? []) {
    const id = /<EventRecordID>(\d+)</.exec(block);
    const eventId = /<EventID[^>]*>(\d+)</.exec(block);
    if (!id) continue;
    records.push({
      record: Number(id[1]),
      eventId: eventId?.[1] ?? "?",
      text: block.replace(/<[^>]+>/g, " "),
    });
  }
  return records;
}

const suspect = /pi-workspace|pi-desktop|host-core|nubo-proto|stress\.txt/i;

let host;
let kernel;
try {
  if (!API_KEY) throw new Error("no API key: set PI_STRESS_API_KEY");
  if (!existsSync(packagedKernel)) throw new Error(`no packaged kernel at ${packagedKernel}`);
  const hostBinary = existsSync(packagedHost) ? packagedHost : resolveHostBinary();

  const baseline = Math.max(0, ...kesRecords().map((r) => r.record));
  console.log(`packaged kernel : ${packagedKernel}`);
  console.log(`host-core       : ${hostBinary}`);
  console.log(`model           : ${MODEL} @ ${BASE_URL}`);
  console.log(`turns           : ${TURNS}`);
  console.log(`workspace       : ${workspace}`);
  console.log(`KES baseline    : ${baseline}`);

  host = new Host(hostBinary, dataDir, { quiet: false });
  await host.start(PROTOCOL_VERSION);
  const created = await host.call("session.create", { title: "kernel stress" });
  const sessionId = created?.session?.id ?? created?.id;
  if (!sessionId) throw new Error("session.create returned no id");

  kernel = new AgentSidecar({
    launch: { command: KERNEL, args: ["serve"], env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir } },
    onStderr: (text) => {
      if (process.env.DEBUG_KERNEL) process.stderr.write(text);
    },
  });
  const events = [];
  kernel.onNotification((method, params) => {
    if (method !== "agent.event") return;
    const envelope = adaptKernelEvent(params);
    if (envelope) events.push(envelope);
  });
  kernel.setHost({
    call: (method, params) => host.call(method, params),
    onNotification: () => () => {},
    onExit: () => () => {},
  });
  await kernel.call("sidecar.configure", { dataDir });

  const provider = {
    kind: "openai",
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    name: "stress",
    modelConfig: { contextWindow: 200000, maxOutputTokens: 4096 },
  };

  // The host refuses a `Bash` call that does not state which shell it runs in
  // (ADR 0054), so the harness asks the host for the effective one — exactly what
  // Electron main stamps on a real prompt.
  const catalog = await host.call("commandShells.list", {}).catch(() => null);
  const effectiveShell =
    catalog?.effective ?? catalog?.shells?.find?.((shell) => shell.isDefault) ?? null;
  const commandShell = effectiveShell
    ? { id: effectiveShell.id, dialect: effectiveShell.dialect }
    : undefined;
  console.log(`command shell   : ${commandShell ? `${commandShell.id}/${commandShell.dialect}` : "(none reported)"}`);

  let toolCalls = 0;
  // Tools wait on the host's permission gate, which a person answers with a card
  // in the app. A headless harness has to be that person: read the pending
  // request and allow it for the session.
  const approvals = { granted: 0 };
  let approving = true;
  const approver = (async () => {
    while (approving) {
      try {
        const pending = await host.call("permissions.pending", { sessionId });
        for (const request of pending?.requests ?? []) {
          if (!request?.requestId) continue;
          await host.call("permissions.resolve", {
            requestId: request.requestId,
            decision: "allow-session",
          });
          approvals.granted += 1;
        }
      } catch {
        /* host busy or shutting down */
      }
      await delay(250);
    }
  })();
  const startedAt = Date.now();
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const turnId = `stress-turn-${turn}`;
    const before = events.length;
    const accepted = await kernel.call("agent.prompt", {
      sessionId,
      turnId,
      content: PROMPT,
      userMessageId: `stress-user-${turn}`,
      provider,
      modelId: MODEL,
      workspaceRoot: workspace,
      projectPath: workspace,
      thinkingLevel: "off",
      ...(commandShell ? { commandShell } : {}),
    });
    if (!accepted?.accepted) throw new Error(`turn ${turn} was not accepted: ${JSON.stringify(accepted)}`);

    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let finished = false;
    while (Date.now() < deadline) {
      await delay(100);
      const mine = events.slice(before);
      if (mine.some((e) => e.event.type === "agent_end")) {
        finished = true;
        break;
      }
    }
    // A turn that is still running owns the session; prompting again would fail
    // with "already has a running turn". Wait for the status to settle.
    if (!finished) {
      const settle = Date.now() + 60_000;
      while (Date.now() < settle) {
        await delay(250);
        const status = await kernel.call("agent.getStatus", { sessionId });
        if (status?.status?.isRunning === false) break;
      }
    }
    const mine = events.slice(before);
    const tools = mine.filter((e) => e.event.type === "tool_start").map((e) => e.event.toolName);
    const toolEnds = mine.filter((e) => e.event.type === "tool_end");
    const toolErrors = toolEnds.filter((e) => e.event.isError);
    const errors = mine.filter((e) => e.event.type === "error");
    toolCalls += tools.length;
    const sample = toolEnds[0]?.event;
    const sampleText = sample
      ? JSON.stringify(sample.result ?? null).replace(/\s+/g, " ").slice(0, 160)
      : "(no tool result)";
    const text = mine
      .filter((e) => e.event.type === "message_end" && e.event.message?.role === "assistant")
      .map((e) => e.event.message.content)
      .join(" ")
      .slice(0, 80)
      .replace(/\s+/g, " ");
    console.log(
      `turn ${String(turn).padStart(2)} ${finished ? "done" : "TIMEOUT"} tools=[${tools.join(",")}] ` +
        `toolErrors=${toolErrors.length}/${toolEnds.length} events=${mine.length} errors=${errors.length} reply="${text}"`,
    );
    console.log(`  first tool result: ${sampleText}`);

    // Persist like main does, so the next turn restores this transcript.
    await host.call("session.appendMessage", {
      sessionId,
      turnId,
      message: {
        id: `stress-user-${turn}`,
        role: "user",
        content: PROMPT,
        createdAt: new Date().toISOString(),
        status: "complete",
      },
    });
    const assistant = mine.find(
      (e) => e.event.type === "message_end" && e.event.message?.role === "assistant",
    );
    if (assistant) {
      await host.call("session.appendMessage", { sessionId, turnId, message: assistant.event.message });
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  approving = false;
  await approver.catch(() => {});
  const fresh = kesRecords().filter((r) => r.record > baseline);
  const hits = fresh.filter((r) => suspect.test(r.text));

  console.log(`\nduration        : ${elapsed}s`);
  console.log(`tool calls      : ${toolCalls}`);
  console.log(`approvals       : ${approvals.granted} (auto-allowed by the harness)`);
  console.log(`KES new records : ${fresh.length}`);
  for (const record of fresh) {
    console.log(`  record ${record.record} event ${record.eventId}${suspect.test(record.text) ? "  <-- names our build" : ""}`);
  }
  console.log(`KES records naming our executables: ${hits.length}`);
  for (const hit of hits) console.log(`  ${hit.eventId}: ${hit.text.replace(/\s+/g, " ").slice(0, 300)}`);

  const verdict = hits.length === 0 && toolCalls > 0 ? "PASS" : "FAIL";
  console.log(`\nRESULT: ${verdict} (turns=${TURNS}, toolCalls=${toolCalls}, kesHits=${hits.length})`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
} catch (error) {
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  try {
    kernel?.dispose?.();
  } catch {
    /* going away anyway */
  }
  try {
    await host?.stop?.();
  } catch {
    /* ignore */
  }
}
