import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildZip, bundleFiles, crc32, redact } = await import("../main/diagnostics/bundle.ts");

/*
 * A diagnostics bundle is the one artifact that leaves the machine, so what it must
 * guarantee is narrow and testable: it opens as a zip, the same input produces the same
 * bytes, secrets are redacted, and no session content is in it - only row counts.
 */

const WINDOWS_HOME = String.raw`C:\Users\changan\AppData\x`;
const WINDOWS_HOME_REDACTED = String.raw`C:\Users\[user]\AppData\x`;
const DATA_DIR = String.raw`C:\Users\changan\AppData\Roaming\Pi`;

describe("redact", () => {
  it("removes bearer tokens and api keys", () => {
    assert.match(redact("Authorization: Bearer abcdef123456789"), /Bearer \[redacted\]/);
    assert.match(redact('api_key="sk-abcdef123456"'), /api_key=\[redacted\]/);
  });

  it("keeps a path's shape but not the user's name", () => {
    assert.equal(redact(WINDOWS_HOME), WINDOWS_HOME_REDACTED);
    assert.equal(redact("/home/changan/.config/x"), "/home/[user]/.config/x");
  });

  it("drops credentials embedded in a URL", () => {
    assert.equal(redact("https://user:pw@example.com/v1"), "https://[credentials]@example.com/v1");
  });
});

describe("crc32", () => {
  it("matches the reference value for 123456789", () => {
    // The canonical check value for this algorithm; if it drifts, every entry is
    // corrupt and no archive tool will open the bundle.
    assert.equal(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
  });
});

describe("buildZip", () => {
  it("writes a readable archive with one entry per file", () => {
    const zip = buildZip([
      { name: "summary.txt", content: "hello\n" },
      { name: "app.log.tail", content: "line\n" },
    ]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50, "starts with a local file header");
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "ends with the end record");
    assert.equal(zip.readUInt16LE(zip.length - 12), 2, "the end record counts both entries");
    const text = zip.toString("latin1");
    assert.ok(text.includes("summary.txt"));
    assert.ok(text.includes("app.log.tail"));
    assert.ok(text.includes("hello\n"));
  });

  it("is byte-identical for identical input", () => {
    const files = [{ name: "a.txt", content: "same\n" }];
    assert.deepEqual(buildZip(files), buildZip(files));
  });
});

describe("bundleFiles", () => {
  const input = {
    appVersion: "0.21.0",
    platform: "win32 x64",
    dataDir: DATA_DIR,
    logLines: ["started", "token=abcdef123456", "crashed"],
    crashDumps: ["reports/crash-1.dmp"],
    tableCounts: { sessions: 28, messages: 5120 },
  };

  it("reports counts, never message content", () => {
    const files = bundleFiles(input, new Date("2026-11-17T00:00:00Z"));
    const summary = files.find((file) => file.name === "summary.txt").content;
    assert.match(summary, /sessions: 28/);
    assert.match(summary, /messages: 5120/);
    assert.match(summary, /crash dumps found: 1/);
    // The bundle is sent to someone else; row counts are the most it may say about a
    // conversation.
    assert.doesNotMatch(summary, /message text|content:/i);
  });

  it("redacts the log tail and the data directory", () => {
    const files = bundleFiles(input);
    const log = files.find((file) => file.name === "app.log.tail").content;
    assert.match(log, /token=\[redacted\]/);
    const summary = files.find((file) => file.name === "summary.txt").content;
    assert.ok(summary.includes(String.raw`C:\Users\[user]\AppData`), summary);
  });

  it("omits the log file entirely when there is nothing to attach", () => {
    const files = bundleFiles({ ...input, logLines: [] });
    assert.equal(files.some((file) => file.name === "app.log.tail"), false);
  });
});
