/**
 * One plugin host process for every loaded plugin.
 *
 * A per-plugin `utilityProcess.fork` is one copy of the app's own executable:
 * the host binary is the app binary, so N plugins meant N extra images of
 * `Pi-Workspace.exe` in the process tree. Endpoint protection reads that fan-out
 * — dozens of identical unsigned copies of the app image appearing while the
 * app runs — as process injection and quarantines the app
 * (`PDM:Trojan.Win32.Generic`), which is why this exists. It also costs a full
 * Node bootstrap per plugin.
 *
 * The plugin host's wire protocol is already multiplexed: every frame carries
 * the `id` of the call it answers, and `plugin-host-process.mjs` keeps one
 * tenant per plugin id. This module is the main-process half of that: a
 * `PluginProcessSpawner` that hands each plugin a facade over one shared child.
 *
 * What changes in the guarantees: isolation drops from process-level to
 * tenant-level. A plugin that throws, rejects, or times out is contained by the
 * per-tenant `try`/`catch` inside the host, and stays contained while the other
 * tenants keep running. A hard process fault — OOM, an access violation,
 * `process.exit()` in plugin code — still ends every plugin sharing the host.
 * `PluginRuntime.handleChildExit` fans that one exit out to each loaded plugin,
 * so every plugin reports its own crash and retries on its own backoff. The
 * trade is deliberate and matches a single-backend plugin runner: cheap and
 * quiet process tree, weaker blast-radius separation.
 *
 * Kill switch: `PI_PLUGIN_SHARED_HOST=0` restores one process per plugin.
 */
import { pluginChildEnv } from "./child-process-env";
import type { PluginProcessHandle, PluginProcessSpawner } from "./plugin-runtime";

/**
 * `false` puts the runtime back on one utility process per plugin. Read per
 * load, so a launch with the variable set needs no rebuild.
 */
export function sharedPluginHostEnabled(): boolean {
  return process.env.PI_PLUGIN_SHARED_HOST !== "0";
}

/**
 * The shared host is nobody's single plugin, so the identity the child inherits
 * names the host rather than a plugin id. The per-plugin path still passes the
 * real id, which is all `PI_PLUGIN_ID` ever meant to say.
 */
const SHARED_HOST_LABEL = "shared-host";

const SHARED_HOST_SERVICE_NAME = "pi-plugin-host";

/**
 * Fork one plugin host utility process.
 *
 * `stdio: "pipe"` is what keeps a plugin's own `console.log` visible; the lines
 * are attributed to a plugin only in the per-plugin mode, because a shared
 * process has several authors per stream (the host's `log` frames carry the
 * tenant instead).
 */
export async function forkPluginHostProcess(
  entry: string,
  options: { serviceName: string; pluginId: string },
): Promise<PluginProcessHandle> {
  const { utilityProcess } = await import("electron");
  const child = utilityProcess.fork(entry, [], {
    serviceName: options.serviceName,
    stdio: "pipe",
    env: pluginChildEnv(options.pluginId),
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    onLog: (handler) => {
      child.stdout?.on("data", (chunk: Buffer | string) => handler("info", String(chunk).trimEnd()));
      child.stderr?.on("data", (chunk: Buffer | string) => handler("error", String(chunk).trimEnd()));
    },
    kill: () => {
      child.kill();
    },
  };
}

/** How the shared host is created; tests inject an in-process stand-in. */
export type SharedHostFork = (entry: string) => PluginProcessHandle | Promise<PluginProcessHandle>;

type TenantListeners = {
  onMessage: Set<(message: any) => void>;
  onExit: Set<(code: number) => void>;
  onLog: Set<(level: string, message: string) => void>;
};

/**
 * A `PluginProcessSpawner` that lazily starts one child and returns a facade per
 * plugin.
 *
 * Facade contract, unchanged from a real child process:
 * - `postMessage` forwards verbatim, tagged with the plugin id the host routes by.
 * - `onMessage` receives only the frames the host addressed to this plugin.
 * - `onExit` fires once, when the host process itself dies.
 * - `kill` unloads this tenant and leaves the process serving the others. The
 *   last tenant out stops the process, so an app with no plugins has none.
 */
export function createSharedHostSpawner(options: { fork?: SharedHostFork } = {}): PluginProcessSpawner {
  const fork =
    options.fork ??
    ((entry: string) =>
      forkPluginHostProcess(entry, {
        serviceName: SHARED_HOST_SERVICE_NAME,
        pluginId: SHARED_HOST_LABEL,
      }));

  const tenants = new Map<string, TenantListeners>();
  let host: PluginProcessHandle | undefined;
  let starting: Promise<PluginProcessHandle> | undefined;

  /** Hand one host frame to the tenant it names. */
  function deliver(pluginId: string, message: any): void {
    const tenant = tenants.get(pluginId);
    // A frame for a tenant this runtime already dropped: it belongs to nobody.
    if (!tenant) return;
    if (message?.t === "log") {
      for (const handler of [...tenant.onLog]) {
        handler(String(message.level ?? "info"), String(message.message ?? ""));
      }
      return;
    }
    for (const handler of [...tenant.onMessage]) handler(message);
  }

  function route(message: any): void {
    if (!message || typeof message !== "object") return;
    const pluginId = typeof message.pluginId === "string" ? message.pluginId : undefined;
    if (pluginId) {
      deliver(pluginId, message);
      return;
    }
    // No tag: a single-tenant host answering the only tenant it can have.
    if (tenants.size === 1) deliver([...tenants.keys()][0], message);
  }

  function start(entry: string): Promise<PluginProcessHandle> {
    if (host) return Promise.resolve(host);
    if (starting) return starting;
    const attempt = Promise.resolve(fork(entry)).then((child) => {
      child.onMessage(route);
      child.onExit((code) => {
        // A hard process fault is the one failure tenant isolation cannot keep:
        // every tenant in this host is gone. Fan the single exit out so each
        // plugin runs the crash path it already owns (audit, toast, restart with
        // its own backoff), and forget the handle so the first restart forks the
        // next single host instead of one host per plugin.
        if (host === child) host = undefined;
        starting = undefined;
        const dying = [...tenants.values()];
        tenants.clear();
        for (const tenant of dying) {
          for (const handler of [...tenant.onExit]) handler(code);
        }
      });
      host = child;
      return child;
    });
    starting = attempt;
    attempt.catch(() => {
      if (starting === attempt) starting = undefined;
    });
    return attempt;
  }

  const spawn: PluginProcessSpawner = async ({ pluginId, entry }) => {
    const child = await start(entry);
    const tenant: TenantListeners = { onMessage: new Set(), onExit: new Set(), onLog: new Set() };
    tenants.set(pluginId, tenant);
    const mine = () => tenants.get(pluginId) === tenant;

    return {
      postMessage: (message) => {
        if (!mine()) throw new Error(`plugin host tenant is gone: ${pluginId}`);
        child.postMessage({ ...(message as Record<string, unknown>), pluginId });
      },
      onMessage: (handler) => {
        tenant.onMessage.add(handler);
      },
      onExit: (handler) => {
        tenant.onExit.add(handler);
      },
      onLog: (handler) => {
        // Accepted and never called: a shared process has several authors per
        // stdio stream, so attribution comes from `log` frames instead.
        tenant.onLog.add(handler);
      },
      kill: () => {
        const attached = mine();
        if (attached) tenants.delete(pluginId);
        if (!host) return;
        if (attached) {
          // Killing the child would take every other plugin down with it.
          // Unload the tenant instead: the host drops its module, registrations
          // and in-flight calls, and keeps serving the rest. The runtime has
          // already sent `lifecycle.unload` before calling `kill`, so this is a
          // late duplicate the host answers with `PLUGIN_NOT_LOADED` and nobody
          // is waiting for.
          try {
            host.postMessage({
              t: "call",
              id: `unload-${pluginId}-${Date.now()}`,
              pluginId,
              method: "lifecycle.unload",
              payload: {},
            });
          } catch {
            // The host is already gone; there is nothing left to unload.
          }
        }
        // Last tenant out stops the process, so the app's process tree follows
        // the set of enabled plugins instead of outliving it.
        if (tenants.size === 0 && !starting && host) {
          const idle = host;
          host = undefined;
          try {
            idle.kill();
          } catch {
            // Already gone.
          }
        }
      },
    };
  };
  return spawn;
}
