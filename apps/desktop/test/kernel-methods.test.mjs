import assert from "node:assert/strict";
import test from "node:test";

const {
  KERNEL_UNSUPPORTED_METHODS,
  isKernelUnsupportedMethod,
  kernelUnsupportedMethodError,
} = await import("../electron/main/kernel/kernel-methods.ts");

/*
 * The kernel answers the same protocol as the Node sidecar but not the same
 * surface. Main must not receive a bare `-32601` for a surface a person is using:
 * these cases pin the table, the reason each gap carries, and the error shape the
 * UI classifies.
 */

const EXPECTED_GAPS = [
  // Empty on purpose. Every surface that used to sit here now has an owner that
  // can actually answer it: `widget.*` and `extensions.command.run` are run by
  // main when the kernel is the runtime (`widget-commands.ts`,
  // `agent-extensions.ts`), and `native.session.*` is answered in-process from
  // the legacy pi JSONL store (`native-sessions.ts`). A name reappearing here
  // means a surface went back to failing with UNSUPPORTED.
];

test("the gap table lists exactly the surfaces the kernel does not answer", () => {
  assert.deepEqual(Object.keys(KERNEL_UNSUPPORTED_METHODS).sort(), EXPECTED_GAPS);
});

test("every gap says what the surface is and where it is being closed", () => {
  for (const [method, gap] of Object.entries(KERNEL_UNSUPPORTED_METHODS)) {
    assert.ok(gap.surface.trim().length > 0, `${method} names its surface`);
    assert.ok(gap.pending.trim().length > 0, `${method} names where it is closed`);
  }
});

test("the legacy pi session store is not a kernel gap", () => {
  // These four read a JSONL file store the kernel never owns. Main answers them
  // in-process (`electron/main/native-sessions.ts`), so listing them here would
  // turn a user's existing conversations into an UNSUPPORTED error.
  for (const method of [
    "native.session.list",
    "native.session.search",
    "native.session.get",
    "native.session.fork",
  ]) {
    assert.equal(isKernelUnsupportedMethod(method), false, `${method} is answered in main`);
  }
});

test("the widget surfaces are answered by main, so they are not kernel gaps", () => {
  // A widget package is JavaScript and the kernel is not a JS host: listing
  // these as gaps would turn a working Tools page into UNSUPPORTED the moment
  // the kernel became the runtime. Main runs them itself instead.
  for (const method of [
    "widget.list",
    "widget.sync",
    "widget.invoke",
    "widget.logs",
    "widget.clear",
    // The same rule, for the extension command precedent this follows.
    "extensions.command.run",
  ]) {
    assert.equal(isKernelUnsupportedMethod(method), false, `${method} is answered in main`);
  }
});

test("a method the table never listed still fails as UNSUPPORTED", () => {
  // The table is empty, so a stale method name reaches the kernel and fails
  // there. Main must still classify it, with a message that does not claim a
  // surface or a pending fix it does not have.
  const error = kernelUnsupportedMethodError("widget.imaginary");
  assert.equal(error.errorCode, "UNSUPPORTED");
  assert.match(error.message, /^widget\.imaginary is not answered by the Rust agent kernel$/);
});

test("an unknown method still fails as UNSUPPORTED instead of throwing something else", () => {
  const error = kernelUnsupportedMethodError("agent.imaginary");
  assert.equal(error.errorCode, "UNSUPPORTED");
  assert.match(error.message, /agent\.imaginary is not answered by the Rust agent kernel/);
});

test("methods the kernel does answer are not in the table", () => {
  for (const method of [
    "agent.prompt",
    "agent.abort",
    // The graceful stop is answered by the kernel: main forwards the renderer's
    // and the MCP client's `agent.stop` straight through, so this table must not
    // turn it into UNSUPPORTED.
    "agent.stop",
    "agent.steer",
    "agent.steeringContext",
    "agent.compact",
    "agent.getStatus",
    // Approved-plan execution is answered by the kernel now: main's
    // `agent.executeApprovedPlan` call must reach it instead of UNSUPPORTED.
    "agent.executeApprovedPlan",
    // A mode-run pause/release must reach the kernel too, or main's notice path
    // logs a failure for a run the kernel is already executing.
    "agent.modeTurnNotice",
    "asktool.resolve",
    "sidecar.configure",
    "sidecar.health",
  ]) {
    assert.equal(isKernelUnsupportedMethod(method), false, `${method} is answered by the kernel`);
  }
});
