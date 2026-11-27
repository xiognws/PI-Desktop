# ADR 0412 — A session keeps a ledger of what it finished

## Status

Accepted (2026-11-27).

## Context

A measured session (`4cc6ae0a`, smart mode, 19 turns) lost its own history three
ways at once, each of them individually correct:

| what the session held | value |
| --- | --- |
| transcript on disk | 9.23 MB of text across 1,205 rows |
| rows the parent model owns | 454 (751 rows, 61%, belonged to `explorer`/`fixer`/`test-runner`) |
| rows restored after a client restart | 493 of 1,043 — **740 subagent rows and 6 prompt-journal rows dropped** |
| bytes that never enter the parent's context | **6.07 MB of 7.78 MB (78%)** |
| tokens the last turn's requests actually carried | ~31k, against ~2.3M tokens of transcript (**1.3%**) |

Compaction replaces the conversation with a summary, ageing keeps only the ends of
an old tool result, and a restart drops subagent rows the parent never owned
(ADR 0062). Compaction's summary was also memory-only until ADR 0412's companion
fix, so a restart resumed on the raw rows the summary had replaced. The result was
a model that could not answer "what have we already done", most sharply in smart
mode, where the majority of the work happens in workers whose transcript the
parent never holds at all.

The gap is not storage — the transcript is complete on disk. The gap is that
nothing carries the *conclusion* forward in a form that survives all three
mechanisms.

## Decision

Host-core owns an append-only **session ledger** (`session_ledger`, schema v35):
`id, session_id, turn_id, kind, text, created_at`, trimmed to the newest 500
entries per session. The kernel writes it and reads it over two RPCs,
`session.ledger.append` and `session.ledger.list`; nothing else writes it.

Who writes an entry, and why there:

- **The kernel, at a turn boundary, by rule** (`ledger_entry_for_turn`): the last
  user ask, the last assistant conclusion, the tool tally with its error count,
  and any `Task`/`TaskWait` report in the tail. No model call — a second paid
  request per turn to write a note is not a trade this product makes.
- **Nothing on the model's behalf yet.** A model-facing ledger tool is deliberately
  out of scope: the rule-derived entry already answers "what did we finish", and a
  tool would spend a step to add what the transcript already says.

How it comes back: `ledger_prefix` reads the newest 24 entries at prompt
composition and renders them into the request prefix ahead of recalled memories.
The block is capped at 3,000 characters with the newest entries winning, so it
cannot become a second transcript — it is the same class of input as a compacted
checkpoint, and it is prepended rather than stored in the transcript so the row
the renderer draws stays what the user typed.

Failure behaviour: a missing, failing or slow host yields no block, and a failed
write is a warning. The ledger improves a resume and must never be a precondition
for prompting.

## Consequences

- A resumed session opens with a block naming what the session already finished,
  independent of what the transcript restore dropped, what compaction summarized or
  what ageing trimmed. Subagent work survives as its settled report, which is the
  only part of it the parent ever held.
- Cost: one host round trip per turn (~1 ms, local socket) and up to 3k characters
  in the request. The block changes once per turn, so it sits at the head of the
  prompt and does not disturb the cached tail.
- The ledger is not state the kernel may trust blindly: it is a summary written by
  a rule, so it can name a file that has since changed. It says what was done, and
  the model re-reads the file when the answer depends on the current bytes.
- 500 entries per session is a bounded disk cost (roughly 2 MB worst case). The
  oldest entries go first; the entry a turn just wrote is never the one trimmed.
- A database stamped past v35 by another line gets the table re-asserted by the
  converge pass, because the version chain skips every step for a current stamp.

## Alternatives

- **Re-inject subagent transcripts into the parent context.** Rejected: it is the
  opposite of ADR 0062 and of the request budget that keeps a long session
  affordable — 6 MB of worker output on every step.
- **Persist every compaction checkpoint and restore from it, with no ledger.**
  Insufficient on its own: it fixes the case where compaction ran, and says
  nothing about the 78% of work the parent never held or about turn boundaries that
  ended in `TURN_ABORTED`.
- **Let the model write the ledger with a tool.** Deferred, not rejected: the rule
  costs nothing and covers what the transcript cannot; a tool would add a step per
  turn to record what the model just said.
- **Store entries as transcript rows (a `system` row with metadata).** Rejected:
  every transcript row is replayed, aged and counted against the budget, and the
  renderer would have to learn a second hidden row shape. The ledger is read by the
  request composer, not by the conversation.
