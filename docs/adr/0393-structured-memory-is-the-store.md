# 0393 - The structured memory table is the store; the flat list retires

- Status: Accepted
- Date: 2026-11-11
- Supersedes: ADR 0378 (the flat `memory_entries` list and its frozen snapshot)
- Amends: ADR 0371 (the scored memory table)

## Context

Memory in this product has been built twice.

`memories` (ADR 0371) is a structured store: `kind`, `title`, `body`, `tags`,
`source`, `confidence`, `pinned`, `content_hash`, `use_count`, `last_used_at`,
`valid_from`/`valid_until`, `superseded_by`, scoped by project and session, with an
FTS5 index (`memories_fts`) and a `memory_proposals` approval queue. In the local
database it holds **0 rows**: the writer that filled it (`memory.remember`) has no
callers, because the agent's tool was pointed at the flat list instead.

`memory_entries` (ADR 0378) is a two-column-per-target flat list
(`target`, `ordinal`, `content`) with whole-store character budgets of 2200 and
1375, copied from Hermes' `MEMORY.md`/`USER.md` files. It is rendered into the
system prompt in full at session start, which is why it must stay small, and it
holds the 11 entries the agent has written here.

The user's instruction settles which one to keep: **the flat user/memory pair is
not used in Hermes either - hindsight is** - so PI should implement the hindsight
principles on SQLite rather than copy the file layer. Hindsight's shape is a store
with structured memories, retrieval by relevance, and only the relevant ones
reaching the context - which is what `memories` already is.

## Decision

1. **`memories` becomes the single store.** No new tables and no second list: the
   structured table already carries the fields a ranked retrieval layer needs.
2. **The flat list retires.** Existing `memory_entries` rows are migrated in
   (`kind` inferred: a `user`-target entry becomes `preference`, everything else
   `fact`; `title` = the first line, `body` = the entry, `content_hash` computed,
   `source = "migrated"`). The table stays readable for one release so nothing is
   lost if the migration is wrong, and nothing writes it again.
3. **Writing is retain, not append.** One tool call stores a memory with `kind`,
   `title`, `body`, `tags`, and scopes it to the project or session. A matching
   `content_hash` updates instead of duplicating; a contradicting memory supersedes
   the old one (`superseded_by`) rather than deleting it, so history stays readable.
4. **Reading is retrieval, and nothing is injected wholesale.** Per turn, the
   runtime asks for memories relevant to the user's message and puts the hits in
   the *user* message (not the system prompt: a system-prompt change discards the
   provider prompt cache, ADR 0337). The block is capped in characters, and the
   only always-present memories are pinned ones.
5. **Use is observed.** `use_count` and `last_used_at` move when a memory is
   retrieved or explicitly touched - never because it was injected, which would
   keep whatever entered first at the top forever.
6. **Chinese has to be searchable.** The FTS index is rebuilt with the `trigram`
   tokenizer: `unicode61` treats a whole Chinese phrase as a single token, so the
   current index can only find Chinese memories by exact phrase.

## Consequences

- Capacity stops being a product limit: the store holds thousands of memories
  because the prompt holds a retrieval block of fixed size, not the store.
- The "how much memory may I keep" tool message (2200/1375) disappears, and with it
  the pressure to delete a useful note to make room for a new one.
- Existing entries keep working through the migration, but the memory page has to
  read the new store; the two-target grouping (`memory` / `user`) becomes a `kind`
  filter over one list.
- Retrieval quality becomes the thing that matters. It has to be observable: the
  memory page shows each row's `kind`, `pinned`, `use_count`, and whether it was
  retrieved in the current session.
- The `memory_proposals` queue exists and stays unused for now; nothing in this
  decision requires approval before writing.

## Alternatives considered

- **Keep the flat list and add ranking to it.** No tags, no validity window, no
  supersede chain, no scoping: a ranking over two columns cannot express "this
  replaced that", so the store would accumulate contradictions.
- **Build hindsight's schema from scratch.** `memories` already has all 19 columns
  and an FTS index; a new table would be the same table with a different name.
- **Keep both stores and dual-write.** Two writers, two sources of truth, and the
  recall path searching one while the prompt shows the other - the defect this
  change exists to remove.
