import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFrame, encodeFrame } from "../main/lsp/framing.ts";

/*
 * The framing codec decides whether a language server session stays in sync. What
 * must hold: a partial frame asks for more bytes instead of failing, a length is
 * counted in bytes rather than characters, a header without a usable length fails
 * loudly instead of stalling, and a second frame arriving in the same read is not
 * dropped.
 */

describe("encodeFrame / decodeFrame", () => {
  it("round trips a message", () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const bytes = encodeFrame(payload);
    const decoded = decodeFrame(bytes);
    assert.equal(decoded.kind, "frame");
    if (decoded.kind !== "frame") return;
    assert.equal(decoded.payload, payload);
    assert.equal(decoded.consumed, bytes.length);
  });

  it("counts bytes rather than characters", () => {
    // A Windows project path is the everyday case for a non-ASCII payload.
    const payload = JSON.stringify({ root: "D:\\代码\\项目" });
    const bytes = encodeFrame(payload);
    assert.ok(bytes.subarray(0, 40).toString("ascii").includes(`Content-Length: ${Buffer.byteLength(payload)}`));
    assert.ok(Buffer.byteLength(payload) > payload.length);
    const decoded = decodeFrame(bytes);
    assert.equal(decoded.kind, "frame");
    if (decoded.kind !== "frame") return;
    assert.equal(decoded.payload, payload);
  });

  it("asks for more bytes on a partial header", () => {
    assert.equal(decodeFrame(Buffer.from("Content-Length: 42")).kind, "incomplete");
  });

  it("asks for more bytes when the body is short", () => {
    const bytes = encodeFrame('{"a":1}');
    assert.equal(decodeFrame(bytes.subarray(0, bytes.length - 3)).kind, "incomplete");
  });

  it("fails instead of stalling when the length is missing", () => {
    const decoded = decodeFrame(Buffer.from("Content-Type: application/json\r\n\r\n{}"));
    assert.equal(decoded.kind, "error");
    if (decoded.kind !== "error") return;
    assert.match(decoded.message, /missing Content-Length/);
  });

  it("names the value when the length is not a number", () => {
    const decoded = decodeFrame(Buffer.from("Content-Length: twelve\r\n\r\n{}"));
    assert.equal(decoded.kind, "error");
    if (decoded.kind !== "error") return;
    assert.match(decoded.message, /twelve/);
  });

  it("does not lose a second frame carried in the same read", () => {
    const both = Buffer.concat([encodeFrame('{"id":1}'), encodeFrame('{"id":2}')]);
    const first = decodeFrame(both);
    assert.equal(first.kind, "frame");
    if (first.kind !== "frame") return;
    assert.equal(first.payload, '{"id":1}');
    const second = decodeFrame(both.subarray(first.consumed));
    assert.equal(second.kind, "frame");
    if (second.kind !== "frame") return;
    assert.equal(second.payload, '{"id":2}');
  });

  it("accepts a lowercase header name and ignores other headers", () => {
    const bytes = Buffer.from("Content-Type: application/vscode-jsonrpc\r\ncontent-length: 2\r\n\r\n{}");
    const decoded = decodeFrame(bytes);
    assert.equal(decoded.kind, "frame");
    if (decoded.kind !== "frame") return;
    assert.equal(decoded.payload, "{}");
    assert.equal(decoded.consumed, bytes.length);
  });
});
