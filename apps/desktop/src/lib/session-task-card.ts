import type { UiMessage } from "@pi-workspace/shared";
import { toolResultPayload } from "./tool-presentation";

/**
 * A `SessionTask` spawn in the transcript (ADR 0386).
 *
 * The spawn creates a real durable session, so the supervisor's own transcript
 * can show what it started. The presentation reuses the delegation card, but the
 * data is different from an in-process delegate: there is no `SubagentRun`
 * (the child is a session the shell renders elsewhere) and the tool call
 * settles as soon as the child is admitted — its own status says nothing about
 * whether the worker is still running.
 *
 * Everything here is pure so the mapping is testable without a renderer.
 */
export type SpawnedSessionState = "running" | "completed" | "failed" | "stopped" | "aborted";

export type SpawnedSession = {
  /** Durable child session the card opens. */
  sessionId: string;
  /** Host delivery id; the stable key for this spawn. */
  messageId: string;
  /** What the card is titled: the requested title, else the task's first line. */
  title: string;
  /** Task text, single line, bounded. */
  task: string;
  state: SpawnedSessionState;
};

const TASK_SUFFIX = "sessiontask";
const TASK_LIMIT = 160;
const TITLE_LIMIT = 80;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Provider namespaces and separators are stripped the way `tool-display` does. */
export function isSessionTaskTool(toolName?: string): boolean {
  const normalized = (toolName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized === TASK_SUFFIX || normalized.endsWith(TASK_SUFFIX);
}

/**
 * The host's delivery status, not the tool call's. `queued` already means the
 * child exists and will run, which the card shows as running; a cancelled child
 * reads as stopped and an interrupted one as aborted, matching the vocabulary
 * the delegation presentation already uses.
 */
export function spawnedSessionState(value: unknown): SpawnedSessionState | undefined {
  switch (value) {
    case "queued":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "interrupted":
      return "aborted";
    default:
      return undefined;
  }
}

/** i18n key for a card's state badge. */
export function spawnedSessionStateKey(state: SpawnedSessionState): string {
  return `chat.spawnedSession${state.charAt(0).toUpperCase()}${state.slice(1)}`;
}

function oneLine(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/**
 * A spawn row, or `null` for every other tool call — including the same tool's
 * `send` / `status` / `result` / `wait` actions, which drive existing work and
 * must not become new subagent rows (the rule ADR 0089 applies to TaskWait).
 */
export function spawnedSessionFrom(message: UiMessage): SpawnedSession | null {
  if (!isSessionTaskTool(message.toolName)) return null;
  const args = asRecord(message.toolArgs);
  if (args?.action !== "spawn") return null;
  const payload = asRecord(toolResultPayload(message));
  const sessionId = payload?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return null;
  const messageId = typeof payload.messageId === "string" ? payload.messageId : message.id;
  const task = oneLine(args.task, TASK_LIMIT);
  const title = oneLine(args.title, TITLE_LIMIT) || task || sessionId;
  // A spawn that reported no status is still being admitted.
  const state = spawnedSessionState(payload.status) ?? "running";
  return { sessionId, messageId, title, task, state };
}
