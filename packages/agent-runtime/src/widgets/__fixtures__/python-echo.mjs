// Protocol fixture for python-entry.test.ts.
//
// The bridge only speaks line-delimited JSON, so the fixture proves the plumbing
// with a node process standing in for the interpreter: no Python is needed to
// test framing, correlation, timeouts, or dispose.
process.stdout.write("fixture starting\n");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.action === "echo") {
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, value: request.args })}\n`);
    } else if (request.action === "boom") {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, ok: false, error: "kaboom" })}\n`,
      );
    } else if (request.action === "hang") {
      // Deliberately silent: the caller's deadline has to fire.
    } else if (request.action === "exit") {
      process.exit(3);
    }
  }
});
