/**
 * `memory.*` IPC bridge (ADR 0371).
 *
 * The renderer never reaches host-core directly, so every memory operation is
 * one thin forward over the host process. Payloads are narrowed here rather
 * than passed through: the host validates again, but the IPC boundary should
 * not hand it shapes the renderer invented.
 */
import { IPC } from "@pi-desktop/shared";

import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(input: Raw, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function pickNumber(input: Raw, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickBoolean(input: Raw, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function pickStrings(input: Raw, key: string): string[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && !!item.trim());
  return out.length ? out : undefined;
}

/** Drop every key the host does not take, keep only well-typed values. */
function listParams(input: unknown): Raw {
  if (!isRecord(input)) return {};
  const params: Raw = {};
  const scope = pickString(input, "scope");
  if (scope) params.scope = scope;
  const kind = pickString(input, "kind");
  if (kind) params.kind = kind;
  const pinned = pickBoolean(input, "pinned");
  if (pinned !== undefined) params.pinned = pinned;
  const projectPath = pickString(input, "projectPath");
  if (projectPath) params.projectPath = projectPath;
  const sessionId = pickString(input, "sessionId");
  if (sessionId) params.sessionId = sessionId;
  const includeSuperseded = pickBoolean(input, "includeSuperseded");
  if (includeSuperseded !== undefined) params.includeSuperseded = includeSuperseded;
  const limit = pickNumber(input, "limit");
  if (limit !== undefined) params.limit = limit;
  const offset = pickNumber(input, "offset");
  if (offset !== undefined) params.offset = offset;
  return params;
}

function updateParams(input: unknown): Raw {
  if (!isRecord(input)) return {};
  const params: Raw = {};
  const id = pickString(input, "id");
  if (id) params.id = id;
  const title = pickString(input, "title");
  if (title) params.title = title;
  const body = pickString(input, "body");
  if (body) params.body = body;
  const tags = pickStrings(input, "tags");
  if (tags) params.tags = tags;
  const confidence = pickNumber(input, "confidence");
  if (confidence !== undefined) params.confidence = confidence;
  const pinned = pickBoolean(input, "pinned");
  if (pinned !== undefined) params.pinned = pinned;
  return params;
}

function forgetParams(input: unknown): Raw {
  if (!isRecord(input)) return {};
  const params: Raw = {};
  const id = pickString(input, "id");
  if (id) params.id = id;
  const sessionId = pickString(input, "sessionId");
  if (sessionId) params.sessionId = sessionId;
  return params;
}

function tidyParams(input: unknown): Raw {
  if (!isRecord(input)) return {};
  const params: Raw = {};
  const maxAgeDays = pickNumber(input, "maxAgeDays");
  if (maxAgeDays !== undefined) params.maxAgeDays = maxAgeDays;
  const minConfidence = pickNumber(input, "minConfidence");
  if (minConfidence !== undefined) params.minConfidence = minConfidence;
  const maxLive = pickNumber(input, "maxLive");
  if (maxLive !== undefined) params.maxLive = maxLive;
  const expire = pickBoolean(input, "expire");
  if (expire !== undefined) params.expire = expire;
  return params;
}

function supersedeParams(input: unknown): Raw {
  if (!isRecord(input)) return {};
  const params: Raw = {};
  const id = pickString(input, "id");
  if (id) params.id = id;
  const replacementId = pickString(input, "replacementId");
  if (replacementId) params.replacementId = replacementId;
  return params;
}

export function registerMemoryIpc({
  registrar,
  getHost,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  const forward = (method: string, params?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call(method, params ?? {});
  };

  registrar.handle(IPC.invoke.memoryList, async (input?: unknown) =>
    forward("memory.list", listParams(input)),
  );
  registrar.handle(IPC.invoke.memoryStats, async () => forward("memory.stats", {}));
  registrar.handle(IPC.invoke.memoryUpdate, async (input?: unknown) =>
    forward("memory.update", updateParams(input)),
  );
  registrar.handle(IPC.invoke.memoryForget, async (input?: unknown) =>
    forward("memory.forget", forgetParams(input)),
  );
  registrar.handle(IPC.invoke.memoryTidy, async (input?: unknown) =>
    forward("memory.tidy", tidyParams(input)),
  );
  registrar.handle(IPC.invoke.memorySupersede, async (input?: unknown) =>
    forward("memory.supersede", supersedeParams(input)),
  );
}
