#!/usr/bin/env node
/**
 * Measure what a long session costs on one kernel binary.
 *
 * Runs a fixed scripted conversation against a real gateway and reports the prompt
 * tokens every step was billed for. Point two binaries at it — one before a threshold
 * change, one after — and the same transcript gives the cost of the change:
 *
 *   node scripts/measure-tokens.mjs --kernel target/debug/nubo-proto.exe --label new
 *   node scripts/measure-tokens.mjs --kernel ../old/nubo-proto.exe --label old
 *
 * The document is generated from a seed and the rounds are fixed, so both runs see
 * byte-identical input. `--doc-tokens` sets its size, `--context-window` the window the
 * prompt declares (without it the kernel logs "no model window" and skips every
 * threshold), and `--dump-frames` keeps each round's events for tracing a strange
 * answer back to the request that produced it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const BASE_URL = arg("base-url", "http://127.0.0.1:28787/v1");
const MODEL = arg("model", "wk-deepseek-v4.1-flash-011");
const API_KEY = process.env.KERNEL_LIVE_API_KEY ?? "local-proxy";
const KERNEL = arg("kernel", join(root, "target", "debug", "nubo-proto.exe"));
const LABEL = arg("label", "run");
/** Size of the pasted document, in tokens at the kernel's own 3.5 chars/token. */
const DOC_TOKENS = Number(arg("doc-tokens", "65000"));
/** Follow-up questions after the document turn. */
const ROUNDS = Number(arg("rounds", "4"));
/** The window the prompt declares, i.e. what Settings → Models sends. */
const CONTEXT_WINDOW = Number(arg("context-window", "128000"));
const MAX_TOKENS = Number(arg("max-tokens", "8192"));
const DUMP_FRAMES = process.argv.includes("--dump-frames");

// The host binary opens its SQLite under this directory, and a directory outside the
// repository was measured to fail there (`unable to open database file`, error 14), so
// the default stays under `target/`, which is ignored.
const scratchRoot = process.env.PI_MEASURE_TMP ?? join(root, "target", "measure-tokens");
mkdirSync(scratchRoot, { recursive: true });
const dataDir = mkdtempSync(join(scratchRoot, `measure-${LABEL}-`));
const workspace = join(dataDir, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "README.md"), "# measurement workspace\n", "utf8");

/** A deterministic document: every row carries a code the model can only get by reading. */
function makeDocument(targetTokens) {
  const targetChars = Math.round(targetTokens * 3.5);
  const lines = [];
  let chars = 0;
  for (let row = 0; chars < targetChars; row += 1) {
    const code = ((row * 7919) % 100000).toString().padStart(5, "0");
    const line = `record ${row}: the verification code for row ${row} is ${code}, and its tag is t${row % 97}.`;
    lines.push(line);
    chars += line.length + 1;
  }
  return { text: lines.join("\n"), rows: lines.length };
}

const { text: document, rows } = makeDocument(DOC_TOKENS);

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

function startKernel(binary, events) {
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
  });
  return sidecar;
}

const waitFor = async (predicate, { timeoutMs = 45_000, label = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(150);
  }
  throw new Error(`timed out waiting for ${label}`);
};

let host;
let sidecar;
const report = { label: LABEL, kernel: KERNEL, documentRows: rows, docTokens: DOC_TOKENS, rounds: [] };

try {
  host = new Host(resolveHostBinary(), dataDir, { quiet: process.env.QUIET_HOST === "1" });
  await host.start(PROTOCOL_VERSION);
  const created = await host.call("session.create", { title: "token measure", projectPath: workspace });
  const sessionId = created?.session?.id ?? created?.id;
  await host.call("session.configure", { id: sessionId, mode: "agent" });

  const events = [];
  sidecar = startKernel(KERNEL, events);
  sidecar.setHost(hostLink(host));
  await sidecar.call("sidecar.configure", { dataDir });

  const prompts = [
    `Below is a reference document. Read it carefully and remember it; I will ask about specific rows afterwards.\n\n${document}\n\nReply with exactly: READY`,
  ];
  for (let index = 0; index < ROUNDS; index += 1) {
    const row = 100 + index * 337;
    prompts.push(
      `In the document you just read, what is the verification code for row ${row}? Reply with the five-digit code only.`,
    );
  }

  for (const [index, content] of prompts.entries()) {
    const begun = await host.call("session.beginTurn", {
      sessionId,
      providerId: "local-proxy",
      modelId: MODEL,
    });
    const turnId = String(begun?.turnId ?? "").trim();

    const before = events.length;
    const accepted = await sidecar.call("agent.prompt", {
      sessionId,
      turnId,
      mode: "agent",
      workspaceRoot: workspace,
      projectPath: workspace,
      modelId: MODEL,
      content,
      // Without these two the kernel logs "prompt carries no model window: no
      // ageing, no compaction, no budget" and every threshold is skipped — the
      // measurement would compare two runs that both never compact.
      contextWindow: CONTEXT_WINDOW,
      maxTokens: MAX_TOKENS,
      provider: {
        kind: "openai",
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        name: "local-proxy",
        modelConfig: {
          id: MODEL,
          name: MODEL,
          source: "measurement",
          limit: { context: CONTEXT_WINDOW, input: CONTEXT_WINDOW, output: MAX_TOKENS },
        },
      },
    });
    if (accepted?.accepted !== true) {
      report.rounds.push({ round: index, accepted: false, response: accepted });
      break;
    }
    // A refusal is a turn that ends without `agent_end`: the sidecar reports it as an
    // `error` frame and closes with `status {isRunning:false}`, which is how every
    // failed turn ends. Wait for any of the three, or the run looks like a hang.
    await waitFor(
      () =>
        events.slice(before).some((frame) => {
          const event = frame.event;
          return (
            event.type === "agent_end" ||
            event.type === "error" ||
            (event.type === "status" && event.status?.isRunning === false)
          );
        }),
      { label: `agent_end round ${index}` },
    );

    const frames = events.slice(before).map((frame) => frame.event);
    const usages = frames.filter((frame) => frame.type === "usage").map((frame) => frame.usage ?? frame);
    const compactions = frames.filter((frame) => String(frame.type).includes("compaction")).map((frame) => frame.type);
    const answer = frames
      .filter((frame) => frame.type === "message_end" && frame.message?.role === "assistant")
      .map((frame) => frame.message.content ?? "")
      .join("")
      .trim();

    report.rounds.push({
      round: index,
      accepted: true,
      promptChars: content.length,
      usages,
      compactions,
      answer: answer.slice(0, 80),
      // `--dump-frames` keeps every frame of the round, so a strange answer can be
      // traced to the request that produced it instead of guessed at.
      frames: DUMP_FRAMES
        ? frames.map((frame) => ({
            type: frame.type,
            role: frame.message?.role,
            toolName: frame.toolName,
            isError: frame.isError,
            text: String(
              frame.message?.content ??
                (Array.isArray(frame.message?.parts)
                  ? frame.message.parts.map((part) => part.text ?? "").join("")
                  : "") ??
                frame.result ??
                "",
            ).slice(0, 400),
          }))
        : undefined,
    });

    // Persist the way Electron main does; without these rows the next turn's
    // `session.get` comes back empty and nothing accumulates.
    await host.call("session.appendMessage", {
      sessionId,
      turnId,
      message: {
        id: `user-${index}`,
        role: "user",
        content: index === 0 ? "(reference document pasted)" : content,
        createdAt: new Date().toISOString(),
        status: "complete",
      },
    });
    const assistant = frames.find(
      (frame) => frame.type === "message_end" && frame.message?.role === "assistant",
    )?.message;
    if (assistant) await host.call("session.appendMessage", { sessionId, turnId, message: assistant });
    await host.call("session.endTurn", { sessionId, turnId, status: "complete" });
  }
} catch (error) {
  report.error = String(error?.message ?? error);
} finally {
  try {
    sidecar?.dispose?.();
  } catch {}
  try {
    await host?.stop?.();
  } catch {}
  if (!process.argv.includes("--keep")) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const out = join(scratchRoot, `measure-${LABEL}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2), "utf8");

let totalBilled = 0;
let totalUncached = 0;
console.log(`\n=== ${LABEL} (${KERNEL}) ===`);
for (const round of report.rounds) {
  const usageText = round.usages?.length ? JSON.stringify(round.usages) : "(no usage)";
  for (const usage of round.usages ?? []) {
    // The wire normalises cache hits out of `inputTokens` (the OpenAI adapter
    // subtracts `cached`), so what the provider was billed for is the sum.
    totalBilled +=
      Number(usage.inputTokens ?? 0) +
      Number(usage.cacheReadTokens ?? 0) +
      Number(usage.cacheWriteTokens ?? 0);
    totalUncached += Number(usage.inputTokens ?? 0);
  }
  console.log(
    `round ${round.round}: ${round.promptChars} prompt chars | ${usageText} | compaction=${(round.compactions ?? []).join(",") || "none"} | ${round.answer}`,
  );
}
console.log(`total prompt tokens billed : ${totalBilled}`);
console.log(`  of which uncached        : ${totalUncached}`);
console.log(`json: ${out}`);
if (report.error) {
  console.log(`ERROR: ${report.error}`);
  process.exitCode = 1;
}
