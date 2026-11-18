/**
 * Replaces the *body* of stale tool results in the view that goes to the
 * provider.
 *
 * A long session is dominated by tool output — file reads, greps, build logs —
 * that the model no longer needs in full, because the tool that produced it can
 * simply be called again. Clearing it shrinks the request without shrinking
 * what the session actually knows.
 *
 * The provider request is the only place this may happen. The transcript keeps
 * every full result, and a message keeps its role, its `toolCallId`, its
 * position, and its `details`. A `toolCall` and the `toolResult` answering it
 * therefore stay paired exactly as the provider requires — a `tool_use` without
 * its matching `tool_result` is a rejected request, and dropping an entry is
 * what breaks that, not replacing its text.
 *
 * Rules:
 *
 *  - a short conversation is left completely alone (`minMessages`);
 *  - the newest `keepRecent` tool results are always sent unchanged;
 *  - an `isError` result is never elided: error text is short and it explains
 *    why a step failed;
 *  - only text blocks are replaced. Images and other attachment blocks stay
 *    exactly where they were, so a result that carried one still carries it;
 *  - a result is replaced only when the marker is *shorter* than the text it
 *    stands in for, so elision can never enlarge a request;
 *  - the marker names the tool, how much output it stood for, and the first
 *    line, so the model can decide whether re-reading is worth a call. It is
 *    recognised by {@link TOOL_RESULT_ELISION_PREFIX}, which makes a second
 *    pass a no-op.
 *
 * Pure: no I/O, no runtime state, no mutation. `runtime.ts` applies it inside
 * `convertToLlm`, after the system journal has persisted the full messages, so
 * persisted history and the compaction input are unaffected.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isRecord } from "./agent-messages.js";

/** Opens every replacement; recognises one this module already made. */
export const TOOL_RESULT_ELISION_PREFIX = "[stale tool output cleared:";

/**
 * Conversations shorter than this are not worth a pass. Below it there is at
 * most a turn or two of tool output, and rewriting it buys nothing while
 * costing the model continuity.
 */
export const TOOL_RESULT_ELISION_MIN_MESSAGES = 16;

/** Tool results always sent unchanged, newest first: the live working set. */
export const TOOL_RESULT_ELISION_KEEP_RECENT = 4;

/** Upper bound on one replacement, preview included. */
export const TOOL_RESULT_ELISION_MAX_CHARS = 120;

/**
 * Rollback switch for the shipped build: `PI_DESKTOP_TOOL_RESULT_ELISION=0`
 * turns elision off for the session and subagent runtimes alike. Read per
 * request, so a test can flip it without rebuilding the runtime.
 */
export function toolResultElisionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_DESKTOP_TOOL_RESULT_ELISION !== "0";
}

/** Shortest first-line preview worth quoting; below it the line says nothing. */
const MIN_PREVIEW_CHARS = 8;

export interface ToolResultElisionOptions {
  /** Rollback switch. Defaults to enabled. */
  enabled?: boolean;
  /** Defaults to {@link TOOL_RESULT_ELISION_MIN_MESSAGES}. */
  minMessages?: number;
  /** Defaults to {@link TOOL_RESULT_ELISION_KEEP_RECENT}. */
  keepRecent?: number;
}

/**
 * A request view with stale tool results reduced to a re-runnable marker.
 *
 * Returns the input array itself when nothing was elided, so a caller can tell
 * "unchanged" by identity; otherwise a new array holding the same messages in
 * the same order, with only the replaced entries as new objects.
 */
export function elideStaleToolResults(
  messages: AgentMessage[],
  options: ToolResultElisionOptions = {},
): AgentMessage[] {
  if (options.enabled === false) return messages;
  const minMessages = options.minMessages ?? TOOL_RESULT_ELISION_MIN_MESSAGES;
  if (messages.length < minMessages) return messages;
  const keepRecent = Math.max(
    0,
    options.keepRecent ?? TOOL_RESULT_ELISION_KEEP_RECENT,
  );

  const resultIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === "toolResult") resultIndexes.push(index);
  }
  // Every result is inside the live window: nothing is stale yet.
  const elidable = resultIndexes.length - keepRecent;
  if (elidable <= 0) return messages;

  let next: AgentMessage[] | undefined;
  for (let position = 0; position < elidable; position += 1) {
    const index = resultIndexes[position];
    const original = messages[index];
    const replaced = elidedToolResult(original);
    if (!replaced) continue;
    next ??= [...messages];
    next[index] = replaced;
  }
  return next ?? messages;
}

function elidedToolResult(message: AgentMessage): AgentMessage | undefined {
  const result = message as {
    toolName?: unknown;
    isError?: unknown;
    content?: unknown;
  };
  // An error is the one result whose text is worth its bytes: it is short, and
  // it is the only record of why the step failed.
  if (result.isError === true) return undefined;
  if (!Array.isArray(result.content)) return undefined;
  const blocks = result.content as unknown[];

  const textBlocks = blocks.filter(isTextBlock);
  if (textBlocks.length === 0) return undefined;
  // Already replaced: the marker must not be rewritten over itself.
  if (textBlocks[0].text.startsWith(TOOL_RESULT_ELISION_PREFIX)) return undefined;

  const text = textBlocks.map((block) => block.text).join("\n");
  const replacement = elisionText(
    typeof result.toolName === "string" ? result.toolName : "",
    utf8Bytes(text),
    text,
  );
  // Never trade a short result for a longer marker.
  if (replacement.length >= text.length) return undefined;

  // One text block at the position of the first one; images and any other
  // attachment stay exactly where they were.
  const content: unknown[] = [];
  let placed = false;
  for (const block of blocks) {
    if (isTextBlock(block)) {
      if (!placed) {
        content.push({ type: "text", text: replacement });
        placed = true;
      }
      continue;
    }
    content.push(block);
  }
  return { ...(message as object), content } as AgentMessage;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

/**
 * The sentence that replaces a result. It states how much output went away and
 * what the tool was, so the model can weigh one more call against reading on
 * without it. Capped at {@link TOOL_RESULT_ELISION_MAX_CHARS}.
 */
function elisionText(toolName: string, bytes: number, text: string): string {
  const head = `${TOOL_RESULT_ELISION_PREFIX} ${bytes} bytes`;
  const name = toolName || "the tool";
  const tail = `; call ${name} again if you need it]`;
  const bare = `${head}${tail}`;
  // A pathological tool name must not push the marker past the cap.
  if (bare.length > TOOL_RESULT_ELISION_MAX_CHARS) {
    return `${head}; call the tool again if you need it]`;
  }
  // The preview is what has to give when the sentence is long.
  const room = TOOL_RESULT_ELISION_MAX_CHARS - bare.length - ', first line ""'.length;
  const preview = clipPreview(firstLine(text), room);
  return preview === undefined ? bare : `${head}, first line "${preview}"${tail}`;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.replace(/\s+/g, " ").trim();
}

function clipPreview(preview: string, room: number): string | undefined {
  if (preview.length === 0 || room < MIN_PREVIEW_CHARS) return undefined;
  if (preview.length <= room) return preview;
  return `${preview.slice(0, room - 1)}…`;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
