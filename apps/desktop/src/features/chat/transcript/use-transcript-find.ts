import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { stepFindIndex } from "@pi-desktop/shared";

import { useTranscriptFindRequest } from "../../../lib/transcript-find-request";
import { transcriptSearchRanges } from "../../../lib/transcript-search-highlight";

/** Every match in the open conversation. */
const ALL_HIGHLIGHT = "transcript-find";
/** The one the bar is standing on. */
const ACTIVE_HIGHLIGHT = "transcript-find-active";

export type TranscriptFindState = {
  open: boolean;
  query: string;
  index: number;
  total: number;
  setQuery: (value: string) => void;
  step: (delta: number) => void;
  close: () => void;
};

/**
 * Find inside the rendered conversation.
 *
 * The matches are the transcript's own text nodes, so the scan runs against the
 * DOM the reader is looking at rather than against message payloads: collapsed
 * output stays unmatched, exactly as it stays unread. Only two highlights are
 * painted — the whole set and the active one — which keeps a large result set
 * from stamping classes onto React-owned rows.
 */
export function useTranscriptFind(content: RefObject<HTMLElement | null>): TranscriptFindState {
  const request = useTranscriptFindRequest();
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [index, setIndex] = useState(-1);
  const [total, setTotal] = useState(0);
  const ranges = useRef<Range[]>([]);

  const clearHighlights = useCallback(() => {
    if (typeof Highlight === "undefined" || !CSS.highlights) return;
    CSS.highlights.delete(ALL_HIGHLIGHT);
    CSS.highlights.delete(ACTIVE_HIGHLIGHT);
  }, []);

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
    range.startContainer.parentElement?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [clearHighlights]);

  // The shell owns the keystroke; the transcript owns the text. A request is
  // therefore just "open it", and an already-open bar keeps its place.
  useEffect(() => {
    if (request > 0) setOpen(true);
  }, [request]);

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
    const found = transcriptSearchRanges(root, query);
    ranges.current = found;
    setTotal(found.length);
    setIndex(found.length ? 0 : -1);
    paint(0);
  }, [clearHighlights, content, open, paint, query]);

  const setQuery = useCallback((value: string) => setQueryState(value), []);

  const step = useCallback(
    (delta: number) => {
      setIndex((current) => {
        const next = stepFindIndex(current, ranges.current.length, delta);
        paint(next);
        return next;
      });
    },
    [paint],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQueryState("");
    clearHighlights();
  }, [clearHighlights]);

  return { open, query, index, total, setQuery, step, close };
}
