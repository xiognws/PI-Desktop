/**
 * The wire between the Rust kernel and a plugin-owned agent transport.
 *
 * The kernel speaks an OpenAI-compatible Chat Completions request and decodes
 * its SSE chunks (`crates/agent-core/src/provider/openai.rs`). A plugin agent is
 * not a wire at all: it is a JavaScript `stream`/`complete` callback that takes
 * a pi-ai `Context` and answers with an `AssistantMessage`
 * (`packages/agent-runtime/src/extensions/runner.ts`). Under the kernel Electron
 * main is the only JavaScript host, so it has to be both ends: this module is the
 * translation, and it is deliberately the *only* translation — one request
 * shape in, one chunk vocabulary out.
 *
 * Nothing here invents a second schema. The fields are the ones the kernel's own
 * decoder reads, and the pi-ai shapes are the ones an extension already receives
 * from the Node runtime.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  TextContent,
  ImageContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";

type Wire = Record<string, unknown>;

function isWire(value: unknown): value is Wire {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The empty usage a replayed history message carries: it was never billed here. */
const NO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** `data:image/png;base64,AAAA` → the image block pi-ai passes to a plugin. */
function imageFromDataUrl(url: string): ImageContent | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (!match) return undefined;
  return { type: "image", mimeType: match[1], data: match[2] };
}

/** A user message's content: plain text, or the multimodal block array. */
function userContent(content: unknown): string | (TextContent | ImageContent)[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: (TextContent | ImageContent)[] = [];
  for (const block of content) {
    if (!isWire(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image_url" && isWire(block.image_url)) {
      const url = str(block.image_url.url);
      const image = url ? imageFromDataUrl(url) : undefined;
      if (image) parts.push(image);
    }
  }
  return parts;
}

/** Tool calls as the kernel serialised them back onto an assistant message. */
function toolCallsOf(entry: Wire): ToolCall[] {
  const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
  const out: ToolCall[] = [];
  for (const raw of calls) {
    if (!isWire(raw)) continue;
    const fn = isWire(raw.function) ? raw.function : undefined;
    const name = fn ? str(fn.name) : undefined;
    if (!name) continue;
    const text = fn ? str(fn.arguments) ?? "{}" : "{}";
    // A malformed argument string is the model's error, not the transport's:
    // pi-ai records it on the call so the tool layer reports it once.
    try {
      const parsed: unknown = JSON.parse(text);
      out.push({
        type: "toolCall",
        id: str(raw.id) ?? `call_${out.length}`,
        name,
        arguments: isWire(parsed) ? (parsed as ToolCall["arguments"]) : {},
      });
    } catch {
      out.push({
        type: "toolCall",
        id: str(raw.id) ?? `call_${out.length}`,
        name,
        arguments: {},
        argumentsError: text,
      });
    }
  }
  return out;
}

/**
 * The pi-ai context a plugin agent's `stream`/`complete` is called with.
 *
 * The system messages fold into `systemPrompt` and every other role becomes the
 * message pi-ai names it, so an extension written against the Node runtime sees
 * the same shapes under the kernel.
 */
export function contextFromKernelRequest(input: {
  messages: unknown;
  tools?: unknown;
  model: string;
}): Context {
  const raw = Array.isArray(input.messages) ? input.messages : [];
  const system: string[] = [];
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  const now = Date.now();
  for (const entry of raw) {
    if (!isWire(entry)) continue;
    const role = str(entry.role);
    if (role === "system") {
      const text = str(entry.content) ?? "";
      if (text) system.push(text);
      continue;
    }
    if (role === "user") {
      const message: UserMessage = { role: "user", content: userContent(entry.content), timestamp: now };
      messages.push(message);
      continue;
    }
    if (role === "assistant") {
      const calls = toolCallsOf(entry);
      for (const call of calls) toolNames.set(call.id, call.name);
      const text = str(entry.content) ?? "";
      messages.push({
        role: "assistant",
        content: text ? [{ type: "text", text }, ...calls] : calls,
        api: "openai-completions",
        provider: "extension-agent",
        model: input.model,
        usage: NO_USAGE,
        stopReason: calls.length > 0 ? "toolUse" : "stop",
        timestamp: now,
      });
      continue;
    }
    if (role === "tool") {
      const callId = str(entry.tool_call_id) ?? "";
      const message: ToolResultMessage = {
        role: "toolResult",
        toolCallId: callId,
        toolName: toolNames.get(callId) ?? "",
        content: [{ type: "text", text: str(entry.content) ?? "" }],
        isError: false,
        timestamp: now,
      };
      messages.push(message);
    }
  }
  const tools = (Array.isArray(input.tools) ? input.tools : [])
    .map((tool) => (isWire(tool) && isWire(tool.function) ? tool.function : undefined))
    .flatMap((fn) => {
      const name = fn ? str(fn.name) : undefined;
      if (!name) return [];
      const parameters = fn && isWire(fn.parameters) ? fn.parameters : { type: "object", properties: {} };
      return [{ name, description: (fn ? str(fn.description) : undefined) ?? "", parameters }];
    });
  return {
    ...(system.length > 0 ? { systemPrompt: system.join("\n\n") } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/** One SSE frame, in the shape the kernel's decoder splits on. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function deltaChunk(delta: unknown): string {
  return frame({ choices: [{ index: 0, delta }] });
}

/**
 * Turns pi-ai assistant events into the chunk vocabulary the kernel decodes.
 *
 * A plugin that streams produces deltas and they are forwarded as they arrive; a
 * plugin that only implements `complete` produces none, and its finished message
 * is written out at the end. Both end with the same finish reason, usage and
 * `[DONE]`, so the kernel cannot tell which kind of plugin answered.
 */
export class KernelChunkWriter {
  private readonly write: (frame: string) => void;
  private wroteText = false;
  private readonly wroteTools = new Set<number>();
  private finished = false;

  constructor(write: (frame: string) => void) {
    this.write = write;
  }

  event(event: AssistantMessageEvent): void {
    switch (event.type) {
      case "text_delta":
        if (event.delta) {
          this.wroteText = true;
          this.write(deltaChunk({ content: event.delta }));
        }
        return;
      case "thinking_delta":
        if (event.delta) this.write(deltaChunk({ reasoning_content: event.delta }));
        return;
      case "toolcall_start": {
        const call = event.partial.content[event.contentIndex];
        if (!call || call.type !== "toolCall") return;
        this.wroteTools.add(event.contentIndex);
        this.write(
          deltaChunk({
            tool_calls: [
              {
                index: event.contentIndex,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          }),
        );
        return;
      }
      case "toolcall_delta":
        if (event.delta) {
          this.write(
            deltaChunk({
              tool_calls: [{ index: event.contentIndex, function: { arguments: event.delta } }],
            }),
          );
        }
        return;
      default:
        return;
    }
  }

  /** The terminal frames: whatever the deltas did not carry, then finish/usage. */
  complete(message: AssistantMessage): void {
    if (message.stopReason === "error") {
      this.fail(message.errorMessage ?? "plugin agent failed");
      return;
    }
    const text = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text && !this.wroteText) this.write(deltaChunk({ content: text }));
    let index = 0;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      if (!this.wroteTools.has(index)) {
        this.write(
          deltaChunk({
            tool_calls: [
              {
                index,
                id: part.id,
                type: "function",
                function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
              },
            ],
          }),
        );
      }
      index += 1;
    }
    const hasToolCalls = message.content.some((part) => part.type === "toolCall");
    this.write(
      frame({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: hasToolCalls || message.stopReason === "toolUse" ? "tool_calls" : finishReason(message.stopReason),
          },
        ],
      }),
    );
    this.write(
      frame({
        choices: [],
        usage: {
          prompt_tokens: message.usage.input + message.usage.cacheRead,
          completion_tokens: message.usage.output,
          prompt_tokens_details: { cached_tokens: message.usage.cacheRead },
        },
      }),
    );
    this.done();
  }

  /** A provider error frame, which the decoder raises as a turn failure. */
  fail(message: string): void {
    this.write(frame({ error: { message } }));
    this.done();
  }

  private done(): void {
    if (this.finished) return;
    this.finished = true;
    this.write("data: [DONE]\n\n");
  }
}

function finishReason(reason: AssistantMessage["stopReason"]): string {
  switch (reason) {
    case "length":
      return "length";
    case "error":
      return "stop";
    default:
      return "stop";
  }
}
