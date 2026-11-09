/**
 * Capability packages, sidecar half (D691).
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
  CapabilityAction,
  CapabilityPermission,
  CapabilityRuntimeState,
  CapabilitySummary,
} from "@pi-workspace/shared";

/** What a package may ask the host to do (D691 §host bridge). */
export type CapabilityHostCall = {
  /** Host-core RPC method, e.g. `memory.recall`. Refused without `host`. */
  method: string;
  params?: unknown;
  /** Set by the host when a package tried something it was not granted. */
  denied?: boolean;
};

/** The API object handed to each package entry as its only argument. */
export type CapabilityApi = {
  /** Manifest identity, read-only. */
  readonly id: string;
  readonly version: string;
  /** Permissions actually in force; a package may narrow its own behaviour. */
  readonly permissions: readonly CapabilityPermission[];
  /** True when this run was granted `permission`. */
  can(permission: CapabilityPermission): boolean;
  /** Register the implementation of one manifest action. */
  action(name: string, handler: CapabilityActionHandler): void;
  /** Log a line the user can find in the capability page's runtime panel. */
  log(message: string): void;
  /** Ask the host to run an RPC method. Requires `host`. */
  call(method: string, params?: unknown): Promise<unknown>;
  /** Absolute package directory; a `read`/`write` package works here. */
  readonly dir: string;
};

/** One registered action implementation. */
export type CapabilityActionHandler = (input: CapabilityActionInput) => unknown | Promise<unknown>;

export type CapabilityActionInput = {
  /** Whatever the caller passed to `capability.invoke`. */
  args: unknown;
  /** Absolute package directory, so an action need not re-derive it. */
  dir: string;
  /** Ask the host for something; refused without `host`. */
  call(method: string, params?: unknown): Promise<unknown>;
  log(message: string): void;
};

/** A package as the runner holds it. */
export type LoadedCapability = {
  summary: CapabilitySummary;
  actions: Map<string, CapabilityActionHandler>;
  /** Manifest actions, for reporting an action the entry never implemented. */
  declared: CapabilityAction[];
  state: CapabilityRuntimeState["state"];
  error?: string;
  logs: string[];
};
