import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { skillReviewReports, skillReviewText } = await import(
  "../src/features/chat/transcript/skill-review-text.ts"
);

/** Echo the key and its options, so the test is about which branch ran. */
const t = (key, options) => `${key}${options ? ` ${JSON.stringify(options)}` : ""}`;

test("one line says what the pass changed, write by write", () => {
  // One sentence for the whole pass, with each write naming itself inside it:
  // `✨ self-improvement review: skill 'a' wrote x.md · skill 'b' updated`. Not one
  // line per write — a pass over four skills must not push the chat down four rows.
  const text = skillReviewText(
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
  assert.match(text, /skillReviewAppliedDetail/);
  assert.match(text, /rust-agent-kernel-port/);
  assert.match(text, /references\/node-parity-traps\.md/);
  assert.match(text, /skillReviewVerbPatched/);
  // Exactly one separator inside the sentence: two writes, one ·.
  assert.equal(text.split(" \u00b7 ").length, 2, text);
});

test("a notice with no structured writes still produces the same one line", () => {
  const text = skillReviewText({ outcome: "applied", actions: ["wrote 'a/b.md'"] }, t);
  assert.match(text, /skillReviewAppliedDetail/);
  assert.match(text, /wrote 'a\/b\.md'/);
});

test("a pass with nothing to list falls back to the count", () => {
  const text = skillReviewText({ outcome: "applied", actions: [] }, t);
  assert.match(text, /skillReviewApplied/);
  assert.match(text, /"count":0/);
});

test("a pass that stopped at its step ceiling is not reported", () => {
  // The ceiling is the scheduler's budget, not a reading of the library: the log
  // keeps the reason, the conversation does not get a row for it.
  assert.equal(
    skillReviewReports({ outcome: "skipped", reason: "step-limit", actions: [] }),
    false,
  );
  // A real write still reports even though the same pass ran out of steps.
  assert.equal(
    skillReviewReports({ outcome: "applied", actions: ["created 'x'"] }),
    true,
  );
  // And a genuine breakage still shows.
  assert.equal(
    skillReviewReports({ outcome: "failed", reason: "PROVIDER_ERROR", actions: [] }),
    true,
  );
});
