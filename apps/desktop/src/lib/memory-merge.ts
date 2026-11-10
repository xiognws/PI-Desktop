/**
 * Bringing the two memory stores together, from the renderer side.
 *
 * `memory_entries` is what the model reads every turn; `memories` (ADR 0371) is
 * the older scored store, which nothing in the conversation writes any more but
 * which still holds whatever was recorded before the flat list existed. Two
 * stores, one page, and no way for a user to tell which of them their agent can
 * actually see — that is the defect this closes.
 *
 * The direction is one-way on purpose: legacy rows are **copied** into the entry
 * list and left where they are. Copying is reversible (delete the entry), while
 * migrating-and-deleting is not, and a bug in this file must never be able to
 * lose something a session decided was worth keeping.
 */

export type LegacyMemory = {
  title?: string;
  body?: string;
  kind?: string;
  pinned?: boolean;
};

export type MemoryTarget = "memory" | "user";

export type MergeResult = {
  /** The list after the merge, ready for `memory.writeEntries`. */
  next: string[];
  /** Texts appended, in the order they were appended. */
  added: string[];
  /** Texts skipped because the list already carried them. */
  duplicates: number;
  /** Texts that did not fit the budget and stay only in the legacy store. */
  overflow: string[];
};

/** The budget the host enforces per store, in characters. */
export const MEMORY_BUDGET: Record<MemoryTarget, number> = {
  memory: 2200,
  user: 1375,
};

/** Where a legacy record belongs now: preferences describe the person. */
export function targetForLegacy(memory: LegacyMemory): MemoryTarget {
  return (memory.kind ?? "").toLowerCase() === "preference" ? "user" : "memory";
}

/**
 * Merge legacy records into one store's entry list.
 *
 * A record becomes `title: body` when both exist, because the title alone is
 * usually a label and the body carries the rule. Comparison is on a normalised
 * form so a record that was already copied is not copied twice — re-running the
 * merge after adding one record must be safe.
 */
export function mergeLegacyInto(
  entries: readonly string[],
  legacy: readonly LegacyMemory[],
  target: MemoryTarget,
): MergeResult {
  const seen = new Set(entries.map(normalise));
  const next = [...entries];
  const added: string[] = [];
  const overflow: string[] = [];
  const budget = MEMORY_BUDGET[target];
  let length = entries.reduce((total, entry) => total + entry.length, 0);
  let duplicates = 0;

  for (const memory of legacy) {
    if (targetForLegacy(memory) !== target) continue;
    const title = (memory.title ?? "").trim();
    const body = (memory.body ?? "").trim();
    const text = title && body && title !== body ? `${title}: ${body}` : body || title;
    if (!text) continue;
    const key = normalise(text);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    if (length + text.length > budget) {
      overflow.push(text);
      continue;
    }
    seen.add(key);
    next.push(text);
    added.push(text);
    length += text.length;
  }

  return { next, added, duplicates, overflow };
}

/** Case, width and whitespace differences are not new memories. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
