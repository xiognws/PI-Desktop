/**
 * Translate the Rust kernel's wire vocabulary into this app's agent contract.
 *
 * The kernel is a separate program with its own message and event shapes
 * (snake_case fields, `parts` instead of `content`, epoch-ms timestamps). The
 * renderer, the persistence outbox and the transcript all consume
 * `AgentEventEnvelope` from `@pi-workspace/shared`, and none of them should
 * learn a second vocabulary. This module is the one place that knows both.
 *
 * It is a pure function layer on purpose: every rule below can be tested
 * against a recorded kernel frame, without spawning anything.
 *
 * Field mapping (kernel -> here):
 *
 *   message.parts[{type:"text"}]        -> content
 *   message.parts[{type:"thinking"}]    -> thinking
 *   message.created_at_ms               -> createdAt (ISO string)
 *   message.stop_reason                 -> status / outputTruncated
 *   message.usage (camelCase, no total) -> MessageUsage (totalTokens computed)
 *   event.type                          -> unchanged (the vocabularies match by design)
 */
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentStatus,
  ContextCompactionReason,
  MessageUsage,
  PlanArtifact,
  PlanExecutionState,
  PlanProposal,
  PlanningState,
  UiMessage,
} from "@pi-workspace/shared";
import { isGlobalPermissionMode } from "@pi-workspace/shared";

type Wire = Record<string, unknown>;

const isWire = (value: unknown): value is Wire =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** `stop_reason` decides how the row renders after a reload. */
function statusForStopReason(
  stopReason: string | undefined,
): { status?: UiMessage["status"]; outputTruncated?: boolean } {
  switch (stopReason) {
    case undefined:
    case "end_turn":
    case "tool_use":
      return { status: "complete" };
    case "max_tokens":
    case "length":
      return { status: "complete", outputTruncated: true };
    case "aborted":
    case "abort":
      return { status: "aborted" };
    case "error":
      return { status: "error" };
    default:
      return {};
  }
}

/**
 * The kernel reports the four provider counters; the app's `MessageUsage` also
 * carries `totalTokens`, which the usage ring and cost rollups read directly.
 * Reasoning tokens are billed inside output tokens, so they are not added.
 */
export function adaptKernelUsage(raw: unknown): MessageUsage | null {
  if (!isWire(raw)) return null;
  const inputTokens = count(raw.inputTokens) ?? 0;
  const outputTokens = count(raw.outputTokens) ?? 0;
  const cacheReadTokens = count(raw.cacheReadTokens);
  const cacheWriteTokens = count(raw.cacheWriteTokens);
  const reasoningTokens = count(raw.reasoningTokens);
  const reportedTotal = count(raw.totalTokens);
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    totalTokens: reportedTotal ?? inputTokens + outputTokens,
  };
}

function partText(parts: unknown[], kinds: string[]): string | undefined {
  const joined = parts
    .filter((part) => isWire(part) && kinds.includes(String(part.type)))
    .map((part) => (isWire(part) ? text(part.text) ?? "" : ""))
    .join("");
  return joined.length > 0 ? joined : undefined;
}

/**
 * One kernel message as a `UiMessage`.
 *
 * `null` means the frame carried no id or no role: a row the transcript cannot
 * address is worse than a dropped frame, and the caller reports the drop.
 */
export function adaptKernelMessage(raw: unknown): UiMessage | null {
  if (!isWire(raw)) return null;
  const id = text(raw.id);
  const role = text(raw.role);
  if (!id || !role) return null;
  if (!["user", "assistant", "system", "tool"].includes(role)) return null;

  const parts = Array.isArray(raw.parts) ? raw.parts : [];
  const content = partText(parts, ["text"]) ?? (typeof raw.content === "string" ? raw.content : "");
  const thinking = partText(parts, ["thinking", "reasoning"]);
  const createdAtMs = count(raw.created_at_ms) ?? count(raw.createdAtMs) ?? Date.now();
  const usage = adaptKernelUsage(raw.usage) ?? undefined;
  const stop = statusForStopReason(text(raw.stop_reason));
  // The kernel measures these per request and writes them snake_case, like every other
  // field on the wire. The inspector's throughput, network-wait and model-response rows
  // read them off the message, so they have to survive this adapter.
  const providerWaitMs = count(raw.provider_wait_ms) ?? count(raw.providerWaitMs);
  const modelStreamDurationMs =
    count(raw.model_stream_duration_ms) ?? count(raw.modelStreamDurationMs);
  const responseDurationMs = count(raw.response_duration_ms) ?? count(raw.responseDurationMs);

  return {
    id,
    role: role as UiMessage["role"],
    content,
    ...(thinking ? { thinking } : {}),
    createdAt: new Date(createdAtMs).toISOString(),
    ...(stop.status ? { status: stop.status } : {}),
    ...(stop.outputTruncated ? { outputTruncated: true } : {}),
    ...(usage ? { usage } : {}),
    ...(providerWaitMs === undefined ? {} : { providerWaitMs }),
    ...(modelStreamDurationMs === undefined ? {} : { modelStreamDurationMs }),
    ...(responseDurationMs === undefined ? {} : { responseDurationMs }),
  };
}

function compactionReason(raw: unknown): ContextCompactionReason {
  const value = String(raw ?? "threshold");
  // The kernel names the same three triggers; an unknown one is reported as the
  // automatic path so the transcript row still renders a reason.
  return value === "manual" || value === "overflow" || value === "threshold" ? value : "threshold";
}

function adaptStatus(raw: unknown, sessionId: string): AgentStatus | null {
  if (!isWire(raw)) return null;
  return {
    sessionId: text(raw.sessionId) ?? sessionId,
    isRunning: raw.isRunning === true || raw.is_running === true,
    ...(text(raw.currentTurnId) ?? text(raw.current_turn_id)
      ? { currentTurnId: text(raw.currentTurnId) ?? text(raw.current_turn_id) }
      : {}),
    ...(text(raw.modelId) ? { modelId: text(raw.modelId) } : {}),
    pendingToolConfirmations: count(raw.pendingToolConfirmations) ?? 0,
  };
}

/**
 * The plan artifact the renderer shows beside an approval.
 *
 * `undefined` means the frame carried no artifact this contract can address: a
 * review opened on a half-parsed artifact would point at a file that is not
 * there. The kernel forwards the host's own object, so the three fields are the
 * `PlanArtifact` shape from `@pi-workspace/shared`.
 */
function planArtifact(raw: unknown): PlanArtifact | undefined {
  if (!isWire(raw)) return undefined;
  const relativePath = text(raw.relativePath);
  const sha256 = text(raw.sha256);
  const sizeBytes = count(raw.sizeBytes);
  if (!relativePath || !sha256 || sizeBytes === undefined) return undefined;
  return { relativePath, sha256, sizeBytes };
}

/** The kernel emits these four; anything else is a frame to drop, not to guess. */
function planExecutionState(raw: string | undefined): PlanExecutionState | undefined {
  return raw === "queued" || raw === "running" || raw === "completed" || raw === "interrupted"
    ? raw
    : undefined;
}

/**
 * `planning_state`: the plan/goal negotiation this session is in.
 *
 * Payload is `PlanningStateEvent` from `@pi-workspace/shared`, field for field —
 * `apps/desktop/src/stores/slices/events-slice.ts` reads `state`, `kind`,
 * `proposalId` and `proposal` off the event itself, so a nested or renamed field
 * is silently not drawn.
 */
function adaptPlanningState(raw: Wire): AgentEvent | null {
  const state = text(raw.state);
  if (state !== "inactive" && state !== "planning" && state !== "awaiting_approval") return null;
  const kind = text(raw.kind);
  const action = text(raw.action);
  const targetPermissionMode = text(raw.targetPermissionMode);
  const executionState = planExecutionState(text(raw.executionState));
  const artifact = planArtifact(raw.artifact);
  // A proposal is the host's row forwarded whole: it is only usable when it
  // still names itself, and the renderer keys checkpoints by that id.
  const proposal =
    isWire(raw.proposal) && text(raw.proposal.id) && text(raw.proposal.sessionId)
      ? (raw.proposal as unknown as PlanProposal)
      : undefined;
  return {
    type: "planning_state",
    state: state as PlanningState,
    ...(kind === "plan" || kind === "goal" ? { kind } : {}),
    ...(text(raw.proposalId) ? { proposalId: text(raw.proposalId) } : {}),
    ...(text(raw.title) ? { title: text(raw.title) } : {}),
    ...(text(raw.markdown) ? { markdown: text(raw.markdown) } : {}),
    ...(text(raw.question) ? { question: text(raw.question) } : {}),
    ...(artifact ? { artifact } : {}),
    ...(count(raw.version) === undefined ? {} : { version: count(raw.version) }),
    ...(text(raw.plan) ? { plan: text(raw.plan) } : {}),
    ...(action === "approve" || action === "reject" ? { action } : {}),
    ...(isGlobalPermissionMode(targetPermissionMode) ? { targetPermissionMode } : {}),
    ...(text(raw.executionId) ? { executionId: text(raw.executionId) } : {}),
    ...(executionState ? { executionState } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

function adaptEvent(raw: unknown, envelope: { sessionId: string }): AgentEvent | null {
  if (!isWire(raw)) return null;
  const type = text(raw.type);
  if (!type) return null;
  switch (type) {
    case "agent_start":
      return { type: "agent_start" };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "agent_end": {
      const ids = Array.isArray(raw.messageIds) ? raw.messageIds.filter((id): id is string => typeof id === "string") : [];
      return { type: "agent_end", messageIds: ids };
    }
    case "message_start": {
      const message = adaptKernelMessage(raw.message);
      return message ? { type: "message_start", message } : null;
    }
    case "message_update": {
      const message = adaptKernelMessage(raw.message);
      if (!message) return null;
      const deltaText = typeof raw.deltaText === "string" ? raw.deltaText : undefined;
      const deltaThinking = typeof raw.deltaThinking === "string" ? raw.deltaThinking : undefined;
      return {
        type: "message_update",
        message,
        ...(deltaText === undefined ? {} : { deltaText }),
        ...(deltaThinking === undefined ? {} : { deltaThinking }),
        ...(raw.stream === "delta" ? { stream: "delta" as const } : {}),
      };
    }
    case "message_end": {
      const message = adaptKernelMessage(raw.message);
      return message ? { type: "message_end", message } : null;
    }
    case "tool_start":
      return {
        type: "tool_start",
        toolCallId: text(raw.toolCallId) ?? "",
        toolName: text(raw.toolName) ?? "unknown",
        args: raw.args ?? null,
      };
    case "tool_end":
      return {
        type: "tool_end",
        toolCallId: text(raw.toolCallId) ?? "",
        result: raw.result ?? null,
        ...(raw.isError === true ? { isError: true } : {}),
      };
    case "usage": {
      const usage = adaptKernelUsage(raw.usage);
      return usage ? { type: "usage", usage } : null;
    }
    case "error": {
      // Two producers, one vocabulary: the Node sidecar nests the fields
      // (`error: {code, message}`), while the Rust kernel flattens them onto the
      // event (`{type: "error", code, message}`). Reading only the nested form
      // turned every kernel failure into "RUNTIME_ERROR / agent runtime error" —
      // a report no user can act on and no reader can diagnose.
      const nested = isWire(raw.error) ? raw.error : null;
      const field = (key: string): unknown =>
        nested && nested[key] !== undefined ? nested[key] : raw[key];
      const code = text(field("code")) ?? "RUNTIME_ERROR";
      const message = text(field("message")) ?? "agent runtime error";
      const details = field("details");
      return {
        type: "error",
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details }),
          ...(field("retriable") === true ? { retriable: true } : {}),
        },
      };
    }
    case "skill_review": {
      const outcome = text(raw.outcome);
      if (outcome !== "applied" && outcome !== "skipped" && outcome !== "failed") return null;
      return {
        type: "skill_review",
        outcome,
        ...(text(raw.reason) ? { reason: text(raw.reason) } : {}),
        ...(Array.isArray(raw.actions)
          ? { actions: raw.actions.filter((a): a is string => typeof a === "string") }
          : {}),
      };
    }
    case "status": {
      const status = adaptStatus(raw.status, envelope.sessionId);
      return status ? { type: "status", status } : null;
    }
    case "compaction_start":
      return { type: "compaction_start", reason: compactionReason(raw.reason) };
    case "compaction_end":
      return {
        type: "compaction_end",
        reason: compactionReason(raw.reason),
        ok: raw.ok !== false,
        willRetry: raw.willRetry === true || raw.will_retry === true,
        ...(count(raw.tokensBefore) === undefined ? {} : { tokensBefore: count(raw.tokensBefore) }),
        ...(text(raw.firstKeptMessageId) ? { firstKeptMessageId: text(raw.firstKeptMessageId) } : {}),
      };
    case "planning_state":
      return adaptPlanningState(raw);
    case "asktool_request": {
      const request = isWire(raw.request) ? raw.request : null;
      return request ? ({ type: "asktool_request", request } as AgentEvent) : null;
    }
    default:
      return null;
  }
}

/**
 * One `agent.event` notification from the kernel as this app's envelope.
 *
 * `null` means the frame is not addressable (no session, unknown event type) or
 * carries a message the transcript cannot store; the caller counts it so a
 * kernel-side vocabulary drift is visible instead of silently shrinking the
 * transcript.
 */
export function adaptKernelEvent(params: unknown): AgentEventEnvelope | null {
  if (!isWire(params)) return null;
  const sessionId = text(params.sessionId) ?? text((isWire(params.event) ? params.event.sessionId : undefined));
  if (!sessionId) return null;
  const event = adaptEvent(params.event, { sessionId });
  if (!event) return null;
  const turnId = text(params.turnId);
  const ts = count(params.ts) ?? Date.now();
  return {
    sessionId,
    ...(turnId ? { turnId } : {}),
    ts,
    event,
    ...(text(params.parentToolCallId) ? { parentToolCallId: text(params.parentToolCallId) } : {}),
    ...(text(params.nestedParentToolCallId)
      ? { nestedParentToolCallId: text(params.nestedParentToolCallId) }
      : {}),
    ...(text(params.agentName) ? { agentName: text(params.agentName) } : {}),
  };
}
