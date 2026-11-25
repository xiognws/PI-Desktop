import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { attachRendererConsoleToStderr, rendererConsoleRecord, shouldRecordRendererConsole } =
  await import("../main/renderer-console.ts");

/*
 * The renderer reports failures through console, and this listener is what makes
 * them durable. What must not happen is the opposite: ordinary info/debug
 * progress flooding the diagnostics log, because a support log is read by a
 * person looking for a failure, not for a transcript.
 */

describe("shouldRecordRendererConsole", () => {
  it("keeps warnings and errors", () => {
    assert.equal(shouldRecordRendererConsole("warning"), true);
    assert.equal(shouldRecordRendererConsole("error"), true);
  });

  it("drops info and debug progress", () => {
    assert.equal(shouldRecordRendererConsole("info"), false);
    assert.equal(shouldRecordRendererConsole("debug"), false);
  });
});

describe("rendererConsoleRecord", () => {
  it("maps an error to the error level and keeps the source", () => {
    const record = rendererConsoleRecord({
      message: "UI crash",
      level: "error",
      lineNumber: 15,
      sourceId: "app://index.js",
    });
    assert.equal(record.level, "error");
    assert.equal(record.fields.event, "rendererConsole");
    assert.deepEqual(record.fields.data, {
      message: "UI crash",
      level: "error",
      source: "app://index.js:15",
    });
  });

  it("maps a warning to warn and tolerates a missing source", () => {
    const record = rendererConsoleRecord({
      message: "deprecated call",
      level: "warning",
      lineNumber: 0,
      sourceId: "",
    });
    assert.equal(record.level, "warn");
    assert.equal(record.fields.data.source, "");
  });

  it("records which surface logged, and omits it when unknown", () => {
    const withSurface = rendererConsoleRecord(
      {
        message: "panel crash",
        level: "error",
        lineNumber: 3,
        sourceId: "app://panel.js",
      },
      "plugin-panel:pi.token-insights",
    );
    assert.equal(withSurface.fields.data.surface, "plugin-panel:pi.token-insights");

    const withoutSurface = rendererConsoleRecord({
      message: "panel crash",
      level: "error",
      lineNumber: 3,
      sourceId: "app://panel.js",
    });
    assert.equal("surface" in withoutSurface.fields.data, false);
  });

  it("bounds an oversized message", () => {
    const record = rendererConsoleRecord({
      message: "x".repeat(5_000),
      level: "error",
      lineNumber: 1,
      sourceId: "app://index.js",
    });
    assert.equal(record.fields.data.message.length, 2_049);
    assert.ok(record.fields.data.message.endsWith("…"));
  });
});

/*
 * Storage maintenance is the one surface that runs before the file logger, so
 * it reports to stderr instead. The filter must still hold: this window is a
 * static page and its ordinary progress has nothing to say to a support log.
 */
describe("attachRendererConsoleToStderr", () => {
  it("writes a warning or error line to stderr and drops info", () => {
    const handlers = new Map();
    const contents = {
      on(type, listener) {
        handlers.set(type, listener);
      },
      removeListener(type, listener) {
        if (handlers.get(type) === listener) handlers.delete(type);
      },
      isDestroyed() {
        return false;
      },
    };
    const detach = attachRendererConsoleToStderr(contents, "storage-maintenance");

    const written = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    try {
      handlers.get("console-message")({
        message: "ordinary progress",
        level: "info",
        lineNumber: 1,
        sourceId: "app://storage.js",
      });
      handlers.get("console-message")({
        message: "disk write failed",
        level: "error",
        lineNumber: 7,
        sourceId: "app://storage.js",
      });
    } finally {
      process.stderr.write = original;
    }
    detach();

    assert.equal(written.length, 1);
    assert.ok(written[0].startsWith("error rendererConsole "));
    const payload = JSON.parse(written[0].slice("error rendererConsole ".length));
    assert.equal(payload.message, "disk write failed");
    assert.equal(payload.surface, "storage-maintenance");
    assert.equal(handlers.size, 0);
  });
});
