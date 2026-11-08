import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createTranscriptLatestNavigation } from "../../../../lib/transcript-latest-navigation";

export function useTranscriptLatestNavigation({ scrollRef, visible, onPosition }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
  onPosition: (top: number) => void;
}) {
  const position = useRef(onPosition);
  position.current = onPosition;
  const [navigation] = useState(() => createTranscriptLatestNavigation({
    geometry: () => scrollRef.current ?? undefined,
    move: top => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      scroller.scrollTo({ top, behavior: "instant" });
      position.current(scroller.scrollTop);
    },
    request: frame => requestAnimationFrame(frame),
    cancel: frame => cancelAnimationFrame(frame),
    now: () => performance.now(),
    reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  // The explicit latest intent survives an immediate pane hide or eviction.
  // Reader input cancels without committing; it keeps the prepared history view.
  useLayoutEffect(() => {
    // Hiding the pane keeps the latest intent alive through an immediate
    // re-show, but a trip still in flight must stop owning the viewport: its
    // frames measure a hidden box, and the reveal has to be free to bottom.
    if (!visible) navigation.landed();
  }, [navigation, visible]);
  useEffect(() => () => navigation.cancel(true), [navigation]);
  return navigation;
}
