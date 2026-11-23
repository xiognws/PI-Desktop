import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { skillReviewText, skillReviewWriteLines } = await import(
  "../src/features/chat/transcript/skill-review-text.ts",
);

/** Echo the key and its options, so the test is about which branch ran. */
const t = (key, options) => `${key}${options ? ` ${JSON.stringify(options)}` : ""}`;

test("the applied sentence is the fallback; the writes name themselves", () => {
  // The row draws one line per write, so the sentence only appears when there is
  // nothing to draw (a pass that reported a count without listing anything).
  const text = skillReviewText({ outcome: "applied", actions: ["a", "b"] }, t);
  assert.match(text, /skillReviewApplied/);
  assert.match(text, /"count":2/);
  const lines = skillReviewWriteLines({ outcome: "applied", actions: ["a", "b"] }, t);
  assert.deepEqual(lines, ["\u270D\uFE0F a", "\u270D\uFE0F b"]);
});

test("a review that looked and found nothing is not the same as one that never looked", () => {
  assert.match(skillReviewText({ outcome: "skipped", reason: "nothing-to-save", actions: [] }, t), /skillReviewNothing/);
  assert.match(skillReviewText({ outcome: "skipped", reason: "no-tool-calls", actions: [] }, t), /skillReviewNoLook/);
});

test("failures and other skips name their own reason", () => {
  assert.match(skillReviewText({ outcome: "failed", actions: [] }, t), /skillReviewFailed/);
  assert.match(skillReviewText({ outcome: "skipped", reason: "cooldown", actions: [] }, t), /skillReviewSkipped.*cooldown/);
});

test("each write is its own line, glyph first, in the reader's language", () => {
  // The reference prints one line per write with a glyph, not one sentence for the
  // whole pass: `✍️ skill 'x' wrote references/y.md`. The parts come from the
  // runtime, the words from the locale.
  const lines = skillReviewWriteLines(
    {
      outcome: "applied",
      actions: ["wrote 'a/references/x.md'", "patched 'b'"],
      actionDetails: [
        { kind: "wrote", subject: "rust-agent-kernel-port", file: "references/node-parity-traps.md" },
        { kind: "patched", subject: "pi-desktop-dev" },
      ],
    },
    t,
  );
  assert.equal(lines.length, 2);
  // A hand for a write, a plaster for a patch.
  assert.match(lines[0], /^\u270D\uFE0F /);
  assert.match(lines[0], /skillReviewActionWithFile/);
  assert.match(lines[0], /rust-agent-kernel-port/);
  assert.match(lines[0], /references\/node-parity-traps\.md/);
  assert.match(lines[1], /^\u{1FA79} /u);
  assert.match(lines[1], /skillReviewVerbPatched/);
});

test("a notice with no structured writes still prints its own sentences", () => {
  // An old session replayed from the log carries no structured form; the row
  // renders the runtime's sentences rather than going blank.
  const lines = skillReviewWriteLines(
    { outcome: "applied", actions: ["wrote 'a/b.md'", "memory 'memory'"] },
    t,
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0], /wrote 'a\/b\.md'/);
  // The memory glyph, because a memory write is not a file write.
  assert.match(lines[1], /^\u{1F9E0} /u);
});
