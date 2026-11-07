---
name: autotest
description: Drive the soft/hardware integration test rail - decompose a requirement, generate the case set, wait for the human review gate, author scripts, execute them, analyse failures and write the report. Use when the user asks to test a feature, turn a PRD into cases, run an approved suite, or explain why a test run failed.
---

# Autotest rail

Six stages, in this order: requirements -> cases -> scripts -> run -> verdict -> report.
You never skip a stage and you never jump back to a later one.

## Stage contract

1. **requirements** - `autotest_requirement` with `action: "decompose"`.
   Pass the source material verbatim. Report the extracted features and, more
   importantly, the gaps: questions the source does not answer. Ask the human
   to answer them, then call the tool again with `gapsConfirmed: true` and the
   answers folded into `source`. Do not invent answers.
2. **cases** - `autotest_cases` with `action: "generate"`.
   The result lands in `awaiting_review`. Read back coverage and duplicates and
   mention them. Then stop and ask the human to review.
3. **review gate** - the human approves in the review card in the conversation,
   or asks you to change the selection with `autotest_select`. You never
   approve on their behalf and you never bundle an edit into an approval: an
   approval covers exactly the rows the reviewer saw, so if a row changed, the
   approval has to happen in a separate call after the change.
4. **scripts** - `autotest_author` with `action: "write"`. Refuses while the
   gate is closed; surface the refusal reason instead of retrying.
5. **run** - `autotest_run` with `action: "execute"`.
6. **verdict** - `autotest_diagnose` with `action: "diagnose"`. Failures are
   classified, not assumed to be script bugs.
7. **report** - `autotest_report` with `action: "report"`.

## Rules that are not negotiable

- **Never write or edit a script before approval.** A closed gate is a stop, not
  an obstacle to route around.
- **Never weaken an assertion to make a run pass.** If the expected value looks
  wrong, say so and ask; do not change the expectation silently.
- **Respect the failure class.** `environment` and `product` failures are human
  only. Only `script` and `assertion` failures justify a script repair, and the
  repair still needs a re-run to prove it.
- **Report what the run produced.** Never describe a skipped or errored script
  as passing.
- **Do not loop.** One generation per stage. A second attempt needs a concrete
  reason from the human.

## Tools

| tool | action | what it does |
| --- | --- | --- |
| `autotest_requirement` | `decompose` | features, acceptance criteria, gaps; opens the plan |
| `autotest_cases` | `generate` / `regenerate` | case set, coverage, duplicates; opens the gate |
| `autotest_select` | `select` / `deselect` | change the approved subset |
| `autotest_author` | `write` | one script per approved case |
| `autotest_run` | `execute` | run scripts, record results |
| `autotest_diagnose` | `diagnose` | classify failures, decide if repair is legitimate |
| `autotest_report` | `report` | write report.md |
| `autotest_status` | `status` | plan state, or every plan when no id is given |

## Data

Everything lives under the plugin data directory, one folder per plan:
`plans/<id>/state.json`, `artifacts/`, `scripts/`, `runs/`, `report.md`.
Quote the plan id whenever you refer to a plan so the human can find it.
