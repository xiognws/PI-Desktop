/**
 * Loopback OpenAI-compatible gateway for the WorkBuddy model entry.
 *
 * The Agent Runtime talks to a provider over HTTP, so the quirks WorkBuddy needs
 * (stream-only upstream, long-system-prompt ceiling, channel-check ladder) live
 * behind this small server instead of inside the model client. It listens on
 * 127.0.0.1 only, on an ephemeral port, and it stores nothing: the bearer token
 * a caller presents is the WorkBuddy access token and is forwarded upstream per
 * request.
 *
 * `/v1/models` deliberately answers without a credential. That is what lets the
 * entry publish the account's models before the user has supplied a token, which
 * is the difference between "installed and signed in" and "usable".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildHeaders,
  splitSystemMessages,
  streamChat,
  SYSTEM_HEADROOM,
  toUpstreamBody,
  unwrapChunk,
  WORKBUDDY_CHAT_PATH,
  WORKBUDDY_DEFAULT_DOMAIN,
  WORKBUDDY_ORIGIN,
  type ChatMessage,
  type UpstreamChatRequest,
  type UpstreamFailure,
  type UpstreamIdentity,
} from "./upstream.ts";
import type { WorkBuddyDiscovery } from "./types.ts";

/** Largest request body accepted; PI sends long system prompts but not unbounded ones. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export type WorkBuddyBridgeOptions = {
  /** Fresh discovery, called per request so the model list follows the account. */
  discovery: () => WorkBuddyDiscovery;
  /** Fixed port for tests; `0` (default) asks the OS for a free one. */
  port?: number;
  origin?: string;
  path?: string;
  log?: (event: Record<string, unknown>) => void;
};

export type WorkBuddyBridge = {
  port: number;
  /** OpenAI-compatible base URL the provider row points at. */
  baseUrl: string;
  close: () => Promise<void>;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(payload);
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header !== "string") return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function identityFrom(discovery: WorkBuddyDiscovery): UpstreamIdentity {
  const account = discovery.installation.account;
  return {
    domain: WORKBUDDY_DEFAULT_DOMAIN,
    userId: account?.uid,
    enterpriseId: account?.enterpriseId,
    tenantId: account?.enterpriseId,
  };
}

/** OpenAI model-list rows for the discovered catalog. */
export function modelListPayload(discovery: WorkBuddyDiscovery): {
  object: "list";
  data: Record<string, unknown>[];
} {
  return {
    object: "list",
    data: discovery.models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "workbuddy",
      display_name: model.name,
      name: model.name,
      ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { max_output_tokens: model.maxOutputTokens } : {}),
      capabilities: {
        vision: model.supportsImages === true,
        reasoning: model.supportsReasoning === true,
        tool_calls: model.supportsToolCall !== false,
      },
      ...(model.description ? { description: model.description } : {}),
      ...(model.credits !== undefined && model.credits !== null
        ? { credits: model.credits }
        : {}),
    })),
  };
}

type ToolCallDraft = {
  id?: string;
  type?: string;
  function: { name?: string; arguments?: string };
};

/** Accumulates streamed deltas so a non-streaming caller gets one answer. */
class CompletionAccumulator {
  private readonly content: string[] = [];
  private readonly reasoning: string[] = [];
  private readonly toolCalls = new Map<number, ToolCallDraft>();
  private finishReason: string | null = null;
  private usage: Record<string, unknown> | undefined;
  private responseId: string | undefined;
  private created: number | undefined;

  feed(chunk: Record<string, unknown>): void {
    if (typeof chunk.id === "string" && !this.responseId) this.responseId = chunk.id;
    if (typeof chunk.created === "number" && this.created === undefined) {
      this.created = chunk.created;
    }
    if (chunk.usage && typeof chunk.usage === "object") {
      this.usage = chunk.usage as Record<string, unknown>;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const raw of choices) {
      const choice = raw as Record<string, unknown>;
      if (typeof choice.finish_reason === "string") this.finishReason = choice.finish_reason;
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) this.content.push(delta.content);
      const reasoningText = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoningText === "string" && reasoningText) this.reasoning.push(reasoningText);
      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const rawCall of toolCalls) {
          const call = rawCall as Record<string, unknown>;
          const index = typeof call.index === "number" ? call.index : 0;
          const draft = this.toolCalls.get(index) ?? { function: {} };
          if (typeof call.id === "string") draft.id = call.id;
          if (typeof call.type === "string") draft.type = call.type;
          const fn = call.function as Record<string, unknown> | undefined;
          if (fn) {
            if (typeof fn.name === "string" && fn.name) draft.function.name = fn.name;
            if (typeof fn.arguments === "string" && fn.arguments) {
              draft.function.arguments = (draft.function.arguments ?? "") + fn.arguments;
            }
          }
          this.toolCalls.set(index, draft);
        }
      }
    }
  }

  result(model: string): Record<string, unknown> {
    const toolCalls = [...this.toolCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, draft]) => ({
        index,
        id: draft.id,
        type: draft.type ?? "function",
        function: {
          name: draft.function.name ?? "",
          arguments: draft.function.arguments ?? "",
        },
      }));
    const message: Record<string, unknown> = {
      role: "assistant",
      content: this.content.join("") || null,
    };
    if (this.reasoning.length) message.reasoning_content = this.reasoning.join("");
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      id: this.responseId ?? `chatcmpl-workbuddy-${Date.now()}`,
      object: "chat.completion",
      created: this.created ?? Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: this.finishReason ?? "stop" }],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

/**
 * One chat turn, with the shape ladder applied.
 *
 * Attempts move from the desktop client's own request shape to the most reduced
 * one that still carries the conversation. Only a `channel` or `transient`
 * refusal advances the ladder: an auth, quota, or missing-model answer is
 * returned as-is, because a different header set cannot change it.
 */
async function runChat(options: {
  token: string;
  body: Record<string, unknown>;
  identity: UpstreamIdentity;
  origin: string;
  path: string;
  signal: AbortSignal;
  log?: (event: Record<string, unknown>) => void;
}): Promise<AsyncGenerator<Record<string, unknown>, void, void>> {
  const model = String(options.body.model ?? "");
  const pristine = (options.body.messages as ChatMessage[] | undefined) ?? [];
  const split = splitSystemMessages(pristine, SYSTEM_HEADROOM);
  const base = { ...options.body, messages: split.messages };

  const ladder: { mode: "full" | "minimal" | "plain"; shape: number }[] = [
    { mode: "full", shape: 0 },
    { mode: "minimal", shape: 0 },
    { mode: "plain", shape: 1 },
    { mode: "plain", shape: 2 },
    { mode: "plain", shape: 3 },
    { mode: "plain", shape: 4 },
  ];

  let lastFailure: UpstreamFailure | undefined;
  for (const [attempt, step] of ladder.entries()) {
    const body: Record<string, unknown> = { ...base };
    if (step.shape >= 1) {
      delete body.stream_options;
      delete body.tool_choice;
      delete body.parallel_tool_calls;
      body.messages = (body.messages as ChatMessage[]).map((message) =>
        Array.isArray(message.content)
          ? {
              ...message,
              content: message.content
                .map((part) =>
                  typeof part === "string" ? part : (part as { text?: string })?.text ?? "",
                )
                .join("\n"),
            }
          : message,
      );
    }
    if (step.shape >= 2) {
      const keep = step.shape === 2 ? 8000 : step.shape === 3 ? 2000 : 0;
      body.messages = splitSystemMessages(pristine, keep).messages;
    }
    const started = Date.now();
    try {
      const generator = streamChat({
        body,
        headers: buildHeaders(options.token, options.identity, step.mode),
        origin: options.origin,
        path: options.path,
        signal: options.signal,
      });
      // Pull the first event to surface a refusal here rather than mid-stream.
      const first = await generator.next();
      options.log?.({
        event: "upstream_ok",
        model,
        attempt: attempt + 1,
        mode: step.mode,
        shape: step.shape,
        systemSplit: split.changed,
        systemChars: split.total,
        ms: Date.now() - started,
      });
      return (async function* replay(): AsyncGenerator<Record<string, unknown>, void, void> {
        if (!first.done) yield unwrapChunk(first.value.data);
        for await (const event of generator) yield unwrapChunk(event.data);
      })();
    } catch (error) {
      const failure = (error as { failure?: UpstreamFailure }).failure;
      if (!failure) throw error;
      lastFailure = failure;
      options.log?.({
        event: "upstream_refused",
        model,
        attempt: attempt + 1,
        mode: step.mode,
        shape: step.shape,
        status: failure.status,
        code: failure.code,
        kind: failure.kind,
        ms: Date.now() - started,
      });
      const retryable = failure.kind === "channel" || failure.kind === "transient";
      if (!retryable) throw Object.assign(new Error(failure.message), { failure });
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  const failure = lastFailure ?? { kind: "other" as const, message: "upstream refused", status: 0 };
  throw Object.assign(new Error(failure.message), { failure });
}

/** Start the loopback gateway. Resolves once it is listening. */
export async function startWorkBuddyBridge(
  options: WorkBuddyBridgeOptions,
): Promise<WorkBuddyBridge> {
  const origin = options.origin ?? WORKBUDDY_ORIGIN;
  const path = options.path ?? WORKBUDDY_CHAT_PATH;

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      options.log?.({ event: "bridge_error", message: (error as Error).message });
      if (!response.headersSent) sendJson(response, 500, { error: { message: "bridge failure" } });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      const discovery = options.discovery();
      sendJson(response, 200, {
        ok: true,
        installed: discovery.installation.installed,
        loggedIn: discovery.installation.loggedIn,
        models: discovery.models.length,
      });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      sendJson(response, 200, modelListPayload(options.discovery()));
      return;
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
    ) {
      await handleChat(request, response);
      return;
    }
    sendJson(response, 404, { error: { message: `no route for ${request.method} ${url.pathname}` } });
  }

  async function handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearerToken(request);
    if (!token) {
      sendJson(response, 401, {
        error: {
          message:
            "WorkBuddy needs its access token: paste it as the API key of this provider entry.",
          type: "invalid_request_error",
          code: "workbuddy_token_missing",
        },
      });
      return;
    }
    const raw = await readBody(request);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body");
      body = parsed as Record<string, unknown>;
    } catch {
      sendJson(response, 400, { error: { message: "request body must be a JSON object" } });
      return;
    }
    const identity = identityFrom(options.discovery());
    const abort = new AbortController();
    request.on("close", () => abort.abort());
    const model = String(body.model ?? "");
    const wantsStream = body.stream === true;
    // The caller's OpenAI body is mapped to what the upstream accepts (always a
    // stream, a duplicated token cap) before the shape ladder touches it.
    const upstreamBody = toUpstreamBody(body as UpstreamChatRequest);
    try {
      const stream = await runChat({
        token,
        body: upstreamBody,
        identity,
        origin,
        path,
        signal: abort.signal,
        log: options.log,
      });
      if (!wantsStream) {
        const accumulator = new CompletionAccumulator();
        for await (const chunk of stream) accumulator.feed(chunk);
        sendJson(response, 200, accumulator.result(model));
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
      });
      for await (const chunk of stream) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      const failure = (error as { failure?: UpstreamFailure }).failure;
      const status = failure?.kind === "auth" ? 401 : failure?.status && failure.status >= 400 ? failure.status : 502;
      options.log?.({
        event: "chat_failed",
        model,
        status,
        kind: failure?.kind ?? "other",
      });
      const message = failure?.message ?? (error as Error).message;
      if (response.headersSent) {
        response.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      sendJson(response, status >= 400 ? status : 502, {
        error: { message, code: failure?.code ?? null, type: failure?.kind ?? "upstream_error" },
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
