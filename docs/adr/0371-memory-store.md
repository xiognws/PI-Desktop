# ADR 0371: Durable agent memory lives in host-core SQLite, keyword-first

- Status: Accepted for implementation
- Date: 2026-10-27
- Issues: memory store, stage 1 (storage + recall)
- Related: [ADR 0030](0030-turn-boundary-context-checkpoint-compaction.md), [ADR 0044](0044-session-bound-project-instruction-preflight.md)

## Context

The agent remembers a conversation (persisted transcript) and reads project
instructions (`AGENTS.md` / `CLAUDE.md`) plus a single free-text project memory
blob. Nothing survives a *change of session* other than those files, and
nothing records what the agent learned while working: a pitfall it hit, a
decision it made, a preference the user stated once.

The product requirement is that the agent gets more useful the longer it is
used, across both project memory and session memory, without breaking the two
constraints the project already accepted:

1. **Local-first, self-contained distribution.** A memory layer that needs a
   Python service, a vector database or a graph database turns a
   double-click desktop app into an operations project.
2. **One writer for persisted state.** SQLite is owned exclusively by the Rust
   host; the renderer never opens it and the Node runtime only sees it through
   RPC.

## Decision

**Store memories in a new host-core table and retrieve them with FTS5.** No
external memory service, no vector store in stage 1.

- One table `memories` with a `scope` of `global` | `project` | `session`.
  `project_path` is required for `project` scope and forbidden for the other
  two; `session_id` the same for `session` scope. Two schema `CHECK`s enforce
  this, so an incoherent row cannot be written.
- **Bi-temporal columns.** `created_at` / `updated_at` record when the agent
  learned something; `valid_from` / `valid_until` / `superseded_by` record when
  the fact is believed to be true in the world. A correction closes the old
  row and links it to its successor instead of overwriting history, so "what
  did it believe last week" stays answerable.
- **Keyword retrieval, not embeddings, in stage 1.** A separate FTS5 table
  stores a *normalised copy* of title/body/tags. Normalisation emits one token
  per CJK ideograph (`上下文压缩` → `上 下 文 压 缩`) because the bundled
  tokenizers cannot segment Chinese; Latin words are kept whole. The read path
  normalises the query identically, so `压缩` matches a longer CJK run without
  shipping a segmenter.
- **Dedupe by content hash inside the scope window.** An identical title+body
  written again refreshes the existing live row (confidence, pin) and reports
  `deduped: true` instead of creating a near-duplicate. The unique index is
  `(content_hash, scope, ifnull(project_path,''), ifnull(session_id,''))`.
- **Recall is scoped in SQL, never post-filtered.** A query returns
  `global` rows, rows of the calling `project`, and rows of the calling
  `session` — nothing else — so one project can never leak into another.
- **Writes are model-free.** This ADR covers storage, dedupe, supersession and
  recall. Deciding *what* is worth remembering (automatic extraction) is a
  separate stage, so the write path stays deterministic and testable.
- **Bounded by construction.** Title ≤ 200 chars, body ≤ 8 000 bytes,
  confidence in `0..=1`, at most 32 pinned memories. These are schema `CHECK`s
  plus call-site validation, not conventions.
- RPC surface: `memory.remember` / `memory.recall` / `memory.list` /
  `memory.update` / `memory.forget` / `memory.stats`, served by
  `rpc/memory_rpc.rs` so the main dispatch table does not grow.

Schema version 25 → 26 creates the table, its indexes and the FTS table.

## Consequences

- Memories survive restarts and session changes, and are visible/editable/
  deletable through the same SQLite file users already back up.
- Chinese and English are both searchable with no new dependency; the price is
  that CJK queries are effectively *character* AND queries, so precision comes
  from the terms themselves rather than from stemming.
- FTS5 ranks by BM25; pinned memories sort first and each returned hit bumps
  `use_count` / `last_used_at`, which future ranking and decay can use.
- Storage cost is small: measured 10 000 rows ≈ 15 MB, 100 000 rows ≈ 88 MB
  including the index, with recall at 1–30 ms in the 10⁴–10⁵ range.
- A vector index (sqlite-vec) can be added later as a *second* ranking signal
  without changing this table: `embedding` is the only column it would add.
- Automatic extraction and decay are intentionally absent; until they land the
  agent only remembers what a caller explicitly writes.

## Alternatives

- **mem0 / graphiti / cognee / letta.** Mature and better at extraction, but
  each requires an external service plus a vector or graph database. Rejected
  for distribution and data-ownership reasons, not for quality.
- **A single-file SQLite memory library (memharness, smrti, Sibyl, …).** All
  are 2026-era projects with fewer than 200 stars and, apart from memharness,
  Python-only. Their *design* informed this ADR (bi-temporal facts from
  memharness, attention/decay from smrti, five-tier scoping from Sibyl) but
  none is a dependency we want to carry, and none can be embedded in host-core.
- **Reusing the existing project-memory blob** (a `kv` entry capped at
  `MAX_PROJECT_MEMORY_BYTES`). It is one undifferentiated string per project:
  no session scope, no timestamps, no dedupe, no retrieval. Kept for the UI's
  hand-written notes; not extended.
- **External Hindsight service.** The strongest feature set (entities, graph,
  reflect), but it is a Python + Postgres service; acceptable later as an
  optional remote backend, not as the default store.
