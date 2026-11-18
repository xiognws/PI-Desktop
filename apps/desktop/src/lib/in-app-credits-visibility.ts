/**
 * The one "should the credit chip exist" decision.
 *
 * Kept free of React and transport so Main's tests and every renderer surface
 * can call the same function: the composer chip, its popover, the model-picker
 * group header and the settings card must not answer it differently.
 */

export type CreditsFailureReason =
  | "hard_credit"
  | "session_dead"
  | "signed_out"
  | "unavailable"
  | "no_credits_path"
  | "not_running";

/**
 * The chip exists only for a metered account with credit left.
 *
 * No credit surface, an unmetered plan (`free`), a failed read and a zero or
 * unknown balance all hide it — and a hidden chip takes no layout space. The
 * settings card still explains every one of those states, which is how a user
 * finds out why it is absent.
 */
export function creditsVisibility(input: {
  hasCreditsPath: boolean;
  free?: boolean;
  total?: number | null;
  reason?: CreditsFailureReason;
}): "show" | "hide" {
  if (!input.hasCreditsPath) return "hide";
  if (input.reason !== undefined) return "hide";
  if (input.free === true) return "hide";
  const total = input.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return "hide";
  return "show";
}

/** How often a balance is re-read while an in-app model is in use. */
export const CREDITS_POLL_INTERVAL_MS = 5_000;

/** The minimum an in-app surface has to say for the polling decision. */
export type InAppPollSurface = { providerId: string | null };

/**
 * Whether a balance should be polled right now.
 *
 * One rule, and it is the user's own situation: the model selected for this
 * session (or for the draft) is served by an in-app gateway. A balance nobody is
 * spending is read once per cache window instead of every five seconds.
 */
export function shouldPollCredits(
  surfaces: readonly InAppPollSurface[],
  providerId: string | undefined,
): boolean {
  if (typeof providerId !== "string" || providerId === "") return false;
  return surfaces.some((surface) => surface.providerId === providerId);
}
