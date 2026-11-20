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
  "agent.executeApprovedPlan",
  "agent.modeTurnNotice",
  "agent.stop",
  "agent.stopSubagents",
  "extensions.command.run",
  "native.session.fork",
  "native.session.get",
  "native.session.list",
  "native.session.search",
  "widget.clear",
  "widget.invoke",
  "widget.list",
  "widget.logs",
  "widget.sync",
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

test("a gap fails as UNSUPPORTED with a message a person can act on", () => {
  const error = kernelUnsupportedMethodError("agent.stop");
  assert.equal(error.errorCode, "UNSUPPORTED");
  assert.match(error.message, /^agent\.stop is not available on the Rust agent kernel yet/);
  assert.match(error.message, /graceful stop/);
  assert.match(error.message, /kernel: /);
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
    "agent.steer",
    "agent.steeringContext",
    "agent.compact",
    "agent.getStatus",
    "asktool.resolve",
    "sidecar.configure",
    "sidecar.health",
  ]) {
    assert.equal(isKernelUnsupportedMethod(method), false, `${method} is answered by the kernel`);
  }
});
