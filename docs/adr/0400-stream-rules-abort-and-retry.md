# ADR 0400: Stream rules abort the turn instead of repeating themselves in the prompt

## Status

Accepted. Implemented in `packages/agent-runtime/src/stream-rules.ts` (matching),
`stream-rule-guard.ts` (firing and budgets) and the `message_update` hook in
`runtime.ts` (abort, then retry through `runPendingRecoveries`).

One debt remains and it cannot be paid in this package: the firing is logged, not
emitted as a protocol event, because `AgentEvent` is a closed union owned by
`@earendil-works/pi-agent-core`. A dedicated event needs either an upstream change
or a local enrichment of the envelope; until then a rule firing appears in the
application log with its session, turn, rule id and match size.

## Context

Project conventions ("don't reach for `Box::leak`", "no `any` in this repo", "money
rounds half-up") have to reach the model on **every** turn, or they are not
conventions. The only mechanism today is the system prompt: the same paragraphs
repeated on every request, paid for on every token, and read by the model in bulk
rather than at the moment it matters.

A system prompt is also cached by prefix (ADR 0337), so a rule cannot be added
mid-turn without rewriting that prefix.

## Decision

A **stream rule** is a regular expression over the assistant text of the current
attempt. When it matches, the runtime:

1. aborts the in-flight provider stream at token granularity;
2. appends the rule's message to the conversation as a system reminder, attributed
   to the rule by name;
3. retries the same turn from the same user message.

The rule costs nothing on the turns that behave. On the turn it fires, the model
sees the correction at the point of the mistake instead of in a preamble it may
have already skimmed.

Constraints that make this safe rather than a foot-gun:

* **Per-turn activation budget** (`maxPerTurn`, default 1). A rule that fires on
  every retry is an infinite loop; the budget makes the second match a
  pass-through, so the turn always terminates.
* **Matching over the accumulated text**, not the latest chunk: `^\s*import` and
  "the third bullet" are statements about the whole attempt.
* **Bounded reminder size**: the matched excerpt is trimmed, so a pathological
  pattern on a huge chunk cannot inflate the next request.
* **Rules are configuration, not model output**: they come from settings, are
  validated by name (a rule that fails validation is reported, never dropped), and
  cannot be introduced by anything the model writes.

## Consequences

* The stream becomes an object the runtime can interrupt. `agent-runtime` already
  aborts a stream for user cancellation (`AbortSignal`), so this reuses that path
  rather than adding a second one; what is new is that the runtime decides, not
  the user.
* A firing rule is a **protocol event**, not just a log line: the transcript shows
  that a rule fired, which turn it fired in, and what it matched. Without that, a
  course-correction looks like the model changing its mind.
* Retries cost tokens. A turn that trips three rules makes four requests. The
  activation budget plus a per-turn retry cap (`MAX_RULE_RETRIES`, to be fixed with
  the implementation) bounds that.
* The system prompt keeps the rules that are *always* true; stream rules are for
  the ones that are true *until the model forgets*. Both mechanisms stay, with
  stream rules preferred for anything expressible as a pattern.
* Compaction must not lose the injected reminders: they are ordinary messages in
  the transcript, so they survive like any other.

## Alternatives considered

* **Repeat the rules in the system prompt.** Rejected: it is the status quo, and it
  charges every turn for a rule that fires once a week.
* **Post-hoc review of the whole reply.** Rejected: by the time the reply is
  complete, the tool calls it described may already have run.
* **Ask the model to self-check before finishing.** Rejected: a model that ignored
  the rule while writing will usually also ignore an instruction to check its own
  work.
* **Inject only on the next turn.** Rejected: the mistake has already been
  committed by then; this is the case the mechanism exists for.

## References

* ADR 0337 — prompt caching keys on the request prefix.
* ADR 0371 — durable memory; recall is the other channel that changes a turn's
  input without touching the system prompt.
* `packages/agent-runtime/src/stream-rules.ts` — rule validation and matching.
