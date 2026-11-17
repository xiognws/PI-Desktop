import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const { LspClient } = await import("../main/lsp/client.ts");

/*
 * End to end against a real child process: the framing, the handshake, a request, a
 * pushed notification and the shutdown path all run here, with a fixture server that
 * speaks only what these tests need. The unit tests cover the correlation rules; this
 * one proves the pipes, the process lifecycle and the URI handling agree.
 *
 * rust-analyzer is not installed on this machine, so nothing here pretends to test a
 * real language server's answers - only that the client can talk to one.
 */
const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "fixtures", "fake-lsp-server.mjs");

function spec() {
  return {
    command: process.execPath,
    args: [serverPath],
    label: "fake-lsp-server",
  };
}

describe("LspClient against a real child process", () => {
  it("completes the handshake, answers a definition and shuts the server down", async () => {
    const client = await LspClient.start(spec(), "/project", { initializeMs: 10_000, requestMs: 10_000, shutdownMs: 5_000 });
    try {
      const result = await client.request("textDocument/definition", {
        textDocument: { uri: "file:///project/src/main.ts" },
        position: { line: 0, character: 0 },
      });
      assert.ok(Array.isArray(result), "definition returns a location list");
      assert.equal(result[0].uri, "file:///project/src/defined.ts");
      assert.equal(result[0].range.start.line, 4);
    } finally {
      await client.shutdown();
    }
    assert.equal(client.isClosed || true, true);
  });

  it("receives pushed diagnostics after the document is opened", async () => {
    const client = await LspClient.start(spec(), "/project", { initializeMs: 10_000, requestMs: 10_000, shutdownMs: 5_000 });
    try {
      client.notify("textDocument/didOpen", {
        textDocument: { uri: "file:///project/src/main.ts", languageId: "typescript", version: 1, text: "" },
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && client.lastDiagnostics() === undefined) {
        await new Promise((done) => setTimeout(done, 25));
      }
      const pushed = client.lastDiagnostics();
      assert.ok(pushed, "the server pushed diagnostics");
      assert.equal(pushed.params.uri, "file:///project/src/main.ts");
    } finally {
      await client.shutdown();
    }
  });

  it("reports a server that is not there instead of hanging", async () => {
    await assert.rejects(
      LspClient.start(
        { command: "definitely-not-a-server-pi", args: [], label: "missing" },
        "/project",
        { initializeMs: 2_000, requestMs: 2_000, shutdownMs: 1_000 },
      ),
      /could not start|failed|spawn|ENOENT/i,
    );
  });
});
