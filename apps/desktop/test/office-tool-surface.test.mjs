import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The Office tools are declared in three places that must agree: the builtin
 * tool list per mode, the parameter schema the model is handed, and the
 * description that tells it when to reach for one. A mismatch here stays
 * invisible until a session tries to call a tool that was never offered, so the
 * three are asserted together.
 *
 * The source is read rather than the module imported: the declaration tables sit
 * inside a large runtime module, and importing it would drag the whole agent
 * loop into a surface check.
 */
const runtimeSource = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "packages", "agent-runtime", "src", "runtime.ts"),
  "utf8",
);

test("every mode offers both Office tools", () => {
  const builtinsAt = runtimeSource.indexOf("const builtins");
  assert.ok(builtinsAt > 0, "the builtin tool list is where this test expects");
  // The two branches of the `tools` ternary: one per mode. Anchor on the
  // declaration itself — `this.mode === "agent"` also appears earlier in the
  // file (skill-writing rules), which used to widen this slice.
  const start = runtimeSource.lastIndexOf("const tools =", builtinsAt);
  assert.ok(start > 0, "the tools list declaration must precede `const builtins`");
  const block = runtimeSource.slice(start, builtinsAt);
  // Once for the agent list, once for the contract-mode list.
  assert.equal(block.match(/"OfficeRead"/g)?.length, 2);
  assert.equal(block.match(/"OfficeWrite"/g)?.length, 2);
});

test("the format list is closed, so an unsupported extension never reaches Python", () => {
  const start = runtimeSource.indexOf("OfficeRead: {");
  assert.ok(start > 0);
  const schema = runtimeSource.slice(start, runtimeSource.indexOf("OfficeWrite: {", start));
  for (const format of ["xlsx", "docx", "pptx", "pdf"]) {
    assert.match(schema, new RegExp(`Type\\.Literal\\("${format}"\\)`));
  }
});

test("both tools describe where the runtime comes from and what they cannot do", () => {
  const start = runtimeSource.indexOf('case "OfficeRead":');
  assert.ok(start > 0);
  const body = runtimeSource.slice(start, runtimeSource.indexOf('case "Bash":', start));
  assert.match(body, /Python/);
  assert.match(body, /tracked changes/);
  assert.ok(body.includes('case "OfficeWrite":'), "OfficeWrite is described too");
});
