/**
 * 运行标记（run-marker）的契约测试。
 *
 * 只锁一件在这里能判定的事：`entry.ts` 在看得到上一次运行的最后一刻把标记读走，
 * 之后自己写入的标记不会覆盖那份读到的内容；目录换掉时不许冒充自己的答案。真正的
 * 启动接线要跑 Electron，由重启时的日志行确认。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const {
  capturePreviousRunMarker,
  capturedPreviousRunMarker,
  readRunMarker,
  runMarkerPath,
  setRunMarkerDirectory,
  writeRunMarker,
} = await import("../../electron/main/run-marker.ts");

const previous = {
  pid: 111,
  startedAt: "2026-01-02T03:04:05.000+08:00",
  version: "0.21.0",
  lastSeenAt: "2026-01-02T03:05:05.000+08:00",
};

const tempDir = () => mkdtempSync(join(tmpdir(), "pi-run-marker-"));

test("capture 读到上一次的标记，自己写入之后仍然返回它", () => {
  const dir = tempDir();
  try {
    writeFileSync(runMarkerPath(dir), JSON.stringify(previous), "utf8");
    setRunMarkerDirectory(dir);
    capturePreviousRunMarker();
    writeRunMarker("0.21.0");

    const captured = capturedPreviousRunMarker(dir);
    assert.equal(captured.used, true);
    assert.equal(captured.marker?.pid, previous.pid);
    assert.equal(captured.marker?.lastSeenAt, previous.lastSeenAt);

    // 磁盘上此刻是本进程的标记——这正是重新读文件会把健康进程判成 killed 的原因。
    const onDisk = readRunMarker();
    assert.equal(onDisk?.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("目录不同就不冒充自己的答案，调用方退回直接读文件", () => {
  const dir = tempDir();
  const other = tempDir();
  try {
    writeFileSync(runMarkerPath(dir), JSON.stringify(previous), "utf8");
    setRunMarkerDirectory(dir);
    capturePreviousRunMarker();
    assert.deepEqual(capturedPreviousRunMarker(other), { used: false, marker: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("没有残留标记时 capture 是有效的空答案，不是“没读”", () => {
  const dir = tempDir();
  try {
    setRunMarkerDirectory(dir);
    capturePreviousRunMarker();
    assert.deepEqual(capturedPreviousRunMarker(dir), { used: true, marker: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
