/**
 * The loopback gateway the WorkBuddy entry points at.
 *
 * These tests drive the real HTTP surface against a fake upstream, because the
 * contract that matters is the one the Agent Runtime sees: an OpenAI model list,
 * streamed chunks, a refusal that names the missing credential, and — for a long
 * system prompt — the split the live service requires.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  classifyFailure,
  parseFrame,
  splitSystemMessages,
  toUpstreamBody,
} from "../electron/main/workbuddy/upstream.ts";
import { startWorkBuddyBridge } from "../electron/main/workbuddy/bridge.ts";

const DISCOVERY = {
  installation: {
    installed: true,
    loggedIn: true,
    sources: ["auth-store", "model-cache"],
    account: { uid: "user-1", enterpriseId: "enterprise-1" },
  },
  models: [
    {
      id: "hy4free",
      name: "Hy4",
      contextWindow: 960000,
      maxOutputTokens: 64000,
      supportsImages: true,
      supportsReasoning: true,
      supportsToolCall: true,
      isDefault: true,
    },
    {
      id: "deepseek-v4.1-flash",
      name: "Deepseek-V4.1-Flash",
      contextWindow: 1000000,
      maxOutputTokens: 128000,
    },
  ],
};

/** A stand-in for the WorkBuddy chat endpoint. Records what it was sent. */
async function fakeUpstream(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const entry = {
        url: request.url,
        headers: request.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(entry);
      handler(entry, response, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}

function sse(response, payloads) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const payload of payloads) response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function chunk(content, extra = {}) {
  return {
    id: "chatcmpl-1",
    created: 1,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...extra,
  };
}

async function withBridge(t, handler) {
  const upstream = await fakeUpstream(handler);
  const bridge = await startWorkBuddyBridge({
    discovery: () => DISCOVERY,
    origin: upstream.origin,
    path: "/v2/chat/completions",
  });
  t.after(async () => {
    await bridge.close();
    await upstream.close();
  });
  return { bridge, upstream };
}

test("the model list is served without a credential", async (t) => {
  const { bridge } = await withBridge(t, () => {});
  const response = await fetch(`${bridge.baseUrl}/models`);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "list");
  assert.equal(body.data.length, 2);
  const flagship = body.data.find((row) => row.id === "hy4free");
  assert.equal(flagship.context_window, 960000);
  assert.equal(flagship.max_output_tokens, 64000);
  assert.equal(flagship.display_name, "Hy4");
  assert.equal(flagship.owned_by, "workbuddy");
  assert.equal(flagship.capabilities.vision, true);
});

test("a streamed turn reaches the client as OpenAI chunks", async (t) => {
  const { bridge, upstream } = await withBridge(t, (_request, response) => {
    sse(response, [
      chunk("Hello"),
      chunk(" from WorkBuddy"),
      { ...chunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  });

  const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-token" },
    body: JSON.stringify({
      model: "hy4free",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /data: \{"id":"chatcmpl-1"/);
  assert.match(text, /from WorkBuddy/);
  assert.match(text, /data: \[DONE\]/);

  assert.equal(upstream.requests.length, 1);
  const sent = upstream.requests[0];
  assert.equal(sent.body.stream, true);
  assert.equal(sent.headers.authorization, "Bearer fixture-token");
  // Identity headers the live service demands; without them it answers 11128.
  assert.equal(sent.headers["x-domain"], "www.codebuddy.cn");
  assert.equal(sent.headers["x-user-id"], "user-1");
  assert.equal(sent.headers["x-product"], "workbuddy");
});

test("a non-streaming caller receives one aggregated completion", async (t) => {
  const { bridge } = await withBridge(t, (_request, response) => {
    sse(response, [
      chunk("Hel"),
      chunk("lo"),
      {
        ...chunk(""),
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]);
  });

  const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-token" },
    body: JSON.stringify({ model: "hy4free", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "hy4free");
  assert.equal(body.choices[0].message.content, "Hello");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.total_tokens, 5);
});

test("a missing token is refused with a diagnosable error and no upstream call", async (t) => {
  const { bridge, upstream } = await withBridge(t, () => {});

  const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "hy4free", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "workbuddy_token_missing");
  assert.equal(upstream.requests.length, 0);
});

test("a long system prompt is split before it reaches upstream", async (t) => {
  const { bridge, upstream } = await withBridge(t, (_request, response) => {
    sse(response, [chunk("ok")]);
  });
  const longSystem = `HEAD-${"x".repeat(25_000)}-TAIL`;

  const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-token" },
    body: JSON.stringify({
      model: "hy4free",
      messages: [
        { role: "system", content: longSystem },
        { role: "user", content: "hi" },
      ],
    }),
  });
  assert.equal(response.status, 200);

  const messages = upstream.requests[0].body.messages;
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.length <= 20_000);
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /reference material/);
  assert.match(messages[1].content, /-TAIL/);
});

test("a channel refusal is retried down the request-shape ladder", async (t) => {
  const { bridge, upstream } = await withBridge(t, (_request, response, attempt) => {
    if (attempt <= 2) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ code: 11128, msg: "Illegal API invocation from an unapproved channel" }),
      );
      return;
    }
    sse(response, [chunk("worked")]);
  });

  const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-token" },
    body: JSON.stringify({ model: "hy4free", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "worked");
  assert.equal(upstream.requests.length, 3);
  // Attempt 1 claims the desktop identity, attempt 2 keeps the identity headers
  // but drops the client-software block, attempt 3 is the plain shape.
  assert.equal(upstream.requests[0].headers["x-product"], "workbuddy");
  assert.equal(upstream.requests[1].headers["x-product"], undefined);
  assert.equal(upstream.requests[1].body.stream_options === undefined, false);
  assert.equal(upstream.requests[2].body.stream_options, undefined);
  // Every attempt still carries the conversation and the model.
  for (const request of upstream.requests) {
    assert.equal(request.body.model, "hy4free");
    assert.equal(request.body.messages.length, 1);
    assert.equal(request.body.stream, true);
  }
});

test("an expired token surfaces as an auth error, not an empty answer", async (t) => {
  const { bridge, upstream } = await withBridge(t, (_request, response) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 10001, msg: "token invalid" }));
  });

  const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer stale-token" },
    body: JSON.stringify({ model: "hy4free", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.type, "auth");
  // An auth refusal is not retried: a different header set cannot fix it.
  assert.equal(upstream.requests.length, 1);
});

test("the health probe reports install and sign-in state", async (t) => {
  const { bridge } = await withBridge(t, () => {});
  const body = await (await fetch(`${bridge.baseUrl.replace(/\/v1$/, "")}/healthz`)).json();

  assert.equal(body.ok, true);
  assert.equal(body.installed, true);
  assert.equal(body.loggedIn, true);
  assert.equal(body.models, 2);
});

test("system splitting leaves a short prompt exactly as it was", () => {
  const messages = [
    { role: "system", content: "short" },
    { role: "user", content: "hi" },
  ];
  const result = splitSystemMessages(messages, 20_000);

  assert.equal(result.changed, false);
  assert.deepEqual(result.messages, messages);
});

test("upstream bodies always stream, and duplicate the token cap", () => {
  const body = toUpstreamBody({
    model: "hy4free",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 128,
    temperature: 0.2,
    tools: [{ type: "function" }],
  });

  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 128);
  assert.equal(body.max_completion_tokens, 128);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.tools.length, 1);
});

test("refusals classify into the four behaviours the bridge acts on", () => {
  assert.equal(classifyFailure(401, "{}").kind, "auth");
  assert.equal(classifyFailure(200, '{"code":11128,"msg":"x"}').kind, "channel");
  assert.equal(classifyFailure(429, '{"code":6004,"msg":"频率限制"}').kind, "quota");
  assert.equal(classifyFailure(400, '{"code":11102,"msg":"service info not found"}').kind, "missing-model");
  assert.equal(classifyFailure(503, "gateway down").kind, "transient");
});

test("SSE frames parse, and [DONE] carries no payload", () => {
  assert.deepEqual(parseFrame("data: {\"a\":1}"), [{ data: { a: 1 } }]);
  assert.deepEqual(parseFrame("data: [DONE]"), []);
  assert.deepEqual(parseFrame("event: ping"), []);
  assert.deepEqual(parseFrame("data: not-json"), []);
});
