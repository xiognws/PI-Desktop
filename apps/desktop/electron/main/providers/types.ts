/**
 * In-app providers.
 *
 * An in-app provider is a model provider whose gateway is **part of the
 * application image**: the app owns the loopback process, the loopback port,
 * the credential it hands the gateway, and the provider row the runtime talks
 * to. It is the shape WorkBuddy needs — a local OpenAI-compatible bridge that
 * reads the desktop client's own login — without making the bridge a plugin.
 *
 * Adding a second one is one descriptor file plus one entry in
 * {@link IN_APP_PROVIDERS}; the supervisor, the settings surface, the credit
 * read and the model picker are all driven by these fields.
 */
import { workbuddyProvider } from "./workbuddy/index.ts";

export type InAppProvider = {
  /** Stable id. Also the provider row's reserved vendor key: `builtin:<id>`. */
  id: string;
  /** User-facing name of the provider row this gateway backs. */
  label: string;
  /** Loopback port used when the user has not chosen one. */
  defaultPort: number;
  /** Unauthenticated readiness probe, relative to `http://127.0.0.1:<port>`. */
  healthPath: string;
  /** OpenAI-compatible base path, relative to `http://127.0.0.1:<port>`. */
  openaiBasePath: string;
  /**
   * Bridge product id the gateway serves. A gateway can serve several; the
   * one named here is the only one this provider row points at.
   */
  product: string;
  /**
   * Remaining-credit route, relative to `http://127.0.0.1:<port>`. Absent
   * means the provider has no credit surface: the settings card, the composer
   * chip and the model-picker header all hide it.
   */
  creditsPath?: string;
};

/**
 * Vendor key prefix reserved for provider rows the app itself owns.
 *
 * `owner_plugin_id` is not usable for these rows: host-core deletes rows whose
 * owner is not a registered plugin on every startup, and `providers.update`
 * refuses owned rows — both correct for plugin declarations, both fatal for a
 * row the app must keep current. The vendor key is the app's own namespace
 * instead, and it is stable across releases because it is also how the row is
 * found again on the next boot.
 */
export const IN_APP_PROVIDER_VENDOR_PREFIX = "builtin:";

export function inAppProviderVendorKey(id: string): string {
  return `${IN_APP_PROVIDER_VENDOR_PREFIX}${id}`;
}

/** Descriptor id named by a stored vendor key, or null for any other row. */
export function inAppProviderIdFromVendorKey(vendorKey: string | undefined | null): string | null {
  if (typeof vendorKey !== "string") return null;
  if (!vendorKey.startsWith(IN_APP_PROVIDER_VENDOR_PREFIX)) return null;
  const id = vendorKey.slice(IN_APP_PROVIDER_VENDOR_PREFIX.length);
  return id === "" ? null : id;
}

/** Every in-app provider this build ships. */
export const IN_APP_PROVIDERS: readonly InAppProvider[] = [workbuddyProvider];

export function findInAppProvider(
  id: string,
  providers: readonly InAppProvider[] = IN_APP_PROVIDERS,
): InAppProvider | undefined {
  return providers.find((provider) => provider.id === id);
}
