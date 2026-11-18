import { useEffect } from "react";

import { pinnedPromptSelector, PINNED_PROMPT_ATTR } from "../../../../lib/pinned-prompt";

/**
 * Marks the one row that owns the top edge with `data-pinned-prompt`.
 *
 * A row cannot know it is the newest prompt by itself, and threading a flag
 * through the history wrappers would break their memo comparisons, so the
 * transcript writes the mark onto the rendered row instead. CSS does the rest:
 * the marked row is `position: sticky; top: 0`.
 *
 * The previous mark is cleared first, so a prompt that scrolled back out of the
 * slot never leaves two sticky rows stacked on the top edge.
 */
export function usePinnedPromptMarker(
  contentRef: { readonly current: HTMLElement | null },
  messageId: string | undefined,
): void {
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const marked = content.querySelectorAll<HTMLElement>(`[${PINNED_PROMPT_ATTR}]`);
    for (const row of marked) row.removeAttribute(PINNED_PROMPT_ATTR);
    if (!messageId) return;
    const row = content.querySelector<HTMLElement>(pinnedPromptSelector(messageId));
    row?.setAttribute(PINNED_PROMPT_ATTR, "true");
  }, [contentRef, messageId]);
}
