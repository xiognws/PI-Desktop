import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { classifyMainProcessError, isFatalMainProcessError } = await import(
  "../main/main-process-errors.ts"
);

/*
 * A fatal main-process error has to restart the app: after an uncaught exception the
 * event loop has unwound past the call site and the state that threw is unknown, so
 * continuing produces quieter failures later. What must not happen is a restart for
 * errors the loop is still consistent after - a closed pipe or a bad HTTP header are
 * everyday events, and killing the user's session for them is worse than the error.
 */

const recordFor = (kind, error) => ({ ...classifyMainProcessError(kind, error), detail: "" });

describe("isFatalMainProcessError", () => {
  it("treats a generic uncaught exception as fatal", () => {
    assert.equal(isFatalMainProcessError(recordFor("uncaughtException", new Error("boom"))), true);
  });

  it("keeps running after a closed pipe", () => {
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    assert.equal(isFatalMainProcessError(recordFor("uncaughtException", error)), false);
  });

  it("keeps running after a bad HTTP header", () => {
    const error = new Error("Cannot convert argument to a ByteString because the character at index 4 has a value of 26469");
    assert.equal(isFatalMainProcessError(recordFor("uncaughtException", error)), false);
  });

  it("does not restart the app for an unhandled rejection", () => {
    // A rejection is a promise nobody awaited, not a stack that unwound through the
    // loop: restarting would cost the user their session for a logged warning.
    assert.equal(isFatalMainProcessError(recordFor("unhandledRejection", new Error("nope"))), false);
  });
});
