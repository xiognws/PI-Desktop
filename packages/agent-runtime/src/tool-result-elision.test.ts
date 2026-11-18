import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  TOOL_RESULT_ELISION_KEEP_RECENT,
  TOOL_RESULT_ELISION_MAX_CHARS,
  TOOL_RESULT_ELISION_PREFIX,
  elideStaleToolResults,
} from "./tool-result-elision.js";
import { dedupeToolCallMessages } from "./tool-call-dedupe.js";

function text(value: string) {
  return { type: "text", text: value };
}

function image(value: string) {
  return { type: "image", data: value, mimeType: "image/png" };
}

function assistant(content: unknown[]): AgentMessage {
  return { role: "assistant", content, timestamp: 1 } as unknown as AgentMessage;
}

function toolCall(id: string, name = "Read") {
  return { type: "toolCall", id, name, arguments: { path: "src/a.ts" } };
}

function user(value: string): AgentMessage {
  return { role: "user", content: [text(value)], timestamp: 1 } as unknown as AgentMessage;
}

function toolResult(
  toolCallId: string,
  content: unknown[],
  overrides: Record<string, unknown> = {},
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "Read",
    content,
    isError: false,
    timestamp: 2,
    ...overrides,
  } as unknown as AgentMessage;
}

/** One call/result pair, both sides present, the way a provider needs them. */
function pair(index: number, size = 400): AgentMessage[] {
  const id = `call_${index}`;
  return [
    assistant([toolCall(id)]),
    toolResult(id, [text(`result ${index} `.repeat(size / 8))]),
  ];
}

/** A conversation of `count` call/result pairs behind one user message. */
function conversation(count: number): AgentMessage[] {
  const messages: AgentMessage[] = [user("read the files")];
  for (let index = 0; index < count; index += 1) messages.push(...pair(index));
  return messages;
}

function resultIndex(messages: AgentMessage[], toolCallId: string): number {
  const index = messages.findIndex(
    (message) =>
      message.role === "toolResult" &&
      (message as { toolCallId?: string }).toolCallId === toolCallId,
  );
  if (index < 0) throw new Error(`no result for ${toolCallId}`);
  return index;
}

/** Replace one result by call id, so a fixture cannot miscount the layout. */
function setResult(
  messages: AgentMessage[],
  toolCallId: string,
  content: unknown[],
  overrides: Record<string, unknown> = {},
): AgentMessage[] {
  messages[resultIndex(messages, toolCallId)] = toolResult(toolCallId, content, overrides);
  return messages;
}

function blockText(message: AgentMessage | undefined): string {
  const content = (
    message as { content?: { type: string; text?: string }[] } | undefined
  )?.content;
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function resultTexts(messages: AgentMessage[]): string[] {
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) => blockText(message));
}

function markers(messages: AgentMessage[]): string[] {
  return resultTexts(messages).filter((value) =>
    value.startsWith(TOOL_RESULT_ELISION_PREFIX),
  );
}

function callIds(messages: AgentMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? (message as { content: { type: string; id?: string }[] }).content
          .filter((block) => block.type === "toolCall")
          .map((block) => block.id ?? "")
      : [],
  );
}

function resultIds(messages: AgentMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "toolResult"
      ? [(message as { toolCallId: string }).toolCallId]
      : [],
  );
}

describe("elideStaleToolResults", () => {
  it("leaves a short conversation untouched, by identity", () => {
    const messages = conversation(5);
    expect(elideStaleToolResults(messages)).toBe(messages);
  });

  it("is a no-op when disabled", () => {
    const messages = conversation(20);
    expect(elideStaleToolResults(messages, { enabled: false })).toBe(messages);
  });

  it("replaces only the stale results and keeps the newest four verbatim", () => {
    const messages = conversation(12);
    const before = resultTexts(messages);
    const elided = elideStaleToolResults(messages);

    expect(elided).not.toBe(messages);
    const after = resultTexts(elided);
    expect(after).toHaveLength(before.length);
    expect(markers(elided)).toHaveLength(
      before.length - TOOL_RESULT_ELISION_KEEP_RECENT,
    );
    // The newest four are exactly the text they were.
    expect(after.slice(-TOOL_RESULT_ELISION_KEEP_RECENT)).toEqual(
      before.slice(-TOOL_RESULT_ELISION_KEEP_RECENT),
    );
  });

  it("keeps the tool-call/result pairing: ids, roles, order and count unchanged", () => {
    const messages = conversation(12);
    const elided = elideStaleToolResults(messages);

    expect(elided).toHaveLength(messages.length);
    expect(elided.map((message) => message.role)).toEqual(
      messages.map((message) => message.role),
    );
    expect(callIds(elided)).toEqual(callIds(messages));
    expect(resultIds(elided)).toEqual(resultIds(messages));
    // Every call still has its result, in the same order.
    expect(resultIds(elided)).toEqual(callIds(elided));

    // A result still directly follows the assistant message that called it,
    // even though its body changed.
    for (let index = 0; index < elided.length; index += 1) {
      const message = elided[index] as { role: string; toolCallId?: string };
      if (message.role !== "toolResult") continue;
      const previous = elided[index - 1] as { role?: string; content?: unknown[] };
      expect(previous?.role).toBe("assistant");
      const called = (previous.content ?? []).some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: string }).type === "toolCall" &&
          (block as { id?: string }).id === message.toolCallId,
      );
      expect(called).toBe(true);
    }
  });

  it("keeps the fields the provider and the transcript rely on", () => {
    const messages = conversation(12);
    const elided = elideStaleToolResults(messages);
    const index = resultIndex(messages, "call_0");
    const original = messages[index] as Record<string, unknown>;
    const replaced = elided[index] as Record<string, unknown>;

    expect(replaced.role).toBe("toolResult");
    expect(replaced.toolCallId).toBe(original.toolCallId);
    expect(replaced.toolName).toBe(original.toolName);
    expect(replaced.timestamp).toBe(original.timestamp);
    expect(replaced.isError).toBe(false);
  });

  it("is idempotent: a second pass changes nothing", () => {
    const once = elideStaleToolResults(conversation(12));
    const twice = elideStaleToolResults(once);
    expect(twice).toBe(once);
    expect(resultTexts(twice)).toEqual(resultTexts(once));
  });

  it("does not rewrite a marker that is already there", () => {
    const marker = `${TOOL_RESULT_ELISION_PREFIX} 400 bytes; call Read again if you need it]`;
    const messages = conversation(12);
    setResult(messages, "call_0", [text(marker)]);
    const elided = elideStaleToolResults(messages);
    expect(blockText(elided[resultIndex(elided, "call_0")])).toBe(marker);
  });

  it("leaves image and attachment blocks in place", () => {
    const messages = conversation(12);
    setResult(messages, "call_0", [text("x".repeat(400)), image("AAA")]);
    const elided = elideStaleToolResults(messages);
    const content = (
      elided[resultIndex(elided, "call_0")] as {
        content: { type: string; text?: string }[];
      }
    ).content;

    expect(content.map((block) => block.type)).toEqual(["text", "image"]);
    expect(content[0].text).toContain(TOOL_RESULT_ELISION_PREFIX);
    expect(content[1]).toEqual(image("AAA"));
  });

  it("leaves a result that carries only an image untouched", () => {
    const messages = conversation(12);
    setResult(messages, "call_0", [image("AAA")]);
    const elided = elideStaleToolResults(messages);
    expect(
      (elided[resultIndex(elided, "call_0")] as { content: unknown[] }).content,
    ).toEqual([image("AAA")]);
  });

  it("never elides an error result", () => {
    const messages = conversation(12);
    setResult(messages, "call_0", [text("ENOENT: ".repeat(50))], { isError: true });
    const elided = elideStaleToolResults(messages);
    expect(blockText(elided[resultIndex(elided, "call_0")])).toBe(
      "ENOENT: ".repeat(50),
    );
  });

  it("never grows a result: a short one keeps its text", () => {
    const messages = conversation(12);
    setResult(messages, "call_0", [text("ok")]);
    const elided = elideStaleToolResults(messages);
    expect(blockText(elided[resultIndex(elided, "call_0")])).toBe("ok");
  });

  it("names the tool, the byte count and the first line, within the cap", () => {
    // Long enough that the marker is the shorter of the two.
    const source = `${"export function a() {\n  return 1;\n}\n".repeat(20)}`;
    const messages = conversation(12);
    setResult(messages, "call_0", [text(source)]);
    const marker = blockText(
      elideStaleToolResults(messages)[resultIndex(messages, "call_0")],
    );

    expect(marker).toContain("Read");
    expect(marker).toContain(`${Buffer.byteLength(source, "utf8")} bytes`);
    expect(marker).toContain("export function a() {");
    expect(marker).toContain("again if you need it");
    expect(marker.length).toBeLessThanOrEqual(TOOL_RESULT_ELISION_MAX_CHARS);
    expect(marker.endsWith("]")).toBe(true);
  });

  it("shortens the preview rather than exceed the cap, and keeps the sentence", () => {
    const messages = conversation(12);
    setResult(messages, "call_0", [text(`${"a".repeat(500)}\nsecond line`)]);
    const marker = blockText(
      elideStaleToolResults(messages)[resultIndex(messages, "call_0")],
    );
    expect(marker.length).toBeLessThanOrEqual(TOOL_RESULT_ELISION_MAX_CHARS);
    expect(marker).toContain("bytes");
    expect(marker).toContain("call Read again if you need it]");
    expect(marker).toContain("…");
  });

  it("honours a caller-supplied window", () => {
    const messages = conversation(12);
    const elided = elideStaleToolResults(messages, { keepRecent: 10, minMessages: 4 });
    expect(markers(elided)).toHaveLength(2);
  });

  it("keeps user text and every assistant message byte-identical", () => {
    const messages = conversation(12);
    const elided = elideStaleToolResults(messages);
    expect(elided[0]).toBe(messages[0]);
    for (let index = 1; index < messages.length; index += 1) {
      if (messages[index].role !== "assistant") continue;
      expect(elided[index]).toBe(messages[index]);
    }
  });

  it("treats the call id as opaque and never rewrites it", () => {
    const messages = conversation(12);
    setResult(messages, "call_0", [text("y".repeat(400))]);
    (messages[resultIndex(messages, "call_0")] as { toolCallId: string }).toolCallId =
      "weird id /+=";
    const elided = elideStaleToolResults(messages);
    expect(
      (elided[resultIndex(elided, "weird id /+=")] as { toolCallId: string }).toolCallId,
    ).toBe("weird id /+=");
  });

  it("does not mutate its input", () => {
    const messages = conversation(12);
    const snapshot = JSON.stringify(messages);
    elideStaleToolResults(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("leaves a conversation with no tool results alone", () => {
    const messages: AgentMessage[] = [user("hi")];
    for (let index = 0; index < 20; index += 1) {
      messages.push(assistant([{ type: "text", text: `line ${index}` }]));
    }
    expect(elideStaleToolResults(messages)).toBe(messages);
  });

  it("reaches a long single-turn run: 20 results leave the newest 4 intact", () => {
    const messages = conversation(20);
    const elided = elideStaleToolResults(messages);
    expect(markers(elided)).toHaveLength(16);
    expect(elided.filter((message) => message.role === "toolResult")).toHaveLength(20);
  });

  it("keeps the pairing through the request path's composition with dedupe", () => {
    // What `runtime.ts convertToLlm` actually does: dedupe the wire ids, then
    // elide. Dedupe can renumber ids; elision must not disturb that result.
    const messages = conversation(12);
    const deduped = dedupeToolCallMessages(messages);
    const elided = elideStaleToolResults(deduped.messages);

    expect(resultIds(elided)).toEqual(callIds(elided));
    expect(resultIds(elided)).toEqual(resultIds(deduped.messages));
    expect(elided).toHaveLength(deduped.messages.length);
    expect(markers(elided)).toHaveLength(8);
  });
});

describe("elision wiring", () => {
  // Both the session run and a delegated `Task` child build their own
  // `convertToLlm`. A child that forgets the call silently stops saving tokens,
  // which no behavioural test of this module would catch, so the two call sites
  // are pinned here rather than left to convention.
  it("wires both wire views: the session runtime and a delegate", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["runtime.ts", "subagent.ts"]) {
      const source = await readFile(`${here}${file}`, "utf8");
      expect(source).toContain("elideStaleToolResults(");
      expect(source).toContain("toolResultElisionEnabled()");
    }
  });
});
