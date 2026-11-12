/**
 * Reading the structured memory store for the settings page (ADR 0393).
 *
 * One store, two reads: an empty query lists what is stored (pinned first, then
 * what was last used), and a typed query asks the host for `memory.recall` and
 * keeps the hits in the order the host ranked them. The recall score is the
 * host's answer, so this file never re-sorts hits by a field it invented — it
 * only maps them back to records.
 *
 * Scope filtering while searching is the host's too: `memory.recall` narrows by
 * `scope` in the query, because a project session must not see another
 * project's memories. Without a project path or session id the host matches
 * global memories only, which is what a settings page (which knows no session)
 * can honestly ask for.
 */
import type { MemoryHit, MemoryListFilter, MemoryRecallInput, MemoryRecord, MemoryScope } from "./api";

/** One page of the store; the host clamps `limit` to 500. */
export const MEMORY_PAGE_SIZE = 200;

export type MemoryScopeFilter = "all" | MemoryScope;

export type MemoryRequest = {
  scope: MemoryScopeFilter;
  /** Raw text from the search box; whitespace-only counts as empty. */
  query: string;
};

/**
 * The slice of the renderer API this page needs. Narrow on purpose: the view
 * logic is testable without a preload bridge, and a page cannot start calling
 * a method its data path never used.
 */
export type MemoryStoreClient = {
  listMemories: (filter?: MemoryListFilter) => Promise<{ memories: MemoryRecord[]; total: number }>;
  recallMemories: (input: MemoryRecallInput) => Promise<{ memories: MemoryHit[] }>;
};

export type MemoryView = {
  records: MemoryRecord[];
  /** True when the rows are recall hits rather than the full list. */
  recalled: boolean;
};

/** Last-used time as a sort key: never-used memories sort below used ones. */
function useRecency(record: MemoryRecord): number {
  return record.lastUsedAt ?? 0;
}

/**
 * Pinned first, then most recently used, then most used, then title.
 *
 * Only fields the host returns: `last_used_at` and `use_count` are in every
 * `MemoryRecord`, while the host's own list order (creation time) is not a
 * thing this page should pretend to rank.
 */
export function sortMemoryRecords(records: readonly MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (useRecency(left) !== useRecency(right)) return useRecency(right) - useRecency(left);
    if (left.useCount !== right.useCount) return right.useCount - left.useCount;
    return left.title.localeCompare(right.title);
  });
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

/**
 * A memory's last use as relative time in the UI language.
 *
 * `null` means "never recalled" — the caller renders its own copy for that,
 * because "never" is user-facing text and belongs in the catalogs.
 */
export function formatMemoryLastUsed(
  value: number | null | undefined,
  locale: string,
  now = Date.now(),
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const elapsed = (value - now) / 1000;
  try {
    const formatter = new Intl.RelativeTimeFormat(locale || undefined, {
      numeric: "auto",
      style: "short",
    });
    for (const [unit, seconds] of RELATIVE_UNITS) {
      if (Math.abs(elapsed) >= seconds || unit === "second") {
        return formatter.format(Math.round(elapsed / seconds), unit);
      }
    }
    return null;
  } catch {
    return new Date(value).toLocaleDateString(locale || undefined);
  }
}

/** The rows the page shows for one query. */
export async function memoryView(
  client: MemoryStoreClient,
  request: MemoryRequest,
): Promise<MemoryView> {
  const query = request.query.trim();
  if (query) {
    const recalled = await client.recallMemories({
      query,
      limit: MEMORY_PAGE_SIZE,
      ...(request.scope === "all" ? {} : { scope: request.scope }),
    });
    return { records: recalled.memories.map((hit) => hit.memory), recalled: true };
  }
  const filter: MemoryListFilter =
    request.scope === "all"
      ? { limit: MEMORY_PAGE_SIZE }
      : { scope: request.scope, limit: MEMORY_PAGE_SIZE };
  const listed = await client.listMemories(filter);
  return { records: sortMemoryRecords(listed.memories), recalled: false };
}
