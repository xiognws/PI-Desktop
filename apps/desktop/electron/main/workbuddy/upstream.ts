/**
 * WorkBuddy upstream adapter.
 *
 * WorkBuddy's own chat endpoint is OpenAI-shaped SSE, but three behaviours make a
 * plain OpenAI client fail against it, all measured against the live service:
 *
 * 1. The endpoint only answers `stream: true`; a non-streaming body is refused.
 *    The bridge therefore always streams upstream and aggregates for clients
 *    that asked for a single response.
 * 2. A `system` message longer than ~20000 characters is refused with
 *    `11128 Illegal API invocation from an unapproved channel`. The head of the
 *    system prompt stays in `system` and the remainder moves into a `user`
 *    message labelled as reference material — the same split the reference
 *    gateway uses, because it keeps the prefix cache alive for the common case.
 * 3. The same code can also come from request features the channel check
 *    dislikes (`stream_options`, `tool_choice`, array-shaped content). Those are
 *    dropped in a fixed ladder before giving up.
 *
 * Everything here is transport: no credential is stored, logged, or cached. The
 * bearer token is passed in per request and only ever placed in a header.
 */

export type ChatMessage = {
  role: string;
  content?: unknown;
  [key: string]: unknown;
};

export type UpstreamIdentity = {
  /** `X-Domain` the desktop client sends; the service validates it. */
  domain: string;
  userId?: string;
  enterpriseId?: string;
  tenantId?: string;
};

export type UpstreamChatRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop?: unknown;
  presence_penalty?: unknown;
  frequency_penalty?: unknown;
  response_format?: unknown;
  user?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  reasoning?: unknown;
};

export const WORKBUDDY_ORIGIN = "https://www.workbuddy.cn";
export const WORKBUDDY_CHAT_PATH = "/v2/chat/completions";
export const WORKBUDDY_DEFAULT_DOMAIN = "www.codebuddy.cn";

/**
 * Identity headers the desktop client sends. The service treats a request
 * without them as coming from an unapproved channel, which is what code 11128
 * reports.
 */
export const OFFICIAL_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "CodeBuddy/2.165.0",
  "X-Product": "workbuddy",
  "X-Product-Version": "5.9.3",
  "X-IDE-Type": "workbuddy",
  "X-IDE-Name": "WorkBuddy",
  "X-IDE-Version": "5.9.3",
  "X-Agent-Runtime": "local-agent",
  "X-Agent-Type": "cli",
};

/** Characters of system prompt the service accepts before it refuses the call. */
export const SYSTEM_HEADROOM = 20_000;

function messageText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : (part as { text?: string } | null)?.text ?? "",
      )
      .join("\n");
  }
  return typeof content === "string" ? content : String(content ?? "");
}

/**
 * Move everything past `keepN` characters of system prompt into a user message.
 *
 * Pure. Returns `changed: false` (and the input untouched) whenever the combined
 * system text fits, which is the normal case for short prompts.
 */
export function splitSystemMessages(
  messages: readonly ChatMessage[],
  keepN: number = SYSTEM_HEADROOM,
): { messages: ChatMessage[]; changed: boolean; total: number } {
  const systemTexts: string[] = [];
  const others: ChatMessage[] = [];
  for (const message of messages) {
    if (message?.role === "system") systemTexts.push(messageText(message.content));
    else if (message) others.push(message);
  }
  if (!systemTexts.length) return { messages: [...messages], changed: false, total: 0 };
  const system = systemTexts.join("\n\n");
  if (system.length <= keepN) {
    return { messages: [...messages], changed: false, total: system.length };
  }
  const head = keepN > 0 ? system.slice(0, keepN) : "You are a helpful assistant.";
  const tail = keepN > 0 ? system.slice(keepN) : system;
  return {
    messages: [
      { role: "system", content: head },
      {
        role: "user",
        content: `The following is reference material for this task:\n\n${tail}`,
      },
      ...others,
    ],
    changed: true,
    total: system.length,
  };
}

/** OpenAI request → upstream request body. Always streaming. */
export function toUpstreamBody(request: UpstreamChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  const passthrough = [
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "temperature",
    "top_p",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "response_format",
    "user",
  ] as const;
  for (const key of passthrough) {
    if (request[key] !== undefined) body[key] = request[key];
  }
  const maxTokens = request.max_completion_tokens ?? request.max_tokens;
  if (maxTokens) {
    body.max_tokens = maxTokens;
    body.max_completion_tokens = maxTokens;
  }
  if (request.reasoning_effort) body.reasoning_effort = request.reasoning_effort;
  if (request.reasoning && typeof request.reasoning === "object") {
    body.reasoning = request.reasoning;
  }
  return body;
}

/** Headers for one upstream attempt. `mode` selects how much identity to claim. */
export function buildHeaders(
  token: string,
  identity: UpstreamIdentity,
  mode: "full" | "minimal" | "plain",
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Domain": identity.domain || WORKBUDDY_DEFAULT_DOMAIN,
    "Content-Type": "application/json",
  };
  if (identity.userId) headers["X-User-Id"] = identity.userId;
  if (identity.enterpriseId) headers["X-Enterprise-Id"] = identity.enterpriseId;
  if (identity.tenantId) headers["X-Tenant-Id"] = identity.tenantId;
  headers.Authorization = `Bearer ${token}`;
  headers.Accept = "text/event-stream";
  if (mode === "plain") return headers;
  if (mode === "minimal") return headers;
  return { ...headers, ...OFFICIAL_HEADERS };
}

export type UpstreamFailureKind =
  /** The bearer token is missing, expired, or refused. */
  | "auth"
  /** A deterministic quota/rate answer: retrying the same model cannot help. */
  | "quota"
  /** The account has no such model. */
  | "missing-model"
  /** Channel validation: the request shape, not the account, was refused. */
  | "channel"
  /** Transient upstream trouble worth one more attempt. */
  | "transient"
  | "other";

export type UpstreamFailure = {
  kind: UpstreamFailureKind;
  message: string;
  /** Upstream `code` when the body stated one. */
  code?: number;
  /** HTTP status of the upstream response. */
  status: number;
};

function upstreamCode(body: Record<string, unknown> | null): number | undefined {
  const direct = body?.code;
  const nested = (body?.error as Record<string, unknown> | undefined)?.code;
  const code = typeof direct === "number" ? direct : typeof nested === "number" ? nested : undefined;
  return code;
}

function upstreamMessage(body: Record<string, unknown> | null, fallback: string): string {
  const candidates = [body?.msg, body?.message, (body?.error as { message?: unknown })?.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

/**
 * Classify an upstream refusal. Pure.
 *
 * The distinction matters: a quota answer must reach the user as "this model is
 * out of budget" instead of being retried into a generic timeout, and a channel
 * refusal is the signal to run the next shape in the ladder.
 */
export function classifyFailure(status: number, rawBody: string): UpstreamFailure {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const nested = body?.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const inner = nested as Record<string, unknown>;
      if (inner.code !== undefined || inner.msg !== undefined) body = { ...body, ...inner };
    }
  } catch {
    body = null;
  }
  const code = upstreamCode(body);
  const message = upstreamMessage(body, rawBody.slice(0, 300) || `upstream ${status}`);

  if (status === 401 || status === 403) return { kind: "auth", message, code, status };
  if (code === 11128) return { kind: "channel", message, code, status };
  if (code === 11102 || /not found|no such model|未开通|service info not found/i.test(message)) {
    return { kind: "missing-model", message, code, status };
  }
  if (code === 6004 || /频率限制|用量已超出|额度已用完/i.test(message)) {
    return { kind: "quota", message, code, status };
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return { kind: "transient", message, code, status };
  }
  return { kind: "other", message, code, status };
}

export type UpstreamEvent = {
  /** Parsed JSON payload of one SSE `data:` line. */
  data: Record<string, unknown>;
};

/**
 * Ask the service for one chat completion and yield its parsed SSE events.
 *
 * The response headers are awaited before anything is yielded, so a refusal is
 * reported as a {@link UpstreamFailure} instead of an empty stream — a client
 * that instead saw "stream ended with no content" could not tell the two apart.
 */
export async function* streamChat(options: {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  origin?: string;
  path?: string;
  signal?: AbortSignal;
}): AsyncGenerator<UpstreamEvent, void, void> {
  const origin = options.origin ?? WORKBUDDY_ORIGIN;
  const path = options.path ?? WORKBUDDY_CHAT_PATH;
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify(options.body),
    signal: options.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const failure = classifyFailure(response.status, text);
    throw Object.assign(new Error(failure.message), { failure });
  }
  // A refusal can also arrive as `200 OK` with a JSON body instead of a stream
  // (`11128` does exactly that). Treating it as an empty stream would reach the
  // user as "the model answered nothing", so the body is classified instead.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("event-stream")) {
    const text = await response.text().catch(() => "");
    const looksLikeStream = /^\s*data:/m.test(text);
    if (!looksLikeStream) {
      const failure = classifyFailure(response.status, text);
      throw Object.assign(new Error(failure.message), { failure });
    }
  }
  if (!response.body) {
    throw Object.assign(new Error("upstream returned no body"), {
      failure: { kind: "other", message: "upstream returned no body", status: response.status },
    });
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames end at a blank line; a trailing partial frame stays buffered.
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        for (const event of parseFrame(frame)) yield event;
        separator = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    for (const event of parseFrame(buffer)) yield event;
  } finally {
    reader.releaseLock?.();
  }
}

/** Parse one SSE frame into events. `[DONE]` and comments carry no payload. */
export function parseFrame(frame: string): UpstreamEvent[] {
  const events: UpstreamEvent[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push({ data: parsed as Record<string, unknown> });
      }
    } catch {
      // A malformed frame is not worth failing the whole answer over.
    }
  }
  return events;
}

/**
 * Flatten a possibly-wrapped chunk into the OpenAI shape.
 *
 * The service sometimes answers `{ code, data: { choices: [...] } }`; clients
 * expect the inner object.
 */
export function unwrapChunk(chunk: Record<string, unknown>): Record<string, unknown> {
  const inner = chunk.data;
  if (
    inner &&
    typeof inner === "object" &&
    !Array.isArray(inner) &&
    ("choices" in (inner as Record<string, unknown>) ||
      "usage" in (inner as Record<string, unknown>))
  ) {
    return inner as Record<string, unknown>;
  }
  if (chunk.error) {
    const message = upstreamMessage(chunk, "upstream error");
    throw Object.assign(new Error(message), {
      failure: { kind: "other" as const, message, status: 0 },
    });
  }
  return chunk;
}
