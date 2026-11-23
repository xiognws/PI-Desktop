/**
 * `widgets.*` IPC bridge (D699).
 *
 * Two back ends, deliberately split by ownership: the host-core side scans
 * the data directory and owns trust/enabled state, while loading and running
 * a package happens in a JavaScript host. Invoking therefore needs both — the
 * host answers "may this run", the JS host answers "run it".
 *
 * Which JS host is a runtime detail, not a second contract: the Node sidecar
 * runs the package when it answers turns, and when the Rust kernel does, main
 * runs it itself through {@link WidgetCommandHost}. Both use the same registry,
 * so the renderer sees one surface either way.
 *
 * Parameters are narrowed here so the IPC boundary never forwards a shape the
 * renderer invented; both back ends validate again.
 */
import { shell } from "electron";
import { IPC, type WidgetSummary } from "@pi-workspace/shared";

import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import { stripWinLongPrefix } from "../path-utils";
import { WidgetCommandHost } from "../widget-commands";
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
  const id = requireId(input, "widgets.setEnabled");
  const enabled = (input as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("widgets.setEnabled expects a boolean enabled");
  }
  return { id, enabled };
}

function trustParams(input: unknown): { id: string; digest: string; trusted: boolean } {
  const id = requireId(input, "widgets.trust");
  const raw = input as Record<string, unknown>;
  const digest = typeof raw.digest === "string" ? raw.digest.trim().slice(0, MAX_DIGEST_CHARS) : "";
  if (!digest) throw new Error("widgets.trust expects a non-empty digest");
  if (typeof raw.trusted !== "boolean") {
    throw new Error("widgets.trust expects a boolean trusted");
  }
  return { id, digest, trusted: raw.trusted };
}

function invokeParams(input: unknown): { id: string; action: string; args: unknown } {
  const id = requireId(input, "widgets.invoke");
  const raw = input as Record<string, unknown>;
  const action = typeof raw.action === "string" ? raw.action.trim().slice(0, MAX_ACTION_CHARS) : "";
  if (!action) throw new Error("widgets.invoke expects a non-empty action");
  return { id, action, args: raw.args };
}

export function registerWidgetsIpc({
  registrar,
  getHost,
  getSidecar,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
}): void {
  /**
   * The JS host that runs package code, when it is not the sidecar.
   *
   * Built here rather than injected: `registerWidgetsIpc` is called with the
   * host and sidecar accessors only, and main already owns the host client this
   * needs. Construction is free — the runtime module loads on first use.
   */
  const widgetHost = new WidgetCommandHost({
    callHost: (method, params) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      return host.call(method, params);
    },
    pythonInterpreter: () => process.env.PI_DESKTOP_WIDGET_PYTHON || undefined,
  });

  /**
   * True when the runtime answering turns has no JavaScript host, so main is
   * the one that loads and runs packages. Same rule as
   * `extensions.command.run` in `register.ts`, read from the one place that
   * knows which runtime is running.
   */
  function runsWidgetsHere(sidecar: AgentSidecar | null): boolean {
    return sidecar?.runtime === "rust";
  }

  /**
   * Push the host's view of every package into whichever host executes package
   * code, so it loads the trusted, enabled ones. Called on every list so a
   * reload self-heals: nothing else in the process can leave the two sides out
   * of step.
   */
  async function syncRuntime(
    sidecar: AgentSidecar,
    packages: WidgetSummary[],
  ): Promise<void> {
    if (runsWidgetsHere(sidecar)) {
      await widgetHost.sync({ packages }).catch(() => undefined);
      return;
    }
    await sidecar.call("widget.sync", { packages }).catch(() => undefined);
  }

  registrar.handle(IPC.invoke.widgetsList, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const listed = (await host.call("widgets.list", {})) as {
      packages?: WidgetSummary[];
    };
    const packages = listed.packages ?? [];
    const sidecar = getSidecar();
    if (sidecar) await syncRuntime(sidecar, packages);
    return { packages };
  });

  registrar.handle(IPC.invoke.widgetsRuntime, async () => {
    const sidecar = getSidecar();
    if (!sidecar) return { states: [] };
    if (runsWidgetsHere(sidecar)) return widgetHost.list();
    return sidecar.call("widget.list", {});
  });

  registrar.handle(IPC.invoke.widgetsSetEnabled, async (input?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await host.call("widgets.setEnabled", toggleParams(input));
    const packages = ((result as { packages?: WidgetSummary[] }).packages ?? []);
    const sidecar = getSidecar();
    if (sidecar) await syncRuntime(sidecar, packages);
    return { packages };
  });

  registrar.handle(IPC.invoke.widgetsTrust, async (input?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await host.call("widgets.setTrusted", trustParams(input));
    const packages = ((result as { packages?: WidgetSummary[] }).packages ?? []);
    const sidecar = getSidecar();
    if (sidecar) await syncRuntime(sidecar, packages);
    return { packages };
  });

  registrar.handle(IPC.invoke.widgetsReveal, async (input?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const { path } = (await host.call("widgets.dir", {
      id: requireId(input, "widgets.reveal"),
    })) as { path?: string };
    if (!path) throw new Error("widget directory not found");
    shell.showItemInFolder(stripWinLongPrefix(path));
    return { path };
  });

  /**
   * The scan root, created on demand. Opening the folder is how a user adds a
   * package at all, so this has to work on a machine that has never had one.
   */
  registrar.handle(IPC.invoke.widgetsRoot, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const { path } = (await host.call("widgets.root", {})) as { path?: string };
    if (!path) throw new Error("widget directory unavailable");
    shell.showItemInFolder(stripWinLongPrefix(path));
    return { path };
  });

  registrar.handle(IPC.invoke.widgetsInvoke, async (input?: unknown) => {
    const sidecar = getSidecar();
    if (!sidecar) throw new Error("agent runtime unavailable");
    const params = invokeParams(input);
    if (runsWidgetsHere(sidecar)) return widgetHost.invoke(params);
    return sidecar.call("widget.invoke", params);
  });
}
