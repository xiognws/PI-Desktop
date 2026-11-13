/**
 * Widget packages, sidecar half (D699).
 *
 * The host discovers packages and owns trust; this process is the only place
 * package code ever runs. Everything here therefore assumes the code is
 * untrusted: it evaluates in this process (so a package can use Node), but every
 * host-side effect goes through an explicit, permission-checked bridge.
 *
 * Wire types come from `@pi-workspace/shared`; this module only adds the shape
 * the sidecar needs to hold a loaded package in memory.
 */
import type {
  WidgetAction,
  WidgetPermission,
  WidgetRuntimeState,
  WidgetSummary,
} from "@pi-workspace/shared";

/** What a package may ask the host to do (D699 §host bridge). */
export type WidgetHostCall = {
  /** Host-core RPC method, e.g. `memory.recall`. Refused without `host`. */
  method: string;
  params?: unknown;
  /** Set by the host when a package tried something it was not granted. */
  denied?: boolean;
};

/** The API object handed to each package entry as its only argument. */
export type WidgetApi = {
  /** Manifest identity, read-only. */
  readonly id: string;
  readonly version: string;
  /** Permissions actually in force; a package may narrow its own behaviour. */
  readonly permissions: readonly WidgetPermission[];
  /** True when this run was granted `permission`. */
  can(permission: WidgetPermission): boolean;
  /** Register the implementation of one manifest action. */
  action(name: string, handler: WidgetActionHandler): void;
  /** Log a line the user can find in the widget page's runtime panel. */
  log(message: string): void;
  /** Ask the host to run an RPC method. Requires `host`. */
  call(method: string, params?: unknown): Promise<unknown>;
  /** Absolute package directory; a `read`/`write` package works here. */
  readonly dir: string;
};

/** One registered action implementation. */
export type WidgetActionHandler = (input: WidgetActionInput) => unknown | Promise<unknown>;

export type WidgetActionInput = {
  /** Whatever the caller passed to `widget.invoke`. */
  args: unknown;
  /** Absolute package directory, so an action need not re-derive it. */
  dir: string;
  /** Ask the host for something; refused without `host`. */
  call(method: string, params?: unknown): Promise<unknown>;
  log(message: string): void;
};

/** A package as the runner holds it. */
export type LoadedWidget = {
  summary: WidgetSummary;
  actions: Map<string, WidgetActionHandler>;
  /** Manifest actions, for reporting an action the entry never implemented. */
  declared: WidgetAction[];
  state: WidgetRuntimeState["state"];
  error?: string;
  logs: string[];
};
