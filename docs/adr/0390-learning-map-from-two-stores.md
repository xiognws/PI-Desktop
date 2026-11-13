# ADR 0390 — A learning map drawn from the two stores

Status: Accepted
Date: 2026-11-09
Amended: the map still draws skills and memories together, but its memory half now
reads `memory.list` — the flat entry store this ADR read through `memory.entries`
was retired and its table dropped (ADR 0393, schema v31). See
[0393](0393-structured-memory-is-the-store.md).
Amended: nodes are activatable. A node opens a card beside the map that says what
it is — a skill's description, level, load count and pin state, or a memory's kind,
title, body and recall count — and that card can remove the one record behind it,
through the call the owning list already makes (`skills.remove` for a document,
`memory.forget` for an entry) after a two-click arm. Resolving a node back to its
record stays pure (`learningNodeDetail`), so the picture's rules are still tested
without a DOM.

## Context

The agent now writes to two stores (ADR 0377, ADR 0380) and the settings page can
inspect each one separately: skills with their load counts, memories in their own
pane. Nothing showed the relationship between them, and the relationship is the
interesting part — a skill and a memory entry are the same kind of object (a past
session decided something was worth keeping), differing only in shape: a document
the model loads when relevant, or a line that is always in context.

Hermes draws this as a learning graph. Copying its layout is not possible: it
carries its own renderer and its own node model, and PI stores neither the
`related_skills` frontmatter nor an explicit memory→skill attachment.

## Decision

Add a **learning map** card to the agent-capabilities settings page, built
entirely in the renderer from data the app already holds.

1. **Two node kinds, no invented third.** Skills (`enabled` only — a switched-off
   skill is not something the agent can currently use) and the agent's own memory
   entries, read through a new `memory.entries` IPC channel that forwards the
   host RPC of the same name. The scored `memory.list` table is not drawn: it is
   the old memory model, and mixing it in would show one topic twice.
2. **Edges mean shared vocabulary, nothing else.** Tokens are Latin words of three
   characters or more plus CJK 2- and 3-character shingles, minus a small stop
   list. An edge is drawn only above a Jaccard threshold (0.2 by default), capped
   at 40 edges and sorted strongest first. A line between every pair would make
   the picture decorative.
3. **A static layout, not a simulation.** Skills sit on an inner ring, memories on
   an outer ring, both ordered by id. A force layout settles differently on every
   visit, which makes two visits incomparable; the point of the map is to see
   change over time.
4. **Pure logic in `lib/learning-map.ts`, paint only in the component.** The
   tokenizer, the overlap rule, the caps and the geometry are unit-tested without
   a DOM; the SVG component only draws what the builder returns.
5. **Caps are reported.** The card says how many skills and memories it drew and
   how many it left out, so a full library does not look like a small one.

## Consequences

- The map is a picture and an index: a node is focusable, says whether it is open,
  and opens a card with what it is; the labels are still truncated. The card can
  remove the record behind it and nothing else — no editing, no merging, no second
  write path. What it removes is what the owning list removes, so a skill leaves
  through `skills.remove` rather than the archive move the maintenance pass uses.
- Token overlap is a heuristic. Two unrelated skills that share a domain word
  ("windows") will be linked; a genuinely related pair that words things
  differently will not. The threshold is a single constant with a test, so
  judgement can be adjusted without touching the component.
- Reading memory entries is best-effort: if the host call fails, the card draws
  the skills alone instead of failing the page.
- A drawn id carries the record id only, so a global and a project skill with the
  same slug collapse onto one node, and the card resolves it to the global
  document. The picture was already combining them; the removal makes the
  ambiguity visible rather than introducing it.
