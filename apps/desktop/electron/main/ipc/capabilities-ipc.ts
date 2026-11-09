/**
 * `capabilities.*` IPC bridge (D691).
 *
 * Two back ends, deliberately split by ownership: the host-core side scans
 * the data directory and owns trust/enabled state, while loading and running
 * a package happens in the agent sidecar. Invoking therefore needs both —
 * the host answers "may this run", the sidecar answers "run it".
 *
 * Parameters are narrowed here so the IPC boundary never forwards a shape the
 * renderer invented; both back ends validate again.
 */
import { shell } from "electron";
import { IPC, type CapabilitySummary } from "@pi-workspace/shared";

import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import { stripWinLongPrefix } from "../path-utils";
import type { IpcRegistrar } from "./types";

const MAX_ID_CHARS = 200;
const MAX_ACTION_CHARS = 120;
const MAX_DIGEST_CHARS = 128;

function requireId(input: unknown, what: string): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${what} expects { id }`);
  }
  const raw = (input as Record<string, unknown>).id;
  const id = typeof raw === "string" ? raw.trim().slice(0, MAX_ID_CHARS) : "";
  if (!id) throw new Error(`${what} expects a non-empty id`);
  return id;
}

function toggleParams(input: unknown): { id: string; enabled: boolean } {
  const id = requireId(input, "capabilities.setEnabled");
  const enabled = (input as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("capabilities.setEnabled expects a boolean enabled");
  }
  return { id, enabled };
}

function trustParams(input: unknown): { id: string; digest: string; trusted: boolean } {
  const id = requireId(input, "capabilities.trust");
  const raw = input as Record<string, unknown>;
  const digest = typeof raw.digest === "string" ? raw.digest.trim().slice(0, MAX_DIGEST_CHARS) : "";
  if (!digest) throw new Error("capabilities.trust expects a non-empty digest");
  if (typeof raw.trusted !== "boolean") {
    throw new Error("capabilities.trust expects a boolean trusted");
  }
  return { id, digest, trusted: raw.trusted };
}

function invokeParams(input: unknown): { id: string; action: string; args: unknown } {
  const id = requireId(input, "capabilities.invoke");
  const raw = input as Record<string, unknown>;
  const action = typeof raw.action === "string" ? raw.action.trim().slice(0, MAX_ACTION_CHARS) : "";
  if (!action) throw new Error("capabilities.invoke expects a non-empty action");
  return { id, action, args: raw.args };
}

export function registerCapabilitiesIpc({
  registrar,
  getHost,
  getSidecar,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
}): void {
  /**
   * Push the host's view of every package into the sidecar so it loads the
   * trusted, enabled ones. Called on every list so a reload self-heals:
   * nothing else in the process can leave the two sides out of step.
   */
  async function syncSidecar(
    sidecar: AgentSidecar,
    packages: CapabilitySummary[],
  ): Promise<void> {
    await sidecar.call("capability.sync", { packages }).catch(() => undefined);
  }

  registrar.handle(IPC.invoke.capabilitiesList, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const listed = (await host.call("capabilities.list", {})) as {
      packages?: CapabilitySummary[];
    };
    const packages = listed.packages ?? [];
    const sidecar = getSidecar();
    if (sidecar) await syncSidecar(sidecar, packages);
    return { packages };
  });

  registrar.handle(IPC.invoke.capabilitiesRuntime, async () => {
    const sidecar = getSidecar();
    if (!sidecar) return { states: [] };
    return sidecar.call("capability.list", {});
  });

  registrar.handle(IPC.invoke.capabilitiesSetEnabled, async (input?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await host.call("capabilities.setEnabled", toggleParams(input));
    const packages = ((result as { packages?: CapabilitySummary[] }).packages ?? []);
    const sidecar = getSidecar();
    if (sidecar) await syncSidecar(sidecar, packages);
    return { packages };
  });

  registrar.handle(IPC.invoke.capabilitiesTrust, async (input?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await host.call("capabilities.setTrusted", trustParams(input));
    const packages = ((result as { packages?: CapabilitySummary[] }).packages ?? []);
    const sidecar = getSidecar();
    if (sidecar) await syncSidecar(sidecar, packages);
    return { packages };
  });

  registrar.handle(IPC.invoke.capabilitiesReveal, async (input?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const { path } = (await host.call("capabilities.dir", {
      id: requireId(input, "capabilities.reveal"),
    })) as { path?: string };
    if (!path) throw new Error("capability directory not found");
    shell.showItemInFolder(stripWinLongPrefix(path));
    return { path };
  });

  /**
   * The scan root, created on demand. Opening the folder is how a user adds a
   * package at all, so this has to work on a machine that has never had one.
   */
  registrar.handle(IPC.invoke.capabilitiesRoot, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const { path } = (await host.call("capabilities.root", {})) as { path?: string };
    if (!path) throw new Error("capability directory unavailable");
    shell.showItemInFolder(stripWinLongPrefix(path));
    return { path };
  });

  registrar.handle(IPC.invoke.capabilitiesInvoke, async (input?: unknown) => {
    const sidecar = getSidecar();
    if (!sidecar) throw new Error("agent runtime unavailable");
    return sidecar.call("capability.invoke", invokeParams(input));
  });
}
