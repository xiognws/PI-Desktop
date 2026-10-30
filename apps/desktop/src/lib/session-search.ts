import type { SessionSearchPage } from "@pi-desktop/shared";

/** Match the host's Unicode lowercase literal search. */
export function foldSearchText(text: string): string {
  return text.toLowerCase();
}

export type SearchMatchOptions = {
  /**
   * Compare the text as written. Off is the host's own behaviour (Unicode
   * lowercase literal search), and the find bar turns it on for the reader who
   * is looking for an identifier rather than prose.
   */
  matchCase?: boolean;
};

export function searchMatchRanges(
  text: string,
  query: string,
  options: SearchMatchOptions = {},
): [number, number][] {
  const raw = query.trim();
  if (!raw) return [];
  if (options.matchCase) {
    // Same scan as below without folding: offsets stay 1:1 with the text, so
    // the mapping tables are not needed.
    const ranges: [number, number][] = [];
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(raw, from);
      if (index < 0) break;
      ranges.push([index, index + raw.length]);
      from = index + raw.length;
    }
    return ranges;
  }
  const needle = foldSearchText(raw);
  const folded = foldSearchText(text);
  // Lowercase can expand one character (İ -> i + combining dot). Map only
  // when needed, so ordinary ASCII/CJK highlighting has no allocation per char.
  const starts: number[] = [];
  const ends: number[] = [];
  if (folded.length !== text.length) {
    let original = 0;
    for (const character of text) {
      const end = original + character.length;
      for (let index = 0; index < character.toLowerCase().length; index += 1) {
        starts.push(original);
        ends.push(end);
      }
      original = end;
    }
  }
  const ranges: [number, number][] = [];
  let from = 0;
  while (from < folded.length) {
    const index = folded.indexOf(needle, from);
    if (index < 0) break;
    const start = starts.length ? starts[index] : index;
    const end = ends.length ? ends[index + needle.length - 1] : index + needle.length;
    const previous = ranges.at(-1);
    if (previous && start < previous[1]) previous[1] = end;
    else ranges.push([start, end]);
    from = index + needle.length;
  }
  return ranges;
}

type SearchState = SessionSearchPage & {
  query: string;
  loading: boolean;
  error?: string;
};

/** Async ownership belongs to the query, including subsequent result pages. */
export class SessionSearchController {
  private generation = 0;
  private listeners = new Set<() => void>();
  private state: SearchState = { query: "", hits: [], nextOffset: null, loading: false };

  private fetchPage: (query: string, offset: number) => Promise<SessionSearchPage>;
  constructor(fetchPage: (query: string, offset: number) => Promise<SessionSearchPage>) {
    this.fetchPage = fetchPage;
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: SearchState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  cancel() {
    this.generation += 1;
    this.publish({ ...this.state, loading: false });
  }
  reset(query: string) {
    this.generation += 1;
    this.publish({ query, hits: [], nextOffset: null, loading: Boolean(query) });
  }
  async load(offset = 0) {
    const { query } = this.state;
    if (!query) return;
    const generation = this.generation;
    this.publish({ ...this.state, loading: true, error: undefined });
    try {
      const page = await this.fetchPage(query, offset);
      if (generation !== this.generation) return;
      const previous = offset ? this.state.hits : [];
      const known = new Set(previous.map((hit) => hit.session.id));
      this.publish({
        query,
        loading: false,
        nextOffset: page.nextOffset,
        hits: [...previous, ...page.hits.filter((hit) => !known.has(hit.session.id))],
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.publish({
        ...this.state,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  retry = () => {
    if (!this.state.loading)
      void this.load(this.state.hits.length ? (this.state.nextOffset ?? 0) : 0);
  };
  loadMore = () => {
    if (!this.state.loading && this.state.nextOffset !== null)
      void this.load(this.state.nextOffset);
  };
}
