/**
 * Widget packages (D699).
 *
 * A widget package is a directory under `<userData>/widgets/<id>/`
 * holding a `widget.json` manifest and one entry module. Unlike a plugin or
 * a trusted extension, a package is not compiled into the application image and
 * is not declared by some other package: the user drops a folder in, the host
 * scans it at start-up, and the agent sidecar loads it.
 *
 * The host owns discovery and trust (read the manifest, hash the directory,
 * remember whether the user trusted it, persist the enabled set). The sidecar
 * owns execution: it is the only process that ever evaluates package code, so a
 * package crash cannot take the window down.
 *
 * Wire shape only — no node imports, because the renderer imports this too.
 */

/**
 * What a package is allowed to touch. Declared in the manifest and narrowed by
 * the host: a package that asks for nothing gets nothing, and `host` is never
 * granted without the user saying so in the widget page.
 */
export type WidgetPermission = "read" | "write" | "net" | "agent" | "host";

/** Every permission this build understands, in escalating order. */
export const WIDGET_PERMISSIONS: readonly WidgetPermission[] = [
  "read",
  "write",
  "net",
  "agent",
  "host",
];

/** Permissions that grant nothing outside the package's own directory. */
export const WIDGET_SANDBOX_PERMISSIONS: readonly WidgetPermission[] = ["read", "write"];

/** Which process a package may reach through the `host` permission. */
export type WidgetAction = {
  /** Method name the caller passes to `widget.invoke`. */
  name: string;
  description: string;
  /** Argument names, for the UI and for the agent tool schema. */
  params?: string[];
};

/**
 * Trust state of one package on disk.
 *
 * `modified` means the bytes changed after the user trusted them: the package
 * still loads, but with its permissions cut to the sandbox floor until the user
 * acknowledges the new digest.
 */
export type WidgetTrust = "untrusted" | "trusted" | "modified";

/** One package as the host reports it to the renderer. */
export type WidgetSummary = {
  /** Manifest id; falls back to the directory name when the manifest is broken. */
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Directory name under `widgets/` the package was read from. */
  dirName: string;
  /** Absolute package directory, shown so the user can find and edit it. */
  path: string;
  /** Permissions the manifest asks for. */
  requestedPermissions: WidgetPermission[];
  /** Permissions actually in force after trust and duplicates were applied. */
  grantedPermissions: WidgetPermission[];
  actions: WidgetAction[];
  /** Enabled set, owned by the user; a disabled package is never loaded. */
  enabled: boolean;
  trust: WidgetTrust;
  /** SHA-256 of the package directory contents, hex. */
  digest: string;
  /** Why the manifest could not be read, when it could not. The row still renders. */
  error?: string;
};

/** Live state of a loaded package inside the agent sidecar. */
export type WidgetRuntimeState = {
  id: string;
  /** `loaded` means the entry module evaluated and registered its actions. */
  state: "loaded" | "error" | "skipped";
  actionNames: string[];
  /** Why the package is not loaded, when it is not. */
  error?: string;
};

/** One entry in a `widget.invoke` reply. */
export type WidgetInvokeResult = {
  id: string;
  action: string;
  /** Whatever the action returned, JSON-serialised. */
  value: unknown;
  /** Milliseconds the action spent, measured in the sidecar. */
  durationMs: number;
};

/** Manifest schema this build understands. */
export const WIDGET_SCHEMA_VERSION = 1;
/**
 * Newest runtime API a package entry may be compiled against.
 *
 * `apiVersion` is a **range**, not an equality: a build accepts anything from
 * `WIDGET_API_VERSION_MIN` up to this value. Raising it therefore adds a
 * capability without stranding every package already installed, which is what
 * an equality check would do.
 *
 * v2 added `runtime` — a package may name a non-JavaScript entry kind.
 */
export const WIDGET_API_VERSION = 2;
/** Oldest runtime API this build still runs (ADR: python-widget-entry-kind). */
export const WIDGET_API_VERSION_MIN = 1;
/** Manifest file name inside each package directory. */
export const WIDGET_MANIFEST_FILE = "widget.json";
/** Longest `widget.invoke` the sidecar will wait before failing the call. */
export const WIDGET_INVOKE_TIMEOUT_MS = 30_000;
/** Most packages the host will load from one data directory. */
export const MAX_WIDGET_PACKAGES = 64;

/**
 * What a package's entry is written in.
 *
 * `javascript` is the original contract and stays the default when a manifest
 * says nothing, so every v1 package keeps loading. `python` runs the entry in a
 * child process instead of evaluating it in the sidecar.
 */
export type WidgetRuntimeKind = "javascript" | "python";

/** The entry declaration a v2 manifest may carry under `runtime`. */
export type WidgetRuntime = {
  kind: WidgetRuntimeKind;
  /** Entry file, relative to the package directory. Must end in `.py` for python. */
  entry: string;
  /**
   * Package-relative directories put on `PYTHONPATH` ahead of the shared bundle.
   * Only meaningful for `python`.
   */
  pythonPath?: string[];
};

/** Every runtime kind this build understands, in escalation order. */
export const WIDGET_RUNTIME_KINDS: readonly WidgetRuntimeKind[] = ["javascript", "python"];

/**
 * True when this build can run a manifest claiming `version`.
 *
 * An unknown-in-the-future version is rejected, an old one is accepted: a
 * package written for v1 must keep working after the product moves to v2.
 */
export function isSupportedWidgetApiVersion(version: unknown): boolean {
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= WIDGET_API_VERSION_MIN &&
    version <= WIDGET_API_VERSION
  );
}

/**
 * Read `runtime` out of a raw manifest value.
 *
 * Absence means JavaScript, which is what every package written before v2 says
 * by saying nothing. A malformed value is `null` so the caller can report it on
 * the package's row instead of quietly downgrading the package to some other
 * language.
 */
export function readWidgetRuntime(raw: unknown): WidgetRuntime | null {
  if (raw === undefined || raw === null) return { kind: "javascript", entry: "" };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as { kind?: unknown; entry?: unknown; pythonPath?: unknown };
  const kind = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "javascript";
  if (!(WIDGET_RUNTIME_KINDS as readonly string[]).includes(kind)) return null;
  const entry = typeof value.entry === "string" ? value.entry.trim() : "";
  const pythonPath = Array.isArray(value.pythonPath)
    ? value.pythonPath
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : undefined;
  return { kind: kind as WidgetRuntimeKind, entry, pythonPath };
}

/**
 * Narrow a raw permission list to the ones this build implements, preserving
 * the manifest's order and dropping duplicates.
 */
export function normalizeWidgetPermissions(
  raw: readonly string[] | undefined,
): WidgetPermission[] {
  const seen = new Set<WidgetPermission>();
  for (const entry of raw ?? []) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().toLowerCase();
    if ((WIDGET_PERMISSIONS as readonly string[]).includes(value)) {
      seen.add(value as WidgetPermission);
    }
  }
  return WIDGET_PERMISSIONS.filter((permission) => seen.has(permission));
}

/** The permissions a package keeps when the user has not trusted its digest. */
export function sandboxWidgetPermissions(
  requested: readonly WidgetPermission[],
): WidgetPermission[] {
  return requested.filter((permission) =>
    (WIDGET_SANDBOX_PERMISSIONS as readonly string[]).includes(permission),
  );
}

/** True when `permission` is in force for `summary`. */
export function hasWidgetPermission(
  summary: Pick<WidgetSummary, "grantedPermissions" | "enabled" | "trust">,
  permission: WidgetPermission,
): boolean {
  if (!summary.enabled || summary.trust === "modified") return false;
  return summary.grantedPermissions.includes(permission);
}
