import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { installRendererErrorReporting } = await import("../src/lib/renderer-errors.ts");

/*
 * A React error boundary only sees render failures. A throw in an event handler
 * or a rejected promise is otherwise invisible on a customer's machine, and the
 * console line this writes is what main mirrors into the diagnostics log.
 */

function fakeTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
}

function captureConsoleErrors(run) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

describe("installRendererErrorReporting", () => {
  it("reports an uncaught error with its message", () => {
    const target = fakeTarget();
    const uninstall = installRendererErrorReporting(target);
    const lines = captureConsoleErrors(() => {
      target.listeners.get("error")({ error: new Error("boom"), message: "" });
    });
    uninstall();

    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("[renderer] uncaught error:"));
    assert.match(lines[0], /boom/);
  });

  it("reports an unhandled rejection even when the reason is not an Error", () => {
    const target = fakeTarget();
    const uninstall = installRendererErrorReporting(target);
    const lines = captureConsoleErrors(() => {
      target.listeners.get("unhandledrejection")({ reason: "quota exceeded" });
    });
    uninstall();

    assert.equal(lines.length, 1);
    assert.equal(lines[0], "[renderer] unhandled rejection: quota exceeded");
  });

  it("stops reporting after uninstall", () => {
    const target = fakeTarget();
    const uninstall = installRendererErrorReporting(target);
    uninstall();

    assert.equal(target.listeners.size, 0);
  });
});
