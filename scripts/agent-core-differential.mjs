/**
 * Differential run: the Node agent sidecar against the Rust kernel.
 *
 * Both answer the same stdio NDJSON JSON-RPC protocol, and the whole point of
 * the Rust port is that nothing above the transport can tell them apart. That
 * claim is only worth what a mechanical comparison proves, so this script drives
 * one identical conversation through both and diffs the answers.
 *
 * Hermetic by construction: a local Chat Completions endpoint that streams a
 * fixed reply, no credentials, no network, no host link. A divergence here is a
 * difference in the two implementations, never in the model.
 *
 *   node scripts/agent-core-differential.mjs
 *   node scripts/agent-core-differential.mjs --verbose
 *
 * Exit code: 0 when the observable behaviour matches, 1 on any divergence.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERBOSE = process.argv.includes("--verbose");

const REPLY = "differential reply";

/** A Chat Completions endpoint that always answers the same way. */
function startFakeProvider() {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (!request.url?.includes("/chat/completions")) {
        response.writeHead(404).end("not found");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta, finish, usage) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-diff",
          object: "chat.completion.chunk",
          created: 1,
          model: "diff-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`;
      response.write(chunk({ role: "assistant", content: "" }, null));
      response.write(chunk({ content: REPLY }, null));
      response.write(chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }));
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePort({ server, port: address.port });
    });
  });
}

/** The prompt payload Electron main really sends. */
function promptFrames(port) {
  const provider = {
    id: "diff-provider",
    name: "Differential",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    modelId: "diff-model",
    apiKey: "diff-key",
    authKind: "api-key",
    apiStyle: "openai-completions",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
  };
  const commandShell = {
    id: "git-bash",
    dialect: "posix",
    label: "Git Bash",
    available: true,
    isDefault: true,
  };
  return [
    { jsonrpc: "2.0", id: 1, method: "sidecar.health", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "sidecar.configure",
      params: { hostBinary: null, dataDir: ROOT, networkProxy: null },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "agent.prompt",
      params: {
        sessionId: "diff-session",
        turnId: "diff-turn",
        content: "say something",
        userMessageId: "diff-user-message",
        provider,
        commandShell,
        mode: "agent",
        thinkingLevel: "off",
      },
    },
    { jsonrpc: "2.0", id: 4, method: "agent.getStatus", params: { sessionId: "diff-session" } },
  ];
}

/**
 * What Electron main answers on the sidecar's reverse `host.proxy` channel.
 *
 * Both implementations ask the host for state they do not own — the session
 * record, tool results, project instructions. A harness that stays silent makes
 * the Node sidecar wait forever before it answers the prompt, which looks like a
 * behavioural difference and is not one; so the harness answers, minimally and
 * identically for both.
 */
const HOST_PROXY_RESULTS = {
  // The Node sidecar refuses a prompt for a session it cannot restore, so the
  // harness reports the session the prompt names, empty on purpose.
  "session.get": { session: { messages: [] } },
  "session.list": { sessions: [] },
  "project.instructions": { instructions: [] },
  "tools.execute": { ok: false, errorCode: "HARNESS_NO_TOOLS", content: "no tools in the harness" },
  "permissions.request": { granted: false },
};

function hostProxyResult(method, log) {
  if (Object.hasOwn(HOST_PROXY_RESULTS, method)) return HOST_PROXY_RESULTS[method];
  log.push(method);
  return { ok: false, errorCode: "HARNESS_UNSUPPORTED", message: `harness has no ${method}` };
}

/** Run one sidecar to completion and return the frames it emitted. */
function runSidecar({ label, command, args, frames, cwd }) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let stderr = "";
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolveRun({ label, frames: out, stderr, reason, hostCalls });
    };
    const timer = setTimeout(() => finish("timeout"), 30_000);

    const hostCalls = [];
    const reply = (frame) =>
      child.stdin.write(JSON.stringify(frame) + "\n");

    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (text) => {
      buffer += text;
      // NDJSON: one frame per line, and a partial line means a partial frame.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let frame;
        try {
          frame = JSON.parse(trimmed);
        } catch {
          out.push({ unparsed: trimmed });
          continue;
        }
        out.push(frame);
        if (frame.method === "host.proxy" && frame.id !== undefined) {
          if (process.env.DIFF_DUMP_HOST) {
            const p = frame.params?.params ?? {};
            const m = p.message ?? {};
            console.log(
              "HOSTCALL",
              frame.params?.method,
              JSON.stringify({
                keys: Object.keys(p),
                role: m.role,
                id: m.id,
                messageKeys: Object.keys(m),
                contentLength: typeof m.content === "string" ? m.content.length : typeof m.content,
                toolName: p.toolName,
                query: p.query,
              }),
            );
          }
          const proxied = frame.params?.method ?? "";
          hostCalls.push(proxied);
          reply({
            jsonrpc: "2.0",
            id: frame.id,
            result: hostProxyResult(proxied, hostCalls),
          });
        }
      }
      if (out.some((frame) => frame.method === "agent.event" && frame.params?.event?.type === "agent_end")) {
        finish("agent_end");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => (stderr += text));
    child.on("error", (error) => {
      stderr += String(error);
      finish("spawn error");
    });
    child.stdin.write(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  });
}

const VOLATILE_KEYS = new Set([
  "id",
  "turnId",
  "sessionId",
  "messageId",
  "parentToolCallId",
  "createdAt",
  "createdAtMs",
  "timestamp",
  "ts",
  "durationMs",
  "elapsedMs",
  "usage",
  "tokens",
  "cost",
  "uuid",
]);

/** Strip everything a correct implementation is allowed to differ on. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (VOLATILE_KEYS.has(key)) {
      out[key] = "<volatile>";
      continue;
    }
    out[key] = normalize(entry);
  }
  return out;
}

/** Shapes only: key sets, not values, for the diagnostic fields. */
function keyShape(value) {
  if (Array.isArray(value)) return value.length ? [keyShape(value[0])] : [];
  if (!value || typeof value !== "object") return typeof value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, keyShape(value[key])]),
  );
}

function summarize(frames) {
  const results = new Map();
  const events = [];
  const errors = [];
  for (const frame of frames) {
    if (frame.method === "agent.event") {
      const event = frame.params?.event;
      if (event?.type) events.push(event.type);
      continue;
    }
    if (typeof frame.id === "number" && "result" in frame) {
      results.set(frame.id, frame.result);
    }
    if (typeof frame.id === "number" && "error" in frame) {
      errors.push({ id: frame.id, error: frame.error });
    }
  }
  return { results, events, errors };
}

function eventSignature(events) {
  // Consecutive duplicates collapse: a chunked stream emits message_update many
  // times, and how many chunks an implementation produces is not a contract.
  return events.filter((type, index) => type !== events[index - 1]);
}

/**
 * Differences that are known, deliberate, and harmless — with the reason.
 *
 * An allow-list only stays honest if it is specific and narrow: each entry names
 * one thing and says why it is acceptable. Anything else still fails the run,
 * which is the point of comparing at all.
 */
const KNOWN_GAPS = {
  extraEvents: {
    // The kernel announces the idle state after the turn; the Node side does
    // not. A client that watches events learns strictly more, never less.
    status: "the kernel also announces the idle status after agent_end",
    // Main persists assistant text from `message_update`; the kernel streams it,
    // the Node side only settles the row at `message_end`.
    message_update: "the kernel streams incremental assistant text, the Node side does not",
  },
  missingEvents: {
    // A background pass that reviews the transcript and proposes skills.
    skill_review: "background skill review is not ported yet",
  },
  missingHostCalls: {
    tools: "file-batch capability probing is a Node-side read optimisation",
    session: "the system-prompt journal row is not written yet",
  },
};

const reasonFor = (table, name) =>
  Object.entries(table).find(([key]) => name.startsWith(key))?.[1];

function diff(label, left, right, report) {
  if (JSON.stringify(left) === JSON.stringify(right)) return;
  report.push({ label, left, right });
}

/**
 * Compare result shapes the way a caller experiences them: every key the Node
 * sidecar returns must exist here with the same shape, while additional keys are
 * additive diagnostics and not a difference.
 */
function diffShape(label, nodeShape, rustShape, report) {
  if (!nodeShape || typeof nodeShape !== "object") {
    diff(label, nodeShape, rustShape, report);
    return;
  }
  const missing = Object.keys(nodeShape).filter((key) => !(key in (rustShape ?? {})));
  if (missing.length > 0) {
    report.push({ label: `${label} (missing keys)`, left: Object.keys(nodeShape), right: Object.keys(rustShape ?? {}) });
  }
  for (const key of Object.keys(nodeShape)) {
    if (!(key in (rustShape ?? {}))) continue;
    diffShape(`${label}.${key}`, nodeShape[key], rustShape[key], report);
  }
}

const { server, port } = await startFakeProvider();
const frames = promptFrames(port);

const rustBinary = process.env.PI_AGENT_CORE_BIN?.trim()
  ? process.env.PI_AGENT_CORE_BIN.trim()
  : join(ROOT, "target/release/pi-desktop-agent-core.exe");
if (!existsSync(rustBinary)) {
  console.error(`missing Rust kernel: ${rustBinary}\nbuild it with: cargo build -p agent-core --release --offline`);
  server.close();
  process.exit(2);
}

const nodeSidecar = join(ROOT, "packages/agent-runtime/dist/sidecar.js");
if (!existsSync(nodeSidecar)) {
  console.error(`missing Node sidecar: ${nodeSidecar}\nbuild it with: pnpm build:js`);
  server.close();
  process.exit(2);
}

const [nodeRun, rustRun] = await Promise.all([
  runSidecar({ label: "node", command: process.execPath, args: [nodeSidecar], frames, cwd: ROOT }),
  runSidecar({ label: "rust", command: rustBinary, args: ["serve"], frames, cwd: ROOT }),
]);
server.close();

const nodeSummary = summarize(nodeRun.frames);
const rustSummary = summarize(rustRun.frames);
const report = [];

const knownGaps = [];
const countBy = (list) =>
  list.reduce((counts, entry) => counts.set(entry, (counts.get(entry) ?? 0) + 1), new Map());

/**
 * Compare what each side produced, ignoring order and volume.
 *
 * Order is not the contract — `usage` before or after `message_end` changes
 * nothing a client depends on — but *presence* is: a client that waits for an
 * event must receive it.
 */
function diffPresence(label, nodeList, rustList, allowedMissing, allowedExtra, report) {
  const node = countBy(nodeList);
  const rust = countBy(rustList);
  for (const name of new Set([...node.keys(), ...rust.keys()])) {
    const nodeCount = node.get(name) ?? 0;
    const rustCount = rust.get(name) ?? 0;
    if (nodeCount > 0 && rustCount === 0) {
      const reason = reasonFor(allowedMissing, name);
      if (reason) knownGaps.push({ label: `${label}: ${name} (node only)`, reason });
      else report.push({ label: `${label}: missing ${name}`, left: nodeCount, right: 0 });
      continue;
    }
    if (rustCount > 0 && nodeCount === 0) {
      const reason = reasonFor(allowedExtra, name);
      if (reason) knownGaps.push({ label: `${label}: ${name} (kernel only)`, reason });
      else report.push({ label: `${label}: unexpected ${name}`, left: 0, right: rustCount });
    }
  }
}

diffPresence(
  "events",
  nodeSummary.events,
  rustSummary.events,
  KNOWN_GAPS.missingEvents,
  KNOWN_GAPS.extraEvents,
  report,
);

// Presence is checked above; this checks the order of the events a turn cannot
// reorder. Events outside the spine (a usage report, a review pass, a status
// snapshot) may legitimately move around; a turn that ends its message before
// starting it may not.
const TURN_SPINE = ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"];
const spine = (events) =>
  eventSignature(events).filter((type) => TURN_SPINE.includes(type));
const nodeSpine = spine(nodeSummary.events);
const rustSpine = spine(rustSummary.events);
if (JSON.stringify(nodeSpine) !== JSON.stringify(rustSpine)) {
  report.push({ label: "turn event order", left: nodeSpine, right: rustSpine });
}
for (const id of new Set([...nodeSummary.results.keys(), ...rustSummary.results.keys()])) {
  diffShape(
    `method #${id} result`,
    keyShape(nodeSummary.results.get(id)),
    keyShape(rustSummary.results.get(id)),
    report,
  );
}
diffPresence(
  "host calls",
  nodeRun.hostCalls,
  rustRun.hostCalls,
  KNOWN_GAPS.missingHostCalls,
  {},
  report,
);
diff(
  "error frames",
  nodeSummary.errors.map((entry) => entry.error.code ?? entry.error.message),
  rustSummary.errors.map((entry) => entry.error.code ?? entry.error.message),
  report,
);

console.log("differential run");
console.log(`  node: ${nodeRun.reason}, ${nodeRun.frames.length} frames, events: ${eventSignature(nodeSummary.events).join(" -> ")}`);
console.log(`  rust: ${rustRun.reason}, ${rustRun.frames.length} frames, events: ${eventSignature(rustSummary.events).join(" -> ")}`);
if (VERBOSE) {
  console.log("\nnode results:", JSON.stringify([...nodeSummary.results], null, 2));
  console.log("\nrust results:", JSON.stringify([...rustSummary.results], null, 2));
  if (nodeSummary.errors.length)
    console.log("\nnode errors:", JSON.stringify(nodeSummary.errors, null, 2));
  if (rustSummary.errors.length)
    console.log("\nrust errors:", JSON.stringify(rustSummary.errors, null, 2));
  if (nodeRun.stderr.trim())
    console.log("\nnode stderr:", nodeRun.stderr.trim().slice(0, 2000));
  if (rustRun.stderr.trim()) console.log("\nrust stderr:", rustRun.stderr.trim().slice(0, 2000));
}

if (knownGaps.length > 0) {
  console.log(`\nknown gaps (${knownGaps.length}), documented and deliberate:`);
  for (const gap of knownGaps) {
    console.log(`  - ${gap.label}: ${gap.reason}`);
  }
}

if (report.length === 0) {
  console.log("\nRESULT: no unexpected divergence");
  process.exit(0);
}
console.log(`\nRESULT: ${report.length} unexpected divergence(s)`);
for (const entry of report) {
  console.log(`\n- ${entry.label}`);
  console.log("  node:", JSON.stringify(entry.left));
  console.log("  rust:", JSON.stringify(entry.right));
}
if (!VERBOSE) {
  console.log("\nre-run with --verbose for the full frame bodies");
}
process.exit(1);
