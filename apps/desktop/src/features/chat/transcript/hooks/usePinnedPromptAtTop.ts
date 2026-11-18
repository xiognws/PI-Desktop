import { useEffect, useState } from "react";

import { isPinnedPromptAtTop, pinnedPromptSelector } from "../../../../lib/pinned-prompt";

/**
 * Whether the pinned prompt's row has reached the top of the transcript.
 *
 * The row itself is the anchor: it scrolls normally until its top edge meets the
 * scrollport's top edge, and from that offset the row sticks there instead of
 * scrolling away, so the user keeps reading what they last asked while the
 * answer grows beneath it. Measurement rides the scroller's own scroll events,
 * coalesced into one frame, because the row's position changes with streaming
 * layout too.
 */
export function usePinnedPromptAtTop({
  scrollRef,
  contentRef,
  messageId,
  enabled = true,
}: {
  scrollRef: { readonly current: HTMLElement | null };
  contentRef: { readonly current: HTMLElement | null };
  messageId: string | undefined;
  enabled?: boolean;
}): boolean {
  const [atTop, setAtTop] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!enabled || !messageId || !scroller || !content) {
      setAtTop(false);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const row = content.querySelector<HTMLElement>(pinnedPromptSelector(messageId));
      if (!row) {
        setAtTop(false);
        return;
      }
      // +1 absorbs the sub-pixel gap a scaled display can leave at the edge.
      const next = isPinnedPromptAtTop(
        row.getBoundingClientRect().top,
        scroller.getBoundingClientRect().top + 1,
      );
      setAtTop((current) => (current === next ? current : next));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [contentRef, enabled, messageId, scrollRef]);

  return atTop;
}
