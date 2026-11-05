/**
 * Credential patterns, and the scrub that uses them.
 *
 * Two directions, one vocabulary. `security.redact_secrets` governs what is written
 * to local logs; this module is the other direction — text on its way *out* of the
 * process: to a model provider, or into storage that is replayed into a prompt on
 * every later turn. A key that reaches memory is re-sent forever, so that path holds
 * regardless of the log setting and fails closed.
 *
 * The patterns are the ones the log redactor already used, moved here so there is one
 * definition of what a credential looks like rather than two that drift.
 */

/** Key *names* whose value is sensitive, for callers redacting structured data. */
export const SECRET_KEY_RE =
  /token|secret|password|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret/i;
/** Well-known credential shapes, independent of any surrounding label. */
export const SECRET_VALUE_RE =
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b|\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza|ya29\.)[A-Za-z0-9._-]{8,}\b/g;
/** `token=…` / `api_key: …` / `password = …` and friends. */
export const SECRET_ASSIGNMENT_RE =
  /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|api[_-]?key|apikey|authorization|proxy-authorization|cookie|set-cookie|credential|private[_-]?key|client[_-]?secret)\s*[:=]\s*)[^\s,;&}"']+/gi;
/** `Bearer …` / `Basic …`. */
export const BEARER_RE = /\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi;
/** `https://user:password@host` — the credential travels inside the URL. */
export const URL_CREDENTIAL_RE = /(https?:\/\/)[^/\s:@]+:[^@\s]+@/gi;

export const REDACTED_MARKER = "***REDACTED***";

/** A token long enough to be a credential, used for the batch propagation below. */
const TOKEN_RE = /[A-Za-z0-9_\-./+]{16,}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mask credentials in one string. Order matters: the URL form owns its own `@`. */
export function scrubSecrets(text: string): string {
  return String(text)
    .replace(URL_CREDENTIAL_RE, "$1***:***@")
    .replace(BEARER_RE, (match) => `${match.split(/\s+/, 1)[0]} ${REDACTED_MARKER}`)
    .replace(SECRET_ASSIGNMENT_RE, `$1${REDACTED_MARKER}`)
    .replace(SECRET_VALUE_RE, REDACTED_MARKER);
}

/**
 * Scrub a batch, and mask a token that was caught anywhere in it *everywhere* in it.
 *
 * The model often states a credential once with its label and then repeats it bare in
 * prose or in the next entry; masking only the labelled occurrence leaves the value in
 * the store, which is the whole thing this is for.
 */
export function scrubSecretsInBatch(texts: readonly string[]): string[] {
  const masked = texts.map(scrubSecrets);
  const learned = new Set<string>();
  texts.forEach((text, index) => {
    if (masked[index] === text) return;
    for (const token of text.match(TOKEN_RE) ?? []) {
      if (!masked[index].includes(token)) learned.add(token);
    }
  });
  if (learned.size === 0) return masked;
  const pattern = new RegExp(
    [...learned].sort((left, right) => right.length - left.length).map(escapeRegExp).join("|"),
    "g",
  );
  return masked.map((text) => text.replace(pattern, REDACTED_MARKER));
}
