import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { Dispatcher, pathToUri } = await import("../main/lsp/client.ts");

/*
 * Correlation is the part of an LSP client that goes wrong quietly: a misrouted
 * response looks like a wrong answer, not like a bug. These cases pin the rules:
 *
 *  - responses resolve by id, never by arrival order;
 *  - a response for an abandoned id is dropped instead of being given to the next
 *    caller (a timed-out request is still answered eventually);
 *  - a server-initiated request is answered, or the server waits forever;
 *  - garbage on the pipe is surfaced, not swallowed.
 */

function collect() {
  const replies = [];
  return { replies, reply: (payload) => replies.push(payload) };
}

describe("Dispatcher", () => {
  it("resolves the request that waits for the id, in any order", async () => {
    const { reply } = collect();
    const dispatcher = new Dispatcher(reply);
    const first = dispatcher.begin("a", 1_000);
    const second = dispatcher.begin("b", 1_000);
    assert.notEqual(first.id, second.id);

    // Second first: servers answer in whatever order they finish.
    assert.deepEqual(dispatcher.deliver(JSON.stringify({ jsonrpc: "2.0", id: second.id, result: 2 })), {
      kind: "response",
      id: second.id,
    });
    assert.deepEqual(dispatcher.deliver(JSON.stringify({ jsonrpc: "2.0", id: first.id, result: 1 })), {
      kind: "response",
      id: first.id,
    });
    assert.equal(JSON.parse(await first.response).result, 1);
    assert.equal(JSON.parse(await second.response).result, 2);
    assert.equal(dispatcher.pending, 0);
  });

  it("drops a response for an abandoned id instead of misrouting it", async () => {
    const { reply } = collect();
    const dispatcher = new Dispatcher(reply);
    const { id, response } = dispatcher.begin("slow", 10);
    await assert.rejects(response, /did not answer within 10ms/);
    assert.equal(dispatcher.pending, 0);

    assert.deepEqual(dispatcher.deliver(JSON.stringify({ jsonrpc: "2.0", id, result: "late" })), {
      kind: "orphan",
      id,
    });

    // The next request must not inherit that late answer.
    const next = dispatcher.begin("next", 1_000);
    assert.notEqual(next.id, id);
    assert.equal(dispatcher.pending, 1);
    // Left waiting on purpose above; release it so the test does not leave a
    // rejecting promise behind after it ends.
    dispatcher.abandon(next.id);
    assert.equal(dispatcher.pending, 0);
  });

  it("answers a server-initiated request and does not count it as a response", () => {
    const { replies, reply } = collect();
    const dispatcher = new Dispatcher(reply);
    assert.deepEqual(
      dispatcher.deliver(
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "window/workDoneProgress/create", params: {} }),
      ),
      { kind: "serverRequest", id: 9, method: "window/workDoneProgress/create" },
    );
    assert.equal(dispatcher.pending, 0);
    assert.equal(replies.length, 1);
    assert.equal(JSON.parse(replies[0]).id, 9);
    assert.equal(JSON.parse(replies[0]).result, null);
  });

  it("keeps the last diagnostics snapshot per method", () => {
    const { reply } = collect();
    const dispatcher = new Dispatcher(reply);
    const first = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { problems: 2 } };
    const second = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { problems: 0 } };
    dispatcher.deliver(JSON.stringify(first));
    dispatcher.deliver(JSON.stringify(second));
    assert.deepEqual(dispatcher.lastNotification("textDocument/publishDiagnostics"), JSON.stringify(second));
  });

  it("surfaces a payload that is not JSON-RPC", () => {
    const { reply } = collect();
    const dispatcher = new Dispatcher(reply);
    // A server printing a banner on stdout is a real failure mode; swallowing it
    // turns a broken server into a mysterious hang.
    assert.deepEqual(dispatcher.deliver("Starting rust-analyzer..."), { kind: "unparsed" });
  });

  it("rejects everything still waiting when the process dies", async () => {
    const { reply } = collect();
    const dispatcher = new Dispatcher(reply);
    const { response } = dispatcher.begin("definition", 30_000);
    dispatcher.failAll("the server exited (code=1 signal=null)");
    await assert.rejects(response, /the server exited/);
    assert.equal(dispatcher.pending, 0);
  });
});

describe("pathToUri", () => {
  it("turns a Windows path into a file URI", () => {
    assert.equal(pathToUri("D:\\Code\\PI-Desktop-main"), "file:///D:/Code/PI-Desktop-main");
  });

  it("keeps a POSIX path", () => {
    assert.equal(pathToUri("/home/user/project"), "file:///home/user/project");
  });

  it("percent-encodes a space", () => {
    // A project under "Program Files" is common on Windows, and a raw space makes
    // most servers reject the URI.
    assert.equal(pathToUri("C:\\Program Files\\app"), "file:///C:/Program%20Files/app");
  });
});
