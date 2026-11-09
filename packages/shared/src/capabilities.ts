/**
 * Capability packages (D691).
 *
 * A capability package is a directory under `<userData>/capabilities/<id>/`
 * holding a `capability.json` manifest and one entry module. Unlike a plugin or
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
 * granted without the user saying so in the capability page.
 */
export type CapabilityPermission = "read" | "write" | "net" | "agent" | "host";

/** Every permission this build understands, in escalating order. */
export const CAPABILITY_PERMISSIONS: readonly CapabilityPermission[] = [
  "read",
  "write",
  "net",
  "agent",
  "host",
];

/** Permissions that grant nothing outside the package's own directory. */
export const CAPABILITY_SANDBOX_PERMISSIONS: readonly CapabilityPermission[] = ["read", "write"];

/** Which process a package may reach through the `host` permission. */
export type CapabilityAction = {
  /** Method name the caller passes to `capability.invoke`. */
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
export type CapabilityTrust = "untrusted" | "trusted" | "modified";

/** One package as the host reports it to the renderer. */
export type CapabilitySummary = {
  /** Manifest id; falls back to the directory name when the manifest is broken. */
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Directory name under `capabilities/` the package was read from. */
  dirName: string;
  /** Absolute package directory, shown so the user can find and edit it. */
  path: string;
  /** Permissions the manifest asks for. */
  requestedPermissions: CapabilityPermission[];
  /** Permissions actually in force after trust and duplicates were applied. */
  grantedPermissions: CapabilityPermission[];
  actions: CapabilityAction[];
  /** Enabled set, owned by the user; a disabled package is never loaded. */
  enabled: boolean;
  trust: CapabilityTrust;
  /** SHA-256 of the package directory contents, hex. */
  digest: string;
  /** Why the manifest could not be read, when it could not. The row still renders. */
  error?: string;
};

/** Live state of a loaded package inside the agent sidecar. */
export type CapabilityRuntimeState = {
  id: string;
  /** `loaded` means the entry module evaluated and registered its actions. */
  state: "loaded" | "error" | "skipped";
  actionNames: string[];
  /** Why the package is not loaded, when it is not. */
  error?: string;
};

/** One entry in a `capability.invoke` reply. */
export type CapabilityInvokeResult = {
  id: string;
  action: string;
  /** Whatever the action returned, JSON-serialised. */
  value: unknown;
  /** Milliseconds the action spent, measured in the sidecar. */
  durationMs: number;
};

/** Manifest schema this build understands. */
export const CAPABILITY_SCHEMA_VERSION = 1;
/** Runtime API a package entry is compiled against. */
export const CAPABILITY_API_VERSION = 1;
/** Manifest file name inside each package directory. */
export const CAPABILITY_MANIFEST_FILE = "capability.json";
/** Longest `capability.invoke` the sidecar will wait before failing the call. */
export const CAPABILITY_INVOKE_TIMEOUT_MS = 30_000;
/** Most packages the host will load from one data directory. */
export const MAX_CAPABILITY_PACKAGES = 64;

/**
 * Narrow a raw permission list to the ones this build implements, preserving
 * the manifest's order and dropping duplicates.
 */
export function normalizeCapabilityPermissions(
  raw: readonly string[] | undefined,
): CapabilityPermission[] {
  const seen = new Set<CapabilityPermission>();
  for (const entry of raw ?? []) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().toLowerCase();
    if ((CAPABILITY_PERMISSIONS as readonly string[]).includes(value)) {
      seen.add(value as CapabilityPermission);
    }
  }
  return CAPABILITY_PERMISSIONS.filter((permission) => seen.has(permission));
}

/** The permissions a package keeps when the user has not trusted its digest. */
export function sandboxCapabilityPermissions(
  requested: readonly CapabilityPermission[],
): CapabilityPermission[] {
  return requested.filter((permission) =>
    (CAPABILITY_SANDBOX_PERMISSIONS as readonly string[]).includes(permission),
  );
}

/** True when `permission` is in force for `summary`. */
export function hasCapabilityPermission(
  summary: Pick<CapabilitySummary, "grantedPermissions" | "enabled" | "trust">,
  permission: CapabilityPermission,
): boolean {
  if (!summary.enabled || summary.trust === "modified") return false;
  return summary.grantedPermissions.includes(permission);
}
