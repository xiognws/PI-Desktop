import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { skillReviewText } = await import("../src/features/chat/transcript/skill-review-text.ts");

/** Echo the key and its options, so the test is about which branch ran. */
const t = (key, options) => `${key}${options ? ` ${JSON.stringify(options)}` : ""}`;

test("an applied review names the updates it made", () => {
  const text = skillReviewText({ outcome: "applied", actions: ["a", "b"] }, t);
  // The row prints what the review wrote, not a bare count: the actions are the
  // part a reader acts on, and the label is a sentence around them.
  assert.match(text, /skillReviewAppliedDetail/);
  assert.match(text, /"detail":"a · b"/);
});

test("a review that looked and found nothing is not the same as one that never looked", () => {
  assert.match(skillReviewText({ outcome: "skipped", reason: "nothing-to-save", actions: [] }, t), /skillReviewNothing/);
  assert.match(skillReviewText({ outcome: "skipped", reason: "no-tool-calls", actions: [] }, t), /skillReviewNoLook/);
});

test("failures and other skips name their own reason", () => {
  assert.match(skillReviewText({ outcome: "failed", actions: [] }, t), /skillReviewFailed/);
  assert.match(skillReviewText({ outcome: "skipped", reason: "cooldown", actions: [] }, t), /skillReviewSkipped.*cooldown/);
});

test("a structured write is said in the reader's language, file included", () => {
  // The reference prints one sentence per write, joined with `·`, naming the skill
  // and the file: `skill 'x' wrote references/y.md · skill 'z' wrote …`. The parts
  // come from the runtime, the words come from the locale.
  const text = skillReviewText(
    {
      outcome: "applied",
      actions: ["wrote 'a/references/x.md'", "wrote 'b/references/y.md'"],
      actionDetails: [
        { kind: "wrote", subject: "rust-agent-kernel-port", file: "references/node-parity-traps.md" },
        { kind: "patched", subject: "pi-desktop-dev" },
      ],
    },
    t,
  );
  assert.match(text, /skillReviewAppliedDetail/);
  assert.match(text, /rust-agent-kernel-port/);
  assert.match(text, /references\/node-parity-traps\.md/);
  // Two writes, one line, joined the way the reference joins them: exactly one
  // separator, and both sentences present.
  assert.equal(text.split(" \u00b7 ").length, 2, text);
  assert.match(text, /skillReviewActionWithFile/);
  assert.match(text, /skillReviewAction /);
  // A patch with no file still names its verb.
  assert.match(text, /skillReviewVerbPatched/);
});

test("the runtime's English sentences are the fallback, not the shape", () => {
  // An old session replayed from the log carries no structured writes; the row
  // still renders instead of going blank.
  const text = skillReviewText({ outcome: "applied", actions: ["wrote 'a/b.md'"] }, t);
  assert.match(text, /"detail":"wrote 'a\/b.md'"/);
});
