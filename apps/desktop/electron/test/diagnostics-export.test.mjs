/**
 * Unit tests for the support-bundle export.
 *
 * The bundle's shape and redaction are covered in `diagnostics-bundle.test.mjs`.
 * What is checked here is the flow around it: where the counts come from, what
 * the save dialog's answer does, what the file is named, and that the pieces
 * read from disk — the log tail and the crash-dump listing — pick the files and
 * the lines a reader would want. No Electron, no host process, no user data
 * directory: the log tree is a temporary one this test builds.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const { bundleFileName, exportDiagnosticsBundle, readCounts } = await import(
  "../main/diagnostics/export.ts"
);
const { readLogTail } = await import("../main/logger.ts");
const { listCrashDumps } = await import("../main/crash-report.ts");

const HOME_DIR = String.raw`C:\Users\someone\AppData\Roaming\Pi`;
const GENERATED = new Date(2026, 10, 17, 14, 30, 5);

/** Whether the archive carries an entry with this name (stored, so plain text). */
function zipHas(bytes, entry) {
  return bytes.toString("latin1").includes(entry);
}

function scratchDir() {
  return mkdtempSync(join(tmpdir(), "pi-diagnostics-export-"));
}

describe("bundleFileName", () => {
  it("stamps the local time so the file sorts and dates itself", () => {
    assert.equal(bundleFileName(GENERATED), "pi-diagnostics-20261117-143005.zip");
  });
});

describe("readCounts", () => {
  it("names what the installation holds, and records what it could not ask", async () => {
    const asked = [];
    const host = {
      call: async (method, params) => {
        asked.push({ method, params });
        if (method === "session.list") return { sessions: [{}, {}, {}] };
        if (method === "projects.list") return { projects: [] };
        if (method === "mcp.list") throw new Error("service is down");
        return { rows: [{}] };
      },
    };

    const { counts, notes } = await readCounts(host);

    assert.equal(counts.sessions, 3);
    assert.equal(counts.projects, 0);
    assert.equal(counts.plugins, 1);
    // A failed list is a note in the summary, never a silent zero: a reader has
    // to be able to tell "none" from "could not ask".
    assert.equal("mcpServers" in counts, false);
    assert.deepEqual(notes, ["count unavailable: mcpServers"]);
    assert.deepEqual(
      asked.find((entry) => entry.method === "mcp.list").params,
      { level: "user" },
    );
  });

  it("says so when the local service is not running", async () => {
    const { counts, notes } = await readCounts(null);
    assert.deepEqual(counts, {});
    assert.equal(notes.length, 1);
    assert.match(notes[0], /local service is not running/);
  });
});

describe("exportDiagnosticsBundle", () => {
  function deps(overrides = {}) {
    const dir = scratchDir();
    const target = join(dir, "bundle.zip");
    const written = [];
    return {
      target,
      written,
      value: {
        dataDir: HOME_DIR,
        appVersion: "0.21.0",
        platform: "win32 x64",
        readCounts: async () => ({ counts: { sessions: 4 }, notes: [] }),
        chooseTarget: async () => target,
        writeBundle: async (path, bytes) => void written.push({ path, bytes }),
        now: () => GENERATED,
        logTail: () => ["app/lifecycle.log: started", "app/lifecycle.log: ready"],
        crashDumps: () => ["reports/crash-1.dmp"],
        ...overrides,
      },
    };
  }

  it("writes a zip of the summary and the log tail where the user chose", async () => {
    const { target, written, value } = deps();

    const result = await exportDiagnosticsBundle(value);

    assert.deepEqual(result, {
      ok: true,
      path: target,
      files: 2,
      bytes: written[0].bytes.length,
    });
    assert.equal(written.length, 1);
    assert.equal(written[0].path, target);

    const text = written[0].bytes.toString("latin1");
    assert.ok(zipHas(written[0].bytes, "summary.txt"), "the summary is attached");
    assert.ok(zipHas(written[0].bytes, "app.log.tail"), "the log tail is attached");
    assert.match(text, /app version: 0\.21\.0/);
    assert.match(text, /sessions: 4/);
    assert.match(text, /reports\/crash-1\.dmp/);
    assert.ok(text.includes(String.raw`C:\Users\[user]\AppData\Roaming\Pi`), text);
    assert.equal(text.includes("someone"), false, "the user name is not in the archive");
  });

  it("suggests a dated file name and never invents one of its own", async () => {
    let suggested = null;
    const { value } = deps({
      chooseTarget: async (name) => {
        suggested = name;
        return null;
      },
    });

    const result = await exportDiagnosticsBundle(value);

    assert.equal(suggested, "pi-diagnostics-20261117-143005.zip");
    assert.deepEqual(result, { ok: false, reason: "canceled" });
  });

  it("writes nothing when the save dialog is dismissed", async () => {
    const { written, value } = deps({ chooseTarget: async () => null });

    await exportDiagnosticsBundle(value);

    assert.deepEqual(written, []);
  });
});

describe("readLogTail", () => {
  function logTree() {
    const dataDir = scratchDir();
    const app = join(dataDir, "logs", "app");
    const host = join(dataDir, "logs", "host");
    mkdirSync(app, { recursive: true });
    mkdirSync(host, { recursive: true });
    const lifecycle = join(app, "lifecycle.log");
    writeFileSync(lifecycle, '{"msg":"first"}\n{"msg":"second"}\n');
    writeFileSync(join(app, "session.1.log"), '{"msg":"rotated away"}\n');
    writeFileSync(join(host, "plugin.log"), '{"msg":"plugin"}\n');
    // Deterministic order: the channels are read oldest file first.
    utimesSync(lifecycle, new Date(2026, 10, 17, 9, 0, 0), new Date(2026, 10, 17, 9, 0, 0));
    utimesSync(
      join(host, "plugin.log"),
      new Date(2026, 10, 17, 10, 0, 0),
      new Date(2026, 10, 17, 10, 0, 0),
    );
    return dataDir;
  }

  it("reads the live files, says which file each line came from, and skips rotated copies", () => {
    const lines = readLogTail(logTree());

    assert.deepEqual(lines, [
      'app/lifecycle.log: {"msg":"first"}',
      'app/lifecycle.log: {"msg":"second"}',
      'host/plugin.log: {"msg":"plugin"}',
    ]);
  });

  it("keeps the newest lines when the tree is bigger than the bundle", () => {
    const lines = readLogTail(logTree(), { maxLinesPerFile: 1, maxLines: 2 });

    assert.deepEqual(lines, [
      'app/lifecycle.log: {"msg":"second"}',
      'host/plugin.log: {"msg":"plugin"}',
    ]);
  });

  it("reports nothing for a data directory that has never logged", () => {
    assert.deepEqual(readLogTail(scratchDir()), []);
  });
});

describe("listCrashDumps", () => {
  it("names the dumps newest first, relative to the dump root", () => {
    const dataDir = scratchDir();
    const reports = join(dataDir, "crash-dumps", "reports");
    mkdirSync(reports, { recursive: true });
    const older = join(reports, "crash-a.dmp");
    writeFileSync(older, "dmp");
    writeFileSync(join(reports, "crash-b.dmp"), "dmp");
    writeFileSync(join(reports, "notes.txt"), "not a dump");
    utimesSync(older, new Date(2026, 10, 16, 9, 0, 0), new Date(2026, 10, 16, 9, 0, 0));

    assert.deepEqual(listCrashDumps(join(dataDir, "crash-dumps")), [
      "reports/crash-b.dmp",
      "reports/crash-a.dmp",
    ]);
  });

  it("reports an empty list when Crashpad never wrote anything", () => {
    assert.deepEqual(listCrashDumps(join(scratchDir(), "crash-dumps")), []);
  });
});
