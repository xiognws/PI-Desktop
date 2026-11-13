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
