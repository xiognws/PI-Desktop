# ADR 0375: Memory decay retires instead of deleting

- Status: Accepted
- Date: 2026-10-29
- Related: ADR 0371, ADR 0374, spec `03-runtime/21-memory-store.md`

## Context

Stage 2b of the memory spec asked for confidence decay and a periodic tidy-up.
The store already had half of it: `memories` carries `confidence`, `use_count`,
`last_used_at` and `valid_until`, and an unattended job ran once a day —
`daily_memory_tidy` — calling `tidy_memories` with a retention policy that
**deleted rows** past an age window, a confidence floor, or a live-count cap.

Two problems with deleting.

1. A memory is content the user paid for: it came out of a turn they ran, and
   nothing in the app can bring it back. An unattended job is the worst possible
   actor for an irreversible action.
2. Deletion is not the only thing a faded memory needs. The real cost of a stale
   memory is that it competes with a fresh one for the recall budget, and that
   cost is paid by *not recalling it*, not by destroying it.

`valid_until` already means "believed until this moment" — supersession sets it.
That is exactly the semantics a retirement needs.

## Decision

1. Decay is a **pure decision**: `crates/host-core/src/memory/decay.rs` takes the
   stored rows, a policy and `now`, and returns proposals. Confidence halves
   every `half_life_days` (120 by default) of disuse; a memory is proposed for
   retirement only when it is live, unpinned, unused past `idle_days` (120), has
   faded below `min_confidence` (0.2), and was used fewer than `keep_use_count`
   (2) times. Repeated use is the strongest evidence a memory is still true, so
   it outranks age.
2. Retirement **sets `valid_until`** and nothing else. No schema change, no new
   table, no column: the same field supersession uses now also carries "no longer
   recalled". `restore` clears it.
3. Recall **honours it**: the FTS query excludes rows whose `valid_until` has
   passed, so a retired memory stops competing for the context budget while
   staying readable through `memory.list` (the audit surface).
4. Re-learning a retired memory **revives** it. The dedupe index keeps one row
   per content hash, so the refresh path clears `valid_until` instead of
   inserting a second row.
5. The unattended daily job **retires, never deletes**. Retirement is bounded on
   purpose: beyond `MAX_RETIRED_ROWS` (200) the oldest retired rows are pruned so
   the store cannot grow forever.
6. `memory.tidy` keeps its destructive semantics and stays available. It is now
   the *only* path that removes rows outright, and it is explicit: the user
   presses it.

## Consequences

- No automatic path destroys user content any more. The worst an unattended sweep
  can do is stop recalling a memory, which `restore` (or re-learning it) undoes.
- `memory.decay` costs nothing to call: it is a read, so the panel can show the
  proposal every time it opens.
- A pinned memory is refused by `retire_memory` with `MEMORY_PINNED` rather than
  silently skipped, so a caller never believes it retired one.
- Storage grows up to the retired bound instead of shrinking with each sweep.
  That is the deliberate trade for reversibility; the manual tidy remains the way
  to reclaim it.
- Automatic extraction after a completed turn — the other half of stage 2b — is
  still open: it needs a model and a review step, exactly like automatic skill
  merging, and it is the next slice.
