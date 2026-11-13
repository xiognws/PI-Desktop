/**
 * The skill catalog shows 60 characters of a description and the host refuses
 * anything longer, because that index is sent on every turn. A marketplace
 * document is third-party text, so its description routinely runs longer than
 * the library will accept - and the install used to die on the refusal with the
 * document already fetched.
 *
 * Shorten it to a catalog line here instead: the first sentence that fits, or a
 * word-boundary cut with an ellipsis. The caller reports what happened; a silent
 * truncation would leave a skill whose description no longer matches its source.
 */

export const CATALOG_DESCRIPTION_CHARS = 60;

export interface CatalogLine {
  text: string;
  shortened: boolean;
}

/** Collapse runs of whitespace so a wrapped frontmatter line still reads as one sentence. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cut at the last word boundary that still fits, then close with a single ellipsis. */
function cutAtWordBoundary(text: string, limit: number): string {
  const slice = text.slice(0, limit - 1);
  const boundary = slice.lastIndexOf(" ");
  // A single very long token has no boundary; keep the hard cut rather than the whole prefix.
  const body = boundary > limit * 0.5 ? slice.slice(0, boundary) : slice;
  return `${body.trimEnd()}…`;
}

/**
 * The line a skill's description can occupy in the catalog.
 *
 * A CJK description has no spaces to cut on, so the boundary rule falls back to
 * a hard cut - still inside the limit, still marked as shortened.
 */
export function catalogLine(input: string, limit = CATALOG_DESCRIPTION_CHARS): CatalogLine {
  const text = normalise(input ?? "");
  if (text.length <= limit) return { text, shortened: false };

  const sentence = /^(.+?[.!?。！？])(?:\s|$)/.exec(text);
  const first = sentence?.[1]?.trim();
  if (first && first.length <= limit) return { text: first, shortened: true };

  return { text: cutAtWordBoundary(text, limit), shortened: true };
}
