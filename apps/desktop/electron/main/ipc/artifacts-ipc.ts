/**
 * `artifacts.*` IPC bridge.
 *
 * `artifacts.list` already exists in host-core (04-data-storage §4.9); the
 * renderer had no way to ask for it. Parameters are narrowed here so the IPC
 * boundary never forwards a shape the renderer invented — the host validates
 * again, but a mistyped field should not travel at all.
 */
import { IPC } from "@pi-desktop/shared";

import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

const MAX_LIMIT = 1000;

function listParams(input: unknown): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) return params;
  const raw = input as Record<string, unknown>;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
  if (sessionId) params.sessionId = sessionId;
  if (typeof raw.limit === "number" && Number.isFinite(raw.limit)) {
    const limit = Math.trunc(raw.limit);
    if (limit > 0) params.limit = Math.min(limit, MAX_LIMIT);
  }
  return params;
}

export function registerArtifactsIpc({
  registrar,
  getHost,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  registrar.handle(IPC.invoke.artifactsList, async (input?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("artifacts.list", listParams(input));
  });
}
