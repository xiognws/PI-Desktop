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
  const wasVisible = useRef(visible);
  // The explicit latest intent survives an immediate pane hide or eviction.
  // Reader input cancels without committing; it keeps the prepared history view.
  useLayoutEffect(() => {
    // Hiding the pane keeps the latest intent alive through an immediate
    // re-show, but a trip still in flight must stop owning the viewport: its
    // frames measure a hidden box, and the reveal has to be free to bottom.
    // The intent it was carrying stays parked, so the newest turn is still
    // committed when the reader comes back.
    if (!visible) navigation.landed();
  }, [navigation, visible]);
  // A revealed pane may still be in an intermediate layout — a search target
  // painted, the tail not measured yet. Settling before the first frame carries
  // a parked intent out at once instead of animating the reader through a view
  // they never asked for. Only the transition into a reveal settles; a pane
  // that was already visible leaves an interrupted animation with its owner.
  useLayoutEffect(() => {
    if (visible && !wasVisible.current) navigation.settle();
  }, [navigation, visible]);
  // Recorded after the two effects above so they compare against the previous
  // render's visibility rather than the one being committed.
  useLayoutEffect(() => {
    wasVisible.current = visible;
  }, [visible]);
  useEffect(() => () => navigation.cancel(true), [navigation]);
  return navigation;
}
