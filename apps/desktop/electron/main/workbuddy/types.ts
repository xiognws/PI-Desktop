/**
 * Shapes exchanged by the WorkBuddy model entry.
 *
 * WorkBuddy (Tencent CodeBuddy desktop) is an optional local integration: the
 * app ships it as one entry in the model list, and nothing here is required for
 * a machine that does not have WorkBuddy installed. Everything in this module is
 * structural — no credential ever crosses this boundary.
 */

/** One model the local WorkBuddy account can chat with. */
export type WorkBuddyModel = {
  id: string;
  name: string;
  /** Input capacity in tokens, as the desktop catalog states it. */
  contextWindow?: number;
  /** Output capacity in tokens, as the desktop catalog states it. */
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  /** Localized one-liner from the catalog; display only. */
  description?: string;
  /** Credit multiplier; `0` means the model is free. */
  credits?: number | null;
  /** The account's own default model, so the entry opens on something usable. */
  isDefault?: boolean;
};

/** What the desktop install says about itself. Never carries a token. */
export type WorkBuddyInstallation = {
  /** An install directory, app data directory, or auth store was found. */
  installed: boolean;
  /** The stored session is unexpired and names an account. */
  loggedIn: boolean;
  /** Non-secret account identity, used to label the entry. */
  account?: {
    uid?: string;
    enterpriseId?: string;
    enterpriseName?: string;
    accountType?: string;
  };
  /** Session expiry in epoch milliseconds, when the store states one. */
  expiresAt?: number;
  /** Where the answer came from, relative to the user's home or app data. */
  sources: string[];
  /** Why `loggedIn` is false, when it is. Diagnosable without secrets. */
  detail?: string;
};

/** Result of one local discovery pass. */
export type WorkBuddyDiscovery = {
  installation: WorkBuddyInstallation;
  models: WorkBuddyModel[];
};

/**
 * What the model entry currently offers.
 *
 * - `unavailable`: WorkBuddy is not installed here, so the entry is not created.
 * - `ready`: an endpoint answers and a credential is in place.
 * - `needs-credential`: the entry exists and lists models, but the stored key
 *   has not been supplied yet (or the upstream rejected it).
 */
export type WorkBuddyEntryState = "unavailable" | "ready" | "needs-credential";

export type WorkBuddyStatus = {
  state: WorkBuddyEntryState;
  /** Provider row id once registered. */
  providerId?: string;
  /** Loopback base URL of the gateway the entry points at. */
  baseUrl?: string;
  modelCount: number;
  /** `gateway` reuses a gateway that was already running; `bridge` is ours. */
  endpoint: "gateway" | "bridge" | "none";
  installation: WorkBuddyInstallation;
  /** Human-readable reason, safe to log (never carries a token). */
  detail?: string;
};
