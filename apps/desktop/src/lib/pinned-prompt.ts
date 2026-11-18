import type { UiMessage } from "@pi-workspace/shared";

/** Longest preview the pinned strip renders; the full prompt stays in the bubble. */
export const PINNED_PROMPT_PREVIEW_CHARS = 240;

/**
 * The prompt the user most recently sent — the one a pinned strip repeats.
 *
 * Agent-to-agent deliveries also arrive on the `user` role, but they are not
 * the human speaking, so a row carrying `sessionMessage` provenance is skipped.
 */
export function latestUserPrompt(messages: readonly UiMessage[]): UiMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && !message.sessionMessage) return message;
  }
  return undefined;
}

/**
 * One-line preview of a prompt: whitespace collapsed, bounded in length.
 *
 * The strip is a reminder of what was asked, not a second copy of it, so the
 * original line breaks and markdown are flattened instead of re-rendered.
 */
export function pinnedPromptPreview(
  message: UiMessage | undefined,
  limit = PINNED_PROMPT_PREVIEW_CHARS,
): string {
  const collapsed = (message?.content ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  // Cut on a word boundary when one is near the limit, so the preview does not
  // end mid-word; fall back to a hard cut for unspaced scripts.
  const cut = collapsed.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  const head = boundary > limit - 24 ? cut.slice(0, boundary) : cut;
  return `${head.trimEnd()}…`;
}

/**
 * Attribute selector for a message row, escaped without depending on
 * `CSS.escape` (the static renderer has no `CSS` object).
 */
export function pinnedPromptSelector(messageId: string): string {
  return `[data-message-id="${messageId.replace(/["\\]/g, "\\$&")}"]`;
}

/**
 * Marks the row that owns the top edge. The transcript writes it, CSS reads it;
 * it is an attribute rather than a prop because the history wrappers memoize on
 * their props and a per-row flag would defeat those comparisons.
 */
export const PINNED_PROMPT_ATTR = "data-pinned-prompt";

/**
 * True when a row's top edge has reached the top of the scrollport, which is
 * when the row sticks instead of scrolling away: from that offset the row is
 * pinned to the top edge until a newer prompt takes the slot from it.
 *
 * The `+1` at the call site absorbs the sub-pixel gap a scaled display leaves.
 */
export function isPinnedPromptAtTop(rowTop: number, viewportTop: number): boolean {
  return rowTop <= viewportTop;
}
