/**
 * 无 dump 时的取证报告（crash-forensics）契约测试。
 *
 * 锁三件事：报告落在 `crash-dumps/forensics`、里面同时有结构化细节与该跑的最后几行
 * 日志、以及只有 `killed` + 无主进程 dump 才值得写一份。写失败必须是"记一条、丢掉"，
 * 不能把崩溃变成第二次崩溃。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const {
  CRASH_FORENSICS_DIR_NAME,
  crashForensicsDirectory,
  missingDumpForensicsWanted,
  pruneCrashForensics,
  writeCrashForensicsReport,
} = await import("../../electron/main/crash-forensics.ts");

const tempDataDir = () => mkdtempSync(join(tmpdir(), "pi-crash-forensics-"));

/** A log tree the tail reader can actually walk. */
function seedLog(dataDir, line) {
  const directory = join(dataDir, "logs", "app");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "runtime.log"), `${line}\n`, "utf8");
}

test("报告写在 crash-dumps/forensics 下，带上细节与该跑的最后几行日志", () => {
  const dataDir = tempDataDir();
  try {
    seedLog(dataDir, '{"ts":"2026-11-24T16:42:54","event":"tool.execution.failed"}');
    const path = writeCrashForensicsReport(dataDir, {
      kind: "previous-run-vanished",
      detail: { outcome: "killed", pid: 4242 },
    });
    assert.ok(path, "a report must be written");
    assert.equal(existsSync(path), true);
    assert.equal(dirname(path), join(dataDir, "crash-dumps", CRASH_FORENSICS_DIR_NAME));

    const report = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(report.kind, "previous-run-vanished");
    assert.equal(report.pid, process.pid);
    assert.deepEqual(report.detail, { outcome: "killed", pid: 4242 });
    assert.deepEqual(report.dumps, [], "an empty dump list is recorded, not omitted");
    assert.ok(
      report.logTail.some((line) => line.includes("tool.execution.failed")),
      `the run's own last lines must be in the report, got ${JSON.stringify(report.logTail)}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("只有 killed 且没有主进程 dump 才需要写一份", () => {
  assert.equal(missingDumpForensicsWanted("killed", 0), true);
  assert.equal(missingDumpForensicsWanted("killed", 1), false, "a main dump already explains it");
  assert.equal(missingDumpForensicsWanted("crash", 0), false);
  assert.equal(missingDumpForensicsWanted("deliberate", 0), false);
  assert.equal(missingDumpForensicsWanted("clean", 0), false);
});

test("报告数量有上限，最老的先丢", () => {
  const dataDir = tempDataDir();
  try {
    const directory = crashForensicsDirectory(dataDir);
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(directory, `2026-01-0${index + 1}T00-00-00-000-0000-renderer-gone.json`), "{}", "utf8");
    }
    pruneCrashForensics(dataDir, 3);
    const kept = readdirSync(directory).sort();
    assert.equal(kept.length, 3);
    assert.equal(kept[0].startsWith("2026-01-04"), true, `kept ${JSON.stringify(kept)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("写不进去时返回 null，不抛异常", () => {
  const dataDir = tempDataDir();
  try {
    // `crash-dumps` as a file: the forensics directory cannot be created.
    writeFileSync(join(dataDir, "crash-dumps"), "not a directory", "utf8");
    const logged = [];
    const path = writeCrashForensicsReport(
      dataDir,
      { kind: "child-exited", detail: { component: "host" } },
      (level, message) => logged.push([level, message]),
    );
    assert.equal(path, null);
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "info");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
