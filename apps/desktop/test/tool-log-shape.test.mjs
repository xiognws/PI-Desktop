import assert from "node:assert/strict";
import test from "node:test";

import { shellCommandShape } from "../electron/main/runtime/tool-log-shape.ts";

test("summarizes a shell command by its first word and size", () => {
  const command = "grep -rn TODO src";
  const shape = shellCommandShape("Bash", { command });
  assert.deepEqual(shape, { head: "grep", length: command.length, lines: 1 });
});

test("never carries the command line, only its shape", () => {
  const shape = shellCommandShape("Bash", {
    command: "curl -H 'Authorization: Bearer sk-live-SECRET' https://example.test",
  });
  assert.equal(shape?.head, "curl");
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes("SECRET"), false);
  assert.equal(serialized.includes("example.test"), false);
});

test("counts the lines a batched command spans", () => {
  const command = "cd app\ngit status\ngit diff";
  const shape = shellCommandShape("Bash", { command });
  assert.deepEqual(shape, { head: "cd", length: command.length, lines: 3 });
});

test("strips a leading path from the interpreter or tool name", () => {
  assert.equal(shellCommandShape("Bash", { command: "/usr/bin/rg pattern" })?.head, "rg");
  assert.equal(
    shellCommandShape("Bash", { command: "C:\\tools\\rg.exe pattern" })?.head,
    "rg.exe",
  );
});

test("ignores the tool for a non-shell tool and for an empty command", () => {
  assert.equal(shellCommandShape("Read", { file_path: "a.txt" }), undefined);
  assert.equal(shellCommandShape("Bash", { command: "   " }), undefined);
  assert.equal(shellCommandShape("Bash", {}), undefined);
  assert.equal(shellCommandShape("Bash", undefined), undefined);
  assert.equal(shellCommandShape(undefined, { command: "ls" }), undefined);
});

test("accepts the tool name in any casing", () => {
  assert.equal(shellCommandShape("bash", { command: "ls -la" })?.head, "ls");
  assert.equal(shellCommandShape("BASH", { command: "ls -la" })?.head, "ls");
});

test("shortens an oversized first word", () => {
  const shape = shellCommandShape("Bash", { command: `${"x".repeat(80)} --flag` });
  assert.equal(shape?.head, "x".repeat(24));
});
