# ADR 0376: An extraction pass proposes memories; only a person writes them

- Status: Accepted for implementation
- Date: 2026-10-29
- Related: ADR 0371, ADR 0375, spec `03-runtime/21-memory-store.md` §9.3

## Context

Stage 2b's other half is "automatic extraction after a completed turn": noticing
that a finished turn contained something worth remembering — a decision, a
preference, a pitfall — without the agent having decided to call `Remember`.

Three properties make this harder than it looks.

1. **A model's guess is not a fact.** Extraction runs unattended, over text the
   model itself produced. Writing those guesses straight into the durable store
   would let the model teach itself, and a wrong memory is recalled for every
   later turn in the project.
2. **It costs money on every turn.** A second completion per turn is a real bill
   the user did not ask for and cannot see.
3. **The store's dedupe is by content hash.** Two runs over the same turn would
   otherwise queue the same memory twice.

## Decision

1. Extraction writes **proposals**, never memories. `memory_proposals` is a
   separate table (schema v28): scope, kind, title, body, tags, confidence,
   origin, `created_at`, and a nullable `decision`/`decided_at`.
2. **Accepting is the only writer.** `memory.acceptProposal` calls the existing
   `remember` path, so a proposal inherits every invariant a memory already has
   (validation, dedupe, FTS sync) and then marks itself `accepted`.
   `memory.rejectProposal` records `rejected` and never writes a memory.
   Rejections are kept so the panel can show what was turned down.
3. **Scope is server-side.** The caller may name a project or session, but the
   host derives the scope from which ids it received; a model-returned scope is
   ignored, exactly like the `Remember` tool. A proposal can therefore never
   widen its own reach.
4. **Duplicates never queue.** A proposal whose content hash the store already
   believes is dropped, and an open proposal with the same hash and scope is not
   queued twice (partial unique index on the open rows only).
5. The extraction pass itself is **opt-in and lives outside the turn's critical
   path**: it runs after a turn completes, on the configured model, and every
   failure is swallowed. A turn must never fail or slow down because extraction
   did.
6. The panel shows the queue above the list with Accept and Ignore per row, and
   the count is loaded with the list so a pending proposal is visible without
   opening anything else.

## Consequences

- The unattended half of the feature cannot corrupt the store: the worst case is
  a queue of suggestions the user ignores.
- Review is cheap: the queue is one row per suggestion, with the body visible.
- `memory_proposals` is bounded by the same discipline as the archive: decided
  rows are history, and only open rows are unique.
- The model call is the remaining piece. It needs a place that owns credentials
  and one-shot completions — the two candidates are the agent runtime's
  post-turn hook (correct boundary, more plumbing) and the Electron main
  one-shot completion the plugin bridge already uses (faster, but it crosses the
  plugin capability boundary). That choice is deliberately not made here: it is
  an architecture decision that deserves its own review, and the host half is
  useful without it.
