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
