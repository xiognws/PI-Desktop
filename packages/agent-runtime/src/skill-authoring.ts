/**
 * The SKILL.md authoring bar.
 *
 * Shared by `skill_manage` (the write tool an agent calls) — the one place that
 * states what a document written into the library has to look like. It lives
 * beside the tool rather than in the review module, because the tool is its only
 * reader now: the background review carries its own body contract in the prompt
 * (see `skill-review-run.ts`).
 */

/** The quality bar a `skill_manage` write has to meet. */
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


/**
 * When to write a skill at all — the counterpart of the memory rules, and the
 * one thing a session could not infer from the tool schema.
 *
 * Without this the model writes everything to memory: measured on a real
 * session, three turns carrying an environment quirk, a lock pitfall and a
 * three-step release procedure all landed as memory entries, and the library
 * gained nothing. The distinction the prompt has to make is not "durable vs
 * temporary" — memory is durable too — but **procedure vs fact**.
 */
export const SKILL_WRITING_RULES = `# Writing to the skill library

Memory and skills are both durable, and they are not interchangeable: memory holds what is true, a skill holds what to do.

- A **procedure** belongs in a skill. When a turn produces a sequence you would repeat for the same class of task — two or more steps, still true next month, independent of what this conversation happened to be about — write it with \`skill_manage\` action \`create\`. If a skill in \`# Skills\` already covers that class, \`patch\` it or add a \`references/\` file instead; never start a near-duplicate.
- A **fact, a preference, or a one-line environment quirk** belongs in \`memory\`. "This machine blocks TCP 22" is memory. "How to publish a branch on this machine" is a skill, even though it contains that fact.
- A skill is class-level. Name the class of problem, not the issue that surfaced it; a rule that only applies to this afternoon's task is a memory entry at best.
- The library is worth keeping only if it stays small and sharp: one skill per class of task, with the deep material in \`references/\`. Before writing, ask whether the next session facing this class of task would act differently — if not, do not write it.
- Reading comes first: \`Skill\` with no id lists the live library; with an id it returns the document and its reference files. Patch what exists before creating what does not.`;
