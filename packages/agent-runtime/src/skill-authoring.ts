/**
 * The SKILL.md authoring bar.
 *
 * Shared by `skill_manage` (the write tool an agent calls) — the one place that
 * states what a document written into the library has to look like. It lives
 * beside the tool rather than in the review module, because the tool is its only
 * reader now: the background review carries its own body contract in the prompt
 * (see `skill-review-run.ts`).
 */

/** Authoring bar, shared by the review prompt and the `/learn` command. */
export const SKILL_AUTHORING_GUIDE = `SKILL.md quality bar:

Frontmatter:
- name: lowercase-hyphenated, matches the directory.
- description: ONE sentence, <=120 characters, ends with a period. State when to use it, not the implementation.

Required body sections (Chinese headings are fine: 何时使用 / 工作流程 / 陷阱 / 验证):
1. Title + 2-3 sentence intro: what it does, what it does NOT do.
2. ## When to Use — concrete trigger phrases AND a Do-not-use list.
3. ## Procedure — numbered steps. Commands, URLs, flags and error strings MUST be copied verbatim from the session. Never invent flags.
4. ## Pitfalls — things that look like success but are not (for example an HTTP 200 HTML body), plus the correction.
5. ## Verification — one checkable criterion (file exists, UI shows X, command output contains Y).

Depth:
- Capture decision rules, not a recap of this afternoon. Class-level names (openai-compatible-base-url), never fix-issue-12.
- Frame tools as PI: read, write, edit, bash, grep, glob.
- Prefer patching an existing skill over creating a near-duplicate.`;

/** Per-op content budget for one review answer. See the size rules below. */
export const REVIEW_OP_CONTENT_LIMIT = 4_000;

/** System prompt for one review pass. Output must be JSON only. */
export const SKILL_REVIEW_SYSTEM = `You review one finished PI-Desktop agent turn and decide whether the learned skill library should change.

Return ONLY JSON, no markdown fences:
{
  "decision": "skip" | "update",
  "reason": "short reason",
  "ops": []
}

ops items:
- {"action":"write_file","name":"existing-skill-name","file_path":"references/topic.md","content":"<markdown>"}
- {"action":"patch","name":"existing-skill-name","old_string":"exact unique substring of that skill's body","new_string":"replacement"}
- {"action":"create","name":"class-level-name","content":"<full SKILL.md including frontmatter>"}

Answer size — a cut-off answer is worth nothing:
- Emit one compact object on one line. No indentation, no pretty-printing, no newlines inside strings: the reply budget is derived from the model's context window and a formatted answer runs out of it mid-string, which cannot be parsed and records nothing.
- Keep each op's content under ${REVIEW_OP_CONTENT_LIMIT} characters. Distil to decision rules, exact commands and traps, and split longer material across ops rather than writing one long document.
- The reason field is one short sentence. Never restate the transcript in it.

Choose the cheapest op that records what you learned:
- write_file adds a new references/<topic>.md beside the skill. Prefer this for anything that is a self-contained lesson: a pitfall, a recipe, a failure mode, a table. It does not touch the existing document, so it is always safe.
- patch corrects existing text in SKILL.md. Only when the existing text is wrong or incomplete.
- create starts a new skill. Only when no managed skill below covers this class of work.

${SKILL_AUTHORING_GUIDE}

Review rules:
- A session that taught something reusable MUST produce at least one op. Only answer skip when the turn really carried nothing reusable: small talk, a one-off lookup, an unresolved failure, or work already covered verbatim by a skill below.
- Reading repository state, answering a question, or running a few read-only commands is NOT automatically a skip — if the turn established a decision rule, a command that finally worked, an ordering constraint, or a trap, record it.
- Never record "tool X is broken", and never save a failed attempt sequence as a recommended practice.
- Distill exact commands, status codes, paths and decision rules from the transcript. Do not generalise away the numbers.
- At most 5 ops. An update with empty ops is invalid — use skip instead.
- Do not reference skills that are not in the managed catalog below.`;

/** Prompt body for an explicit user-driven `/learn` request. */
export const SKILL_LEARN_PREFIX = `[skill-learning /learn]
The user wants you to distill a reusable skill from what they described below.

The request may mix SOURCES (directories, URLs, "what we just did") and REQUIREMENTS (focus, skip). Honour both.

Do this:
1. Gather sources with read / grep / glob / bash. Do not invent flags or APIs you did not see.
2. If an existing skill already covers this class, patch it after reading it.
3. Otherwise create a class-level skill.
4. Author to the quality bar below. Thin summaries are a waste of the turn — write the full sections.
5. Large prose sources: keep SKILL.md as a distilled index of rules and tables, not a lossy recap.

${SKILL_AUTHORING_GUIDE}

User request:
`;

export type SkillReviewOp =
  | { action: "create"; name: string; content: string }
  | { action: "patch"; name: string; old_string: string; new_string: string }
  | { action: "write_file"; name: string; file_path: string; content: string };

export type SkillReviewDecision = {
  decision: "skip" | "update";
  reason?: string;
  ops: SkillReviewOp[];
};
