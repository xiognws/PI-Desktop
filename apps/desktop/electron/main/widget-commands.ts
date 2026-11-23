/**
 * Widget packages inside Electron main (D699; ADR 0214's rule for surfaces the
 * Rust kernel cannot answer).
 *
 * A widget package is user-written code, so loading and running one needs a
 * JavaScript host. The Node sidecar is one and keeps doing it. The Rust kernel
 * is not, and should not grow one — so when the kernel answers turns, main runs
 * the package itself, from the same authoritative list host-core produces
 * (discovery, digest trust, the enabled set) and through the same registry the
 * sidecar uses. Both hosts therefore agree on which packages may run, on what
 * `widget.list` returns, and on which failures a package can produce; the IPC
 * surface does not fork with the runtime.
 *
 * This mirrors `AgentExtensionBridge.runCommand` (`agent-extensions.ts`), which
 * closed the same shape of gap for `extensions.command.run`: main is the
 * executor, and its lazy load keeps package code out of the startup path.
 */
import {
  ErrorCodes,
  type WidgetInvokeResult,
  type WidgetRuntimeState,
  type WidgetSummary,
} from "@pi-workspace/shared";

/**
 * The slice of the agent runtime's widget registry main needs.
 *
 * Deliberately structural: main is not allowed to grow a second widget
 * implementation, so this names only the members it calls. The shipped registry
 * (and the sidecar's use of it) stays the single definition of loading, trust
 * filtering, timeouts and log rings.
 */
export type WidgetPackageRegistry = {
  /** Load every enabled, trusted package from the host's list. */
  sync(summaries: WidgetSummary[]): Promise<WidgetRuntimeState[]>;
  /** Packages currently loaded. */
  list(): WidgetSummary[];
  /** Runtime state of every package the host reported, skips included. */
  states(): WidgetRuntimeState[];
  /** Run one action of one loaded package. */
  invoke(id: string, action: string, args: unknown): Promise<WidgetInvokeResult>;
  /** Recent log lines of one package. */
  logsFor(id: string): string[];
  /** Drop every package, disposing whatever it started. */
  clear(): void;
};

/** Where host-core may be reached for a package's `host` permission. */
export type WidgetHostCall = (method: string, params: unknown) => Promise<unknown>;

/** The agent-runtime module main loads, narrowed to what this file uses. */
export type WidgetRuntimeModule = {
  WidgetRegistry: new (
    host: { call(method: string, params?: unknown): Promise<unknown> },
    options?: { pythonInterpreter?: () => string | undefined },
  ) => WidgetPackageRegistry;
  /**
   * Host RPCs a package may reach. Enforced here as well as in the sidecar: a
   * package's permission is narrow on its own, and the allowlist is what keeps
   * it narrow on whichever host runs it.
   */
  WIDGET_HOST_METHODS: ReadonlySet<string>;
};

/**
 * The shipped registry, loaded on first use.
 *
 * The dynamic import is the point: a widget package is optional, and main must
 * not pay for the loader (or for `jiti`, which the JavaScript path reaches) at
 * startup. The path is the package's source because
 * `@pi-workspace/agent-runtime` publishes only its root entry — the day it
 * exposes a widgets subpath, this becomes that import and nothing else changes.
 */
async function loadWidgetRuntimeModule(): Promise<WidgetRuntimeModule> {
  const module = await import(
    "../../../../packages/agent-runtime/src/widgets/index.js"
  );
  return module;
}

export type WidgetCommandHostOptions = {
  /**
   * Call host-core on a package's behalf. The caller owns the client; this
   * object owns the allowlist.
   */
  callHost: WidgetHostCall;
  /**
   * Interpreter for `runtime.kind: "python"` packages. Same policy the sidecar
   * is handed: main resolves it once (it knows the bundled runtime and the
   * user's preference) and publishes it in `PI_DESKTOP_WIDGET_PYTHON`.
   */
  pythonInterpreter?: () => string | undefined;
  /** Overrides the module {@link WidgetCommandHost} loads. Used by tests. */
  moduleFactory?: () => Promise<WidgetRuntimeModule>;
};

/**
 * Main's widget host: the same five methods the sidecar answers, over a
 * process-scoped registry.
 *
 * Process-scoped rather than session-scoped for the reason the sidecar is: a
 * package is code the user installed, and loading it once per session would
 * double every side effect it has.
 */
export class WidgetCommandHost {
  private readonly options: WidgetCommandHostOptions;
  private registry: Promise<WidgetPackageRegistry> | null = null;

  constructor(options: WidgetCommandHostOptions) {
    this.options = options;
  }

  /**
   * `widget.sync` — replace what is loaded with the host's list.
   *
   * The list is the host's, unfiltered here: the registry applies "enabled",
   * "manifest readable" and "digest trusted" itself and reports every package
   * it skipped, so main cannot widen the trust set by passing more through.
   */
  async sync(input: unknown): Promise<{ states: WidgetRuntimeState[] }> {
    const packages = Array.isArray((input as { packages?: unknown })?.packages)
      ? ((input as { packages: WidgetSummary[] }).packages)
      : [];
    const registry = await this.loadedRegistry();
    return { states: await registry.sync(packages) };
  }

  /** `widget.list` — what is loaded, and why anything else is not. */
  async list(): Promise<{ packages: WidgetSummary[]; states: WidgetRuntimeState[] }> {
    const registry = await this.loadedRegistry();
    return { packages: registry.list(), states: registry.states() };
  }

  /**
   * `widget.invoke` — run one action.
   *
   * Argument shape matches the sidecar's handler: a missing id or action is
   * `INVALID_ARGUMENT` (the sidecar's `-32602`), and an unknown package or
   * action rejects with the same message the registry produces there.
   */
  async invoke(input: unknown): Promise<WidgetInvokeResult> {
    const raw = (input ?? {}) as Record<string, unknown>;
    const id = String(raw.id ?? "").trim();
    const action = String(raw.action ?? "").trim();
    if (!id) {
      throw Object.assign(new Error("widget.invoke needs an id"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!action) {
      throw Object.assign(new Error("widget.invoke needs an action"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const registry = await this.loadedRegistry();
    return registry.invoke(id, action, raw.args);
  }

  /** `widget.logs` — one package's log ring. */
  async logs(input: unknown): Promise<{ logs: string[] }> {
    const id = String((input as { id?: unknown })?.id ?? "").trim();
    const registry = await this.loadedRegistry();
    return { logs: registry.logsFor(id) };
  }

  /** `widget.clear` — drop every package, and whatever it started. */
  async clear(): Promise<{ ok: true }> {
    const registry = await this.loadedRegistry();
    registry.clear();
    return { ok: true };
  }

  /**
   * The registry for this process, built once.
   *
   * A failed load is not cached: the next call retries instead of reporting the
   * same error for the life of the window.
   */
  private loadedRegistry(): Promise<WidgetPackageRegistry> {
    if (this.registry) return this.registry;
    const factory = this.options.moduleFactory ?? loadWidgetRuntimeModule;
    const ready = Promise.resolve(factory()).then((module) =>
      new module.WidgetRegistry(
        { call: (method, params) => this.callHost(module, method, params) },
        {
          ...(this.options.pythonInterpreter
            ? { pythonInterpreter: this.options.pythonInterpreter }
            : {}),
        },
      ),
    );
    ready.catch(() => {
      if (this.registry === ready) this.registry = null;
    });
    this.registry = ready;
    return ready;
  }

  /**
   * A package's `host` permission, kept to the read-only set the sidecar's
   * parent proxy allows.
   *
   * The registry already refuses the call without the permission; this is the
   * second half of the same rule, so running a package here cannot reach a host
   * method the sidecar would have refused.
   */
  private async callHost(
    module: WidgetRuntimeModule,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (!module.WIDGET_HOST_METHODS.has(method)) {
      throw new Error(`host method not allowed from a widget: ${method}`);
    }
    return this.options.callHost(method, params ?? {});
  }
}
