/**
 * The loopback transport that serves a plugin agent to the Rust kernel.
 *
 * The kernel speaks Chat Completions and decodes SSE chunks; a plugin agent is a
 * JavaScript `stream`/`complete` over a pi-ai context. These tests pin the
 * translation in both directions, the loopback key, and the two plugin shapes
 * (streaming and `complete`-only) answering with the same frame vocabulary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { contextFromKernelRequest } = await import("../electron/main/plugin-agent-wire.ts");
const { PluginAgentTransport } = await import("../electron/main/plugin-agent-transport.ts");

const MODEL = { id: "cc-1", name: "Command Code 1", provider: "extension-agent:demo" };

function assistant(text, overrides = {}) {
  return {
    role: "assistant",
    content: text === undefined ? [] : [{ type: "text", text }],
    api: "openai-completions",
    provider: MODEL.provider,
    model: MODEL.id,
    usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: {} },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** The stream shape a plugin's `stream()` produces: events, then a result. */
function streamOf(events, message) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      return message;
    },
  };
}

function transportWith(answerFor) {
  const asked = [];
  const transport = new PluginAgentTransport({
    resolve: async (input) => {
      asked.push(input);
      return answerFor(input);
    },
    log: () => {},
  });
  return { transport, asked };
}

async function post(endpoint, body, key = endpoint.apiKey) {
  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

test("a kernel request becomes the pi-ai context a plugin expects", () => {
  const context = contextFromKernelRequest({
    model: "cc-1",
    messages: [
      { role: "system", content: "be brief" },
      { role: "system", content: "be exact" },
      { role: "user", content: "add 20 and 22" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "fx_add", arguments: '{"a":20,"b":22}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "42" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "fx_add", description: "Adds", parameters: { type: "object", properties: {} } },
      },
    ],
  });

  assert.equal(context.systemPrompt, "be brief\n\nbe exact");
  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  const call = context.messages[1].content[0];
  assert.equal(call.type, "toolCall");
  assert.equal(call.name, "fx_add");
  assert.deepEqual(call.arguments, { a: 20, b: 22 });
  // The tool result carries the call's name, which the kernel's wire omits.
  assert.equal(context.messages[2].toolCallId, "call_1");
  assert.equal(context.messages[2].toolName, "fx_add");
  assert.deepEqual(context.tools?.map((tool) => tool.name), ["fx_add"]);
});

test("a streaming plugin's deltas reach the kernel as chat-completion chunks", async (t) => {
  const partial = assistant("");
  const { transport, asked } = transportWith(() => ({
    providerId: MODEL.provider,
    model: MODEL,
    stream: () =>
      streamOf(
        [
          { type: "start", partial },
          { type: "text_delta", contentIndex: 0, delta: "plugin-", partial },
          { type: "text_delta", contentIndex: 0, delta: "transport-ok", partial },
        ],
        assistant("plugin-transport-ok"),
      ),
  }));
  t.after(() => transport.close());
  const endpoint = await transport.endpoint({ sessionId: "s1", agentKey: "demo:cc", modelId: "cc-1" });
  assert.ok(endpoint);

  const { status, text } = await post(endpoint, {
    model: "cc-1",
    messages: [{ role: "user", content: "say hi" }],
  });

  assert.equal(status, 200);
  assert.ok(text.includes('"content":"plugin-"'), text);
  assert.ok(text.includes('"content":"transport-ok"'), text);
  assert.ok(text.includes('"finish_reason":"stop"'), text);
  assert.ok(text.includes('"prompt_tokens":3'), text);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"), text);
  // The kernel's model id is what selected the agent, and the endpoint is loopback.
  assert.equal(asked[0].sessionId, "s1");
  assert.equal(asked[0].agentKey, "demo:cc");
  assert.equal(asked[0].modelId, "cc-1");
  assert.match(endpoint.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1\/plugin-agent\//);
});

test("a complete-only plugin answers with one text frame, not a duplicate", async (t) => {
  const { transport } = transportWith(() => ({
    providerId: MODEL.provider,
    model: MODEL,
    stream: () => streamOf([], assistant("one answer")),
  }));
  t.after(() => transport.close());
  const endpoint = await transport.endpoint({ sessionId: "s1", agentKey: "demo:cc", modelId: "cc-1" });

  const { text } = await post(endpoint, { model: "cc-1", messages: [{ role: "user", content: "hi" }] });

  assert.equal(text.split('"content":"one answer"').length - 1, 1, text);
});

test("the loopback key is required, and an unregistered agent is a provider error", async (t) => {
  const { transport } = transportWith(({ agentKey }) =>
    agentKey === "demo:cc"
      ? { providerId: MODEL.provider, model: MODEL, stream: () => streamOf([], assistant("ok")) }
      : undefined,
  );
  t.after(() => transport.close());
  const endpoint = await transport.endpoint({ sessionId: "s1", agentKey: "demo:cc", modelId: "cc-1" });

  const rejected = await post(endpoint, { messages: [] }, "not-the-key");
  assert.equal(rejected.status, 401);

  const missing = await transport.endpoint({ sessionId: "s1", agentKey: "demo:gone", modelId: "cc-1" });
  assert.equal(missing, undefined);
});
