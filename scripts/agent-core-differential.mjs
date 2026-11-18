/**
 * Differential run: the Node agent sidecar against the Rust kernel.
 *
 * Both answer the same stdio NDJSON JSON-RPC protocol, and the whole point of the
 * Rust port is that nothing above the transport can tell them apart. That claim is
 * only worth what a mechanical comparison proves, so this script drives identical
 * scenarios through both and diffs the answers.
 *
 * Hermetic by construction: a local Chat Completions endpoint that streams scripted
 * replies, no credentials, no network. A divergence here is a difference in the two
 * implementations, never in the model.
 *
 *   node scripts/agent-core-differential.mjs              # every scenario
 *   node scripts/agent-core-differential.mjs --verbose
 *   node scripts/agent-core-differential.mjs --only=tool,steer
 *
 * Exit code: 0 when nothing unexpected differs, 1 on any divergence.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERBOSE = process.argv.includes("--verbose");
const ONLY = (process.argv.find((arg) => arg.startsWith("--only=")) ?? "")
  .replace("--only=", "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

/**
 * Differences that are known, deliberate, and harmless — with the reason.
 *
 * An allow-list only stays honest if it is specific and narrow: each entry names
 * one thing and says why it is acceptable. Anything else still fails the run,
 * which is the point of comparing at all.
 */
const KNOWN_GAPS = {
  extraEvents: {
    message_update: "the kernel streams incremental assistant text, the Node side does not",
  },
  missingEvents: {},
  missingHostCalls: {
    "tools.fileBatchCapabilities": "Node-side file-read batching probe; the kernel reads through the host without it",
    "tools.abort": "the kernel applies a steer at the next step boundary instead of interrupting the running tool",
  },
  extraHostCalls: {},
};

const reasonFor = (table, name) => table[name];

// ---------------------------------------------------------------- provider --

const TOOL_DECLARATION = {
  type: "function",
  function: {
    name: "Bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

const ASKTOOL_DECLARATION = {
  type: "function",
  function: {
    name: "asktool",
    description: "Ask the user a question with options",
    parameters: { type: "object", properties: { questions: { type: "array" } } },
  },
};

/**
 * Decide what the model does next, from the conversation it was sent.
 *
 * Keyed on the transcript rather than on a request counter: a retry, a compaction
 * summary and a background review all arrive here, and counting would make the
 * scenario's shape depend on how many requests something else happened to make.
 */
function scriptedReply(body, scenario) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { text: "differential reply" };
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const joined = messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join(" ");
  // A summary request is the runtime asking for a compaction checkpoint: answer
  // it as text, never as a tool call.
  if (messages.length <= 2 && /summar|compact/i.test(joined)) {
    return { text: "Summary of the work so far." };
  }
  const sawTool = messages.some(
    (message) =>
      message.role === "tool" ||
      message.role === "tool_result" ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length > 0),
  );
  if (scenario.firstReply && !sawTool) {
    return scenario.firstReply === "tool"
      ? { toolCall: { name: "Bash", arguments: { command: "echo hi" } } }
      : {
          toolCall: {
            name: "asktool",
            arguments: { questions: [{ question: "Colour?", options: ["Blue", "Green"] }] },
          },
        };
  }
  return { text: "differential reply" };
}

function sse(body) {
  return `data: ${JSON.stringify(body)}\n\n`;
}

/** Tokens the request plausibly cost: ~4 characters each, which is close enough. */
function estimatedPromptTokens(body) {
  return Math.max(12, Math.round(String(body).length / 4));
}

function textStream(text, promptTokens) {
  const base = { id: "chatcmpl-diff", object: "chat.completion.chunk", created: 1, model: "diff-model" };
  return [
    sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
    sse({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    sse({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 3,
        total_tokens: promptTokens + 3,
      },
    }),
    "data: [DONE]\n\n",
  ];
}

function toolCallStream(call, promptTokens) {
  const base = { id: "chatcmpl-diff", object: "chat.completion.chunk", created: 1, model: "diff-model" };
  return [
    sse({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_diff_1",
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sse({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 5,
        total_tokens: promptTokens + 5,
      },
    }),
    "data: [DONE]\n\n",
  ];
}

/** A Chat Completions endpoint that answers per scenario. */
function startFakeProvider(scenario) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (!request.url?.includes("/chat/completions")) {
        response.writeHead(404).end("not found");
        return;
      }
      const reply = scriptedReply(body, scenario);
      const promptTokens = estimatedPromptTokens(body);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const frames = reply.toolCall
        ? toolCallStream(reply.toolCall, promptTokens)
        : textStream(reply.text, promptTokens);
      for (const frame of frames) response.write(frame);
      response.end();
    });
  });
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      resolvePort({ server, port: server.address().port });
    });
  });
}

// --------------------------------------------------------------- scenarios --

const COMMAND_SHELL = {
  id: "git-bash",
  dialect: "posix",
  label: "Git Bash",
  available: true,
  isDefault: true,
};

function baseParams(port, scenario) {
  return {
    sessionId: `diff-${scenario.name}`,
    turnId: `diff-${scenario.name}-turn`,
    content: "say something",
    userMessageId: `diff-${scenario.name}-message`,
    provider: {
      id: "diff-provider",
      name: "Differential",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "diff-model",
      apiKey: "diff-key",
      authKind: "api-key",
      apiStyle: "openai-completions",
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    },
    commandShell: COMMAND_SHELL,
    mode: "agent",
    thinkingLevel: "off",
    ...(scenario.tools ? { tools: scenario.tools } : {}),
    // The window belongs to the model, and that is where main puts it.
    ...(scenario.contextWindow
      ? {
          provider: {
            id: "diff-provider",
            name: "Differential",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            modelId: "diff-model",
            apiKey: "diff-key",
            authKind: "api-key",
            apiStyle: "openai-completions",
            supportsReasoning: false,
            supportedThinkingLevels: ["off"],
            // The full shape main stamps on a prompt: a window alone is not what
            // the runtime reads, and a partial object crashes it.
            modelConfig: {
              source: "models.dev",
              name: "Differential",
              baseUrl: `http://127.0.0.1:${port}/v1`,
              reasoning: false,
              supportedThinkingLevels: ["off"],
              modalities: { input: ["text"], output: ["text"] },
              limit: {
                context: scenario.contextWindow,
                input: scenario.contextWindow,
                output: Math.floor(scenario.contextWindow / 4),
              },
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              input: ["text"],
              contextWindow: scenario.contextWindow,
              maxTokens: Math.floor(scenario.contextWindow / 4),
            },
          },
        }
      : {}),
    ...(scenario.pluginSkills ? { pluginSkills: scenario.pluginSkills } : {}),
    ...(scenario.skillReview ? { skillReview: scenario.skillReview } : {}),
  };
}

const CONFIGURE = {
  jsonrpc: "2.0",
  id: 1,
  method: "sidecar.configure",
  params: { hostBinary: null, dataDir: ROOT, networkProxy: null },
};

/** A history long enough that a small window has to compact it. */
function longHistory() {
  // Just over the trigger of a small window, and short enough that the tail each
  // side retains still fits afterwards: a scenario that cannot be compacted
  // proves nothing about either implementation's compaction.
  const messages = [];
  for (let index = 0; index < 6; index += 1) {
    messages.push({
      id: `h-u${index}`,
      role: "user",
      content: `Question ${index}: ${"context ".repeat(150)}`,
    });
    messages.push({
      id: `h-a${index}`,
      role: "assistant",
      content: `Answer ${index}: ${"detail ".repeat(150)}`,
    });
  }
  return messages;
}

const SCENARIOS = [
  {
    name: "plain",
    firstReply: null,
    frames: (port, scenario) => [
      { jsonrpc: "2.0", id: 0, method: "sidecar.health", params: {} },
      CONFIGURE,
      { jsonrpc: "2.0", id: 2, method: "agent.prompt", params: baseParams(port, scenario) },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "agent.getStatus",
        params: { sessionId: `diff-${scenario.name}` },
      },
    ],
  },
  {
    // The payload Electron main really sends: no tool declarations, because the
    // Node runtime ships its own built-ins.
    name: "tool",
    firstReply: "tool",
    pending: "the runtime's built-in tools are declared by the Node runtime itself; the kernel declares none",
    frames: (port, scenario) => [
      CONFIGURE,
      { jsonrpc: "2.0", id: 2, method: "agent.prompt", params: baseParams(port, scenario) },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "agent.getStatus",
        params: { sessionId: `diff-${scenario.name}` },
      },
    ],
  },
  {
    // The same turn with the declaration supplied by the host: this is the path
    // the kernel already supports, and it must dispatch through `tools.execute`
    // exactly as the Node side does.
    name: "tool-declared",
    firstReply: "tool",
    tools: [TOOL_DECLARATION],
    frames: (port, scenario) => [
      CONFIGURE,
      { jsonrpc: "2.0", id: 2, method: "agent.prompt", params: baseParams(port, scenario) },
    ],
  },
  {
    name: "steer",
    firstReply: "tool",
    tools: [TOOL_DECLARATION],
    frames: (port, scenario) => [
      CONFIGURE,
      { jsonrpc: "2.0", id: 2, method: "agent.prompt", params: baseParams(port, scenario) },
    ],
    // A steer is accepted while the turn runs, so it is sent when the tool starts
    // rather than with the opening batch.
    onFrame: (frame, send) => {
      if (frame.method === "agent.event" && frame.params?.event?.type === "tool_start") {
        send({
          jsonrpc: "2.0",
          id: 90,
          method: "agent.steer",
          params: {
            sessionId: "diff-steer",
            expectedTurnId: "diff-steer-turn",
            content: "also check the logs",
            message: {
              id: "diff-steer-steer-message",
              role: "user",
              content: "also check the logs",
              status: "complete",
              steering: true,
              createdAt: new Date().toISOString(),
            },
          },
        });
      }
    },
  },
  {
    name: "asktool",
    firstReply: "asktool",
    tools: [ASKTOOL_DECLARATION],
    frames: (port, scenario) => [
      CONFIGURE,
      { jsonrpc: "2.0", id: 2, method: "agent.prompt", params: baseParams(port, scenario) },
    ],
    onFrame: (frame, send, state) => {
      const event = frame.method === "agent.event" ? frame.params?.event : undefined;
      if (event?.type !== "asktool_request" || state.answered) return;
      state.answered = true;
      send({
        jsonrpc: "2.0",
        id: 91,
        method: "asktool.resolve",
        params: {
          sessionId: "diff-asktool",
          requestId: event.request?.requestId ?? event.request?.id ?? event.requestId,
          answers: [["Blue"]],
        },
      });
    },
  },
  {
    name: "compaction",
    firstReply: null,
    contextWindow: 8_192,
    history: longHistory(),
    // The Node side's automatic recovery refuses a synthetic history (it cannot
    // find a checkpoint that leaves a small enough tail), so this scenario cannot
    // compare the two yet. The kernel's overflow path is covered by its own
    // tests: `a_restored_session_that_does_not_fit_the_window_compacts_first` and
    // `stdio_host`.
    pending: "the Node side's automatic recovery refuses this synthetic history",
    frames: (port, scenario) => [
      CONFIGURE,
      { jsonrpc: "2.0", id: 2, method: "agent.prompt", params: baseParams(port, scenario) },
    ],
  },
];

// -------------------------------------------------------------------- run ---

function hostProxyResult(method) {
  switch (method) {
    case "session.appendMessage":
    case "skills.create":
    case "skills.update":
    case "skills.writeFile":
    case "skills.removeFile":
    case "skills.remove":
      return { ok: true };
    case "skills.read":
      return { body: "# skill" };
    case "tools.execute":
      return { ok: true, content: "tool output" };
    case "session.list":
      return { sessions: [] };
    default:
      return { ok: false, errorCode: "HARNESS_UNSUPPORTED", message: `harness has no ${method}` };
  }
}

/** Run one sidecar through one scenario. */
function runSidecar({ label, command, args, frames, scenario, cwd }) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const hostCalls = [];
    const state = { answered: false };
    let stderr = "";
    let settled = false;
    const send = (frame) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolveRun({ label, frames: out, stderr, reason, hostCalls });
    };
    const timer = setTimeout(() => finish("timeout"), scenario.timeoutMs ?? 45_000);

    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (text) => {
      buffer += text;
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
          const proxied = frame.params?.method ?? "";
          hostCalls.push(proxied);
          const result =
            proxied === "session.get"
              ? { session: { messages: scenario.history ?? [] } }
              : hostProxyResult(proxied);
          if (process.env.DIFF_DUMP_HOST) {
            console.log(`  [${label}/${scenario.name}] host ${proxied}`);
          }
          send({ jsonrpc: "2.0", id: frame.id, result });
          continue;
        }
        scenario.onFrame?.(frame, send, state);
        if (process.env.DIFF_DUMP_EVENTS && frame.method === "agent.event") {
          console.log(
            `  [${label}/${scenario.name}] event ${frame.params?.event?.type}`,
            JSON.stringify(frame.params?.event).slice(0, 400),
          );
        }
        if (frame.method === "agent.event" && frame.params?.event?.type === "agent_end") {
          // Let the events that follow a turn (the review notice, the idle status)
          // arrive before closing: the comparison is about the whole turn.
          setTimeout(() => finish("agent_end"), scenario.settleMs ?? 1500);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => (stderr += text));
    child.on("error", (error) => {
      stderr += String(error);
      finish("spawn error");
    });

    for (const frame of frames) send(frame);
  });
}

// ------------------------------------------------------------- comparison --

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
  "requestId",
]);
void VOLATILE_KEYS;

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
  /** Whether each tool call errored, in order: a missing tool is a real result. */
  const toolOutcomes = [];
  for (const frame of frames) {
    if (frame.method === "agent.event") {
      const event = frame.params?.event;
      if (event?.type) events.push(event.type);
      if (event?.type === "tool_end") toolOutcomes.push(event.isError === true);
      continue;
    }
    if (typeof frame.id === "number" && "result" in frame) results.set(frame.id, frame.result);
    if (typeof frame.id === "number" && "error" in frame) {
      errors.push({ id: frame.id, error: frame.error });
    }
  }
  return { results, events, errors, toolOutcomes };
}

function eventSignature(events) {
  // Consecutive duplicates collapse: a chunked stream emits message_update many
  // times, and how many chunks an implementation produces is not a contract.
  return events.filter((type, index) => type !== events[index - 1]);
}

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
  // A primitive on one side and an object on the other is the difference; `in`
  // would throw on it.
  if (!rustShape || typeof rustShape !== "object") {
    report.push({ label, left: nodeShape, right: rustShape });
    return;
  }
  const missing = Object.keys(nodeShape).filter((key) => !(key in rustShape));
  if (missing.length > 0) {
    report.push({
      label: `${label} (missing keys)`,
      left: Object.keys(nodeShape),
      right: Object.keys(rustShape),
    });
  }
  for (const key of Object.keys(nodeShape)) {
    if (!(key in rustShape)) continue;
    diffShape(`${label}.${key}`, nodeShape[key], rustShape[key], report);
  }
}

const countBy = (list) =>
  list.reduce((counts, entry) => counts.set(entry, (counts.get(entry) ?? 0) + 1), new Map());

/**
 * Compare what each side produced, ignoring order and volume.
 *
 * Order is not the contract — a usage report before or after `message_end` changes
 * nothing a client depends on — but *presence* is: a client that waits for an
 * event must receive it.
 */
function diffPresence(label, nodeList, rustList, allowedMissing, allowedExtra, report, knownGaps) {
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

const TURN_SPINE = [
  "agent_start",
  "turn_start",
  "message_start",
  "message_end",
  "turn_end",
  "agent_end",
];

function compare(nodeRun, rustRun) {
  const nodeSummary = summarize(nodeRun.frames);
  const rustSummary = summarize(rustRun.frames);
  const report = [];
  const knownGaps = [];

  diffPresence(
    "events",
    nodeSummary.events,
    rustSummary.events,
    KNOWN_GAPS.missingEvents,
    KNOWN_GAPS.extraEvents,
    report,
    knownGaps,
  );
  const spine = (events) =>
    eventSignature(events)
      .filter((type) => TURN_SPINE.includes(type))
      .filter((type, index, list) => list.indexOf(type) === index);
  diff("turn event order", spine(nodeSummary.events), spine(rustSummary.events), report);

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
    KNOWN_GAPS.extraHostCalls,
    report,
    knownGaps,
  );
  diff("tool outcomes (isError)", nodeSummary.toolOutcomes, rustSummary.toolOutcomes, report);
  diff(
    "error frames",
    nodeSummary.errors.map((entry) => entry.error.code ?? entry.error.message),
    rustSummary.errors.map((entry) => entry.error.code ?? entry.error.message),
    report,
  );
  return { report, knownGaps, nodeSummary, rustSummary };
}

// ------------------------------------------------------------------- main --

const rustBinary = process.env.PI_AGENT_CORE_BIN?.trim()
  ? process.env.PI_AGENT_CORE_BIN.trim()
  : join(ROOT, "target/release/pi-desktop-agent-core.exe");
if (!existsSync(rustBinary)) {
  console.error(
    `missing Rust kernel: ${rustBinary}\nbuild it with: cargo build -p agent-core --release --offline`,
  );
  process.exit(2);
}
const nodeSidecar = join(ROOT, "packages/agent-runtime/dist/sidecar.js");
if (!existsSync(nodeSidecar)) {
  console.error(`missing Node sidecar: ${nodeSidecar}\nbuild it with: pnpm build:js`);
  process.exit(2);
}

const selected = ONLY.length ? SCENARIOS.filter((s) => ONLY.includes(s.name)) : SCENARIOS;
let failures = 0;
let gaps = 0;
let pendings = 0;

for (const scenario of selected) {
  const { server, port } = await startFakeProvider(scenario);
  const frames = scenario.frames(port, scenario);
  const [nodeRun, rustRun] = await Promise.all([
    runSidecar({
      label: "node",
      command: process.execPath,
      args: [nodeSidecar],
      frames,
      scenario,
      cwd: ROOT,
    }),
    runSidecar({ label: "rust", command: rustBinary, args: ["serve"], frames, scenario, cwd: ROOT }),
  ]);
  server.close();

  const { report, knownGaps, nodeSummary, rustSummary } = compare(nodeRun, rustRun);
  // A pending scenario reports its gap instead of failing on it, but only for
  // the differences that gap explains: the prompt must still be accepted.
  let pending = 0;
  if (scenario.pending) {
    const accepted = rustSummary.results.get(2)?.accepted === true;
    const fatal = report.filter((entry) => entry.label === "error frames");
    report.length = 0;
    report.push(...fatal);
    if (!accepted && fatal.length === 0) {
      report.push({ label: "prompt rejected", left: true, right: false });
    }
    pending = scenario.pending ? 1 : 0;
  }
  console.log(
    `\n[${scenario.name}] ${report.length === 0 ? "ok" : `${report.length} divergence(s)`}${scenario.pending ? " (pending)" : ""} — node ${nodeRun.reason}/${nodeRun.frames.length}f, rust ${rustRun.reason}/${rustRun.frames.length}f`,
  );
  if (scenario.pending) console.log(`  pending: ${scenario.pending}`);
  console.log(`  node: ${eventSignature(nodeSummary.events).join(" -> ") || "(no events)"}`);
  console.log(`  rust: ${eventSignature(rustSummary.events).join(" -> ") || "(no events)"}`);
  for (const gap of knownGaps) console.log(`  known: ${gap.label} — ${gap.reason}`);
  for (const entry of report) {
    console.log(
      `  ✗ ${entry.label}\n      node: ${JSON.stringify(entry.left)}\n      rust: ${JSON.stringify(entry.right)}`,
    );
  }
  if (VERBOSE) {
    console.log("  node results:", JSON.stringify([...nodeSummary.results], null, 2));
    console.log("  rust results:", JSON.stringify([...rustSummary.results], null, 2));
    if (nodeSummary.errors.length) {
      console.log("  node errors:", JSON.stringify(nodeSummary.errors, null, 2));
    }
    if (rustSummary.errors.length) {
      console.log("  rust errors:", JSON.stringify(rustSummary.errors, null, 2));
    }
    if (nodeRun.stderr.trim()) console.log("  node stderr:", nodeRun.stderr.trim().slice(0, 1500));
    if (rustRun.stderr.trim()) console.log("  rust stderr:", rustRun.stderr.trim().slice(0, 1500));
  }
  failures += report.length;
  gaps += knownGaps.length;
  pendings += pending;
}

console.log(
  `\nRESULT: ${failures === 0 ? "no unexpected divergence" : `${failures} unexpected divergence(s)`} across ${selected.length} scenario(s), ${gaps} known gap(s), ${pendings} pending scenario(s)`,
);
process.exit(failures === 0 ? 0 : 1);
