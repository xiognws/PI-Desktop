/**
 * A minimal language server, for tests only.
 *
 * Speaks just enough of the protocol to prove the client end to end: it answers
 * `initialize`, replies to `textDocument/definition` out of order when asked twice,
 * pushes a `publishDiagnostics` notification after `didOpen`, and exits on
 * `shutdown`/`exit`. Nothing here is a substitute for rust-analyzer; it exists so the
 * session, the framing and the shutdown path are exercised against a real child
 * process instead of only against mocks.
 */
const frames = [];
let buffer = Buffer.alloc(0);

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n", 0, "ascii");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number.parseInt(match[1], 10);
    const start = headerEnd + 4;
    if (buffer.length - start < length) return;
    const payload = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);
    frames.push(payload);
    handle(payload);
  }
});

function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [{ uri: "file:///project/src/defined.ts", range: { start: { line: 4, character: 2 } } }],
    });
    return;
  }
  if (message.method === "textDocument/didOpen") {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: message.params.textDocument.uri, diagnostics: [] },
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
    return;
  }
  // A server-initiated request the client must answer, or this process waits.
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: null });
}
