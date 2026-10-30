import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { stepFindIndex } from "@pi-desktop/shared";

import { useTranscriptFindRequest } from "../../../lib/transcript-find-request";
import { transcriptSearchRanges } from "../../../lib/transcript-search-highlight";

/** Every match in the open conversation. */
const ALL_HIGHLIGHT = "transcript-find";
/** The one the bar is standing on. */
const ACTIVE_HIGHLIGHT = "transcript-find-active";
/**
 * Rows carry `content-visibility: auto`, so a row outside the viewport has no
 * box: a match inside it cannot be measured, let alone scrolled to, until the
 * row is allowed to lay out.
 */
const TARGET_CLASS = "transcript-find-target";

export type TranscriptFindState = {
  open: boolean;
  query: string;
  /** Compare as written instead of the default case-insensitive scan. */
  matchCase: boolean;
  index: number;
  total: number;
  setQuery: (value: string) => void;
  setMatchCase: (value: boolean) => void;
  step: (delta: number) => void;
  close: () => void;
};

/**
 * Find inside the rendered conversation.
 *
 * The matches are the transcript's own text nodes, so the scan runs against the
 * DOM the reader is looking at rather than against message payloads: collapsed
 * output stays unmatched, exactly as it stays unread.
 *
 * Stepping has to do the scrolling itself — `scrollIntoView` is useless here
 * twice over: the target row is paint-contained until it is marked, and
 * pinned-follow would drag the transcript back to the bottom on the next tick.
 */
export function useTranscriptFind(
  content: RefObject<HTMLElement | null>,
  scroller: RefObject<HTMLElement | null>,
  releaseFollow?: () => void,
): TranscriptFindState {
  const request = useTranscriptFindRequest();
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [index, setIndex] = useState(-1);
  const [total, setTotal] = useState(0);
  const ranges = useRef<Range[]>([]);
  const markedRow = useRef<HTMLElement | null>(null);

  const unmarkRow = useCallback(() => {
    markedRow.current?.classList.remove(TARGET_CLASS);
    markedRow.current = null;
  }, []);

  const clearHighlights = useCallback(() => {
    if (typeof Highlight === "undefined" || !CSS.highlights) return;
    CSS.highlights.delete(ALL_HIGHLIGHT);
    CSS.highlights.delete(ACTIVE_HIGHLIGHT);
    unmarkRow();
  }, [unmarkRow]);

  const paint = useCallback((active: number) => {
    if (typeof Highlight === "undefined" || !CSS.highlights) return;
    if (ranges.current.length === 0) {
      clearHighlights();
      return;
    }
    CSS.highlights.set(ALL_HIGHLIGHT, new Highlight(...ranges.current));
    const range = ranges.current[active];
    if (!range) {
      CSS.highlights.delete(ACTIVE_HIGHLIGHT);
      return;
    }
    CSS.highlights.set(ACTIVE_HIGHLIGHT, new Highlight(range));
  }, [clearHighlights]);

  /** Put the active match into view, about a third down the scrollport. */
  const reveal = useCallback(
    (active: number) => {
      const range = ranges.current[active];
      const box = scroller.current;
      const node = range?.startContainer.parentElement;
      if (!range || !box || !node) return;
      const row = node.closest<HTMLElement>(".message-row") ?? node;
      if (markedRow.current && markedRow.current !== row) unmarkRow();
      row.classList.add(TARGET_CLASS);
      markedRow.current = row;
      // Marking the row lifts paint containment, so this measurement returns the
      // row's real box instead of an empty one.
      const rect = range.getBoundingClientRect();
      const measure = rect.height > 0 ? rect : row.getBoundingClientRect();
      if (measure.height === 0 && measure.width === 0) return;
      const viewport = box.getBoundingClientRect();
      box.scrollTop += measure.top - viewport.top - Math.min(160, box.clientHeight / 3);
    },
    [scroller, unmarkRow],
  );

  // The shell owns the keystroke; the transcript owns the text. A request is
  // therefore just "open it", and an already-open bar keeps its place.
  useEffect(() => {
    if (request > 0) {
      releaseFollow?.();
      setOpen(true);
    }
  }, [releaseFollow, request]);

  useEffect(() => {
    if (!open) {
      ranges.current = [];
      setTotal(0);
      setIndex(-1);
      clearHighlights();
      return;
    }
    const root = content.current;
    if (!root || query.trim() === "") {
      ranges.current = [];
      setTotal(0);
      setIndex(-1);
      clearHighlights();
      return;
    }
    const found = transcriptSearchRanges(root, query, { matchCase });
    ranges.current = found;
    setTotal(found.length);
    setIndex(found.length ? 0 : -1);
    paint(0);
    if (found.length) reveal(0);
  }, [clearHighlights, content, matchCase, open, paint, query, reveal]);

  // Stepping paints and reveals from an effect rather than inside the state
  // updater: an updater runs before the browser has laid the new row out.
  useEffect(() => {
    if (!open || index < 0) return;
    paint(index);
    reveal(index);
  }, [index, open, paint, reveal]);

  const setQuery = useCallback((value: string) => setQueryState(value), []);

  const step = useCallback(
    (delta: number) => {
      // Stepping is the reader taking over: pinned-follow must let go first.
      releaseFollow?.();
      setIndex((current) => stepFindIndex(current, ranges.current.length, delta));
    },
    [releaseFollow],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQueryState("");
    clearHighlights();
  }, [clearHighlights]);

  return { open, query, matchCase, index, total, setQuery, setMatchCase, step, close };
}
