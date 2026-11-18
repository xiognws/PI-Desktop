/**
 * The `compress` tool: the model's own request to compress the conversation.
 *
 * Pi could compact two ways before this: on the budget trigger, or when the user
 * asked through `agent.compact`. A model that noticed its context had become
 * mostly history it no longer needs had no way to say so, and the window stayed
 * full until the automatic trigger replaced it at a moment chosen by tokens
 * rather than by the work.
 *
 * A call only *records* the request. Compacting inside the tool call would
 * replace the very messages whose results the model is still holding, so a
 * batch that asked mid-flight would lose everything after the call; the
 * boundary that already owns compaction (`prepareNextTurn`, or the next
 * prompt's pre-flight) honours it one step later, where the loop is between
 * turns and nothing is pending.
 *
 * Every rule that decides *whether* the request is accepted lives in
 * `queueCompressionRequest`, a pure function over the current queue: the
 * runtime only stores its result. That keeps "disabled", "already queued" and
 * the one-shot transition testable without an Agent.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export const COMPRESS_TOOL_NAME = "compress";

/**
 * Cap on the model's own words. `reason` is a diagnostic — it is stored on the
 * queue and never steers the summary — so a runaway paragraph must not become
 * part of the runtime's state.
 */
export const MAX_COMPRESSION_REASON_CHARS = 240;

/**
 * What the runtime answered. `queued` means this call set the request;
 * `already-queued` means an earlier call (or `new_context`) owns it;
 * `disabled` means the session has no checkpoint to ask for.
 */
export type CompressionRequestOutcome = "queued" | "already-queued" | "disabled";

/**
 * The queued request, at most one per session.
 *
 * `note` is the model's `reason`; `manual` says which checkpoint to report —
 * a `compress` call is a manual checkpoint, while `new_context` keeps the
 * reason it has always reported.
 */
export type PendingCompression = {
  /** Epoch ms of the request that set this entry. */
  at: number;
  /** The model's own words, trimmed and capped. Diagnostics only. */
  note?: string;
  /** Report this checkpoint as `manual` in `runCompaction`. */
  manual: boolean;
};

/** The model's words as one trimmed, capped diagnostic line. */
export function compressionReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  if (text.length <= MAX_COMPRESSION_REASON_CHARS) return text;
  // The ellipsis is part of the cap, so the stored string never exceeds it.
  return `${text.slice(0, MAX_COMPRESSION_REASON_CHARS - 1)}…`;
}

/**
 * Decide whether a request is accepted, and the queue after it.
 *
 * Disabled sessions refuse without queueing: there is no checkpoint behind the
 * setting, so a queued request would be a promise the runtime never keeps.
 * A second request while one is queued is not an error — the model may not know
 * the first call landed — but it must not move the queue either, or a model
 * calling this every turn would keep postponing the boundary that consumes it.
 */
export function queueCompressionRequest(input: {
  pending: PendingCompression | undefined;
  enabled: boolean;
  reason?: unknown;
  /** Evaluation clock, epoch ms. Injected so this stays pure. */
  at: number;
}): { outcome: CompressionRequestOutcome; pending: PendingCompression | undefined } {
  if (!input.enabled) return { outcome: "disabled", pending: input.pending };
  if (input.pending) return { outcome: "already-queued", pending: input.pending };
  const note = compressionReason(input.reason);
  return {
    outcome: "queued",
    pending: { at: input.at, manual: true, ...(note ? { note } : {}) },
  };
}

const COMPRESS_TOOL_DESCRIPTION = [
  "Compress this conversation into a checkpoint, replacing the earlier messages with a summary.",
  "",
  "Use it when the conversation has grown clearly longer — many turns of tool output you no longer need at hand — and ordinary editing can no longer absorb it: keep what matters, delete what does not, and only then ask for compression. Do not use it to make room for one more read, and do not use it to escape a turn you are in the middle of.",
  "",
  "The request is queued, not performed: it is honoured at the next turn boundary, so the results you are holding right now stay in context until the current step ends. After that boundary the earlier messages are gone — only the summary remains, so anything you will need must be written down (a file, a note, the todo list) before the boundary arrives.",
  "",
  "Call it once. A call while one is already queued returns the same answer and does not queue a second compression.",
].join("\n");

/** Host surface the tool needs: one request, and the runtime's verdict. */
export type CompressionToolHost = {
  requestCompression(reason?: string): CompressionRequestOutcome;
};

function text(
  message: string,
  details: Record<string, unknown> = {},
  isError?: boolean,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

export function createCompressTool(host: CompressionToolHost): AgentTool {
  return {
    name: COMPRESS_TOOL_NAME,
    label: "Compress",
    description: COMPRESS_TOOL_DESCRIPTION,
    parameters: Type.Object(
      {
        reason: Type.Optional(
          Type.String({
            // No `maxLength`: a model that overruns is capped here rather than
            // refused, so one long sentence cannot cost it the request.
            description: `Optional. One line on why this conversation can be compressed now (at most ${MAX_COMPRESSION_REASON_CHARS} characters; longer text is truncated). Kept for diagnostics; it does not steer the summary.`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams) => {
      const raw = (rawParams ?? {}) as Record<string, unknown>;
      const reason = raw.reason;
      // The schema is the provider's copy of this rule; a model can still send
      // something else, and a number here would be stored as `undefined` queue
      // metadata with no trace of why.
      if (reason !== undefined && typeof reason !== "string") {
        return text("reason must be a string: one line on why the conversation can be compressed now.", {
          errorCode: "COMPRESSION_INVALID_ARGUMENT",
        }, true);
      }
      const clamped = compressionReason(reason);
      const outcome = host.requestCompression(clamped);
      if (outcome === "disabled") {
        // Not an error the model can fix by retrying: the setting behind the
        // checkpoint is off for this session.
        return text(
          "Context compression is disabled for this session, so nothing was queued. Keep the working set small instead: delete what you no longer need and re-read only what you do.",
          { queued: false, disabled: true },
        );
      }
      if (outcome === "already-queued") {
        return text(
          "A compression is already queued for the next turn boundary; this call did not add another. Write down anything you still need before that boundary arrives.",
          { queued: true, alreadyQueued: true, ...(clamped ? { reason: clamped } : {}) },
        );
      }
      return text(
        "Compression queued. The next turn boundary will replace the earlier messages with a summary; the results you are holding now stay in context until then, so write down anything that must survive.",
        { queued: true, ...(clamped ? { reason: clamped } : {}) },
      );
    },
  };
}
