import { describe, expect, it } from "vitest";

import { REDACTED_MARKER, scrubSecrets, scrubSecretsInBatch } from "./redaction.js";

describe("scrubSecrets", () => {
  it("masks the shapes a credential actually takes", () => {
    expect(scrubSecrets("key sk-ABCDEFGHIJKLMNOPQRST")).toBe(`key ${REDACTED_MARKER}`);
    expect(scrubSecrets("token=abcdef1234567890")).toBe(`token=${REDACTED_MARKER}`);
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnop")).toContain(REDACTED_MARKER);
    expect(scrubSecrets("https://user:hunter2@example.com/v1")).toBe(
      "https://***:***@example.com/v1",
    );
  });

  it("leaves ordinary text alone, long words included", () => {
    const text =
      "The relay sits at references/internal-vs-external-relay-numbering.md and costs about 0.5s.";
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe("scrubSecretsInBatch", () => {
  it("masks a token everywhere once it was caught anywhere", () => {
    const [labelled, bare] = scrubSecretsInBatch([
      "api_key=sk-ZZZZZZZZZZZZZZZZ",
      "the key sk-ZZZZZZZZZZZZZZZZ is written down here bare",
    ]);
    expect(labelled).not.toContain("sk-ZZZZZZZZZZZZZZZZ");
    expect(bare).not.toContain("sk-ZZZZZZZZZZZZZZZZ");
    expect(bare).toContain(REDACTED_MARKER);
  });

  it("returns the batch unchanged when there is nothing to mask", () => {
    const batch = ["a note", "another note"];
    expect(scrubSecretsInBatch(batch)).toEqual(batch);
  });
});
