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
