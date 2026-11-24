/**
 * 退出判定（run-verdict）的契约测试。
 *
 * 用户问题的原话是「这次退出为什么，正常还是异常，异常怎么退出的」——所以这里只锁
 * 一件可判定的事：给定留下的痕迹，判定必须落在闭集合里，并且优先说出具体原因，而不
 * 是最吓人的那个。真正的文件读取与启动接线要跑 Electron，由人工在重启时确认日志行。
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const { judgePreviousRun, previousRunVerdictLevel } = await import(
  "../../electron/main/run-verdict.ts"
);

const marker = { pid: 4242, startedAt: "2026-01-02T03:04:05.000+08:00", version: "0.21.0" };
const noDumps = { main: 0, renderer: 0, gpu: 0, utility: 0 };

test("没有残留标记即上一次是正常退出", () => {
  const verdict = judgePreviousRun({
    marker: null,
    lastExitReason: null,
    newCrashDumps: noDumps,
    mainProcessErrorSinceStart: false,
  });
  assert.equal(verdict.outcome, "clean");
  assert.deepEqual(verdict.evidence, ["run-marker"]);
  assert.equal(previousRunVerdictLevel(verdict), "info");
});

test("主进程 dump 或主进程异常判定为崩溃，并说明来源", () => {
  const byDump = judgePreviousRun({
    marker,
    lastExitReason: null,
    newCrashDumps: { ...noDumps, main: 1 },
    mainProcessErrorSinceStart: false,
  });
  assert.equal(byDump.outcome, "crash");
  assert.ok(byDump.evidence.includes("crash-dump"));
  assert.match(byDump.summary, /crash dump/);
  assert.equal(previousRunVerdictLevel(byDump), "error");

  const byThrow = judgePreviousRun({
    marker,
    lastExitReason: null,
    newCrashDumps: noDumps,
    mainProcessErrorSinceStart: true,
  });
  assert.equal(byThrow.outcome, "crash");
  assert.ok(byThrow.evidence.includes("app-log"));
  assert.match(byThrow.summary, /main-process error/);
});

test("主动退出带上原因，不被当成崩溃", () => {
  const verdict = judgePreviousRun({
    marker,
    lastExitReason: { at: "2026-01-02T04:00:00.000+08:00", reason: "storage unavailable: locked" },
    newCrashDumps: noDumps,
    mainProcessErrorSinceStart: false,
  });
  assert.equal(verdict.outcome, "deliberate");
  assert.ok(verdict.evidence.includes("exit-reason"));
  assert.match(verdict.summary, /storage unavailable: locked/);
  assert.equal(previousRunVerdictLevel(verdict), "warn");
});

test("无崩溃证据的残留标记判定为被终止，并保留 pid 与启动时间", () => {
  const verdict = judgePreviousRun({
    marker,
    lastExitReason: null,
    newCrashDumps: noDumps,
    mainProcessErrorSinceStart: false,
  });
  assert.equal(verdict.outcome, "killed");
  assert.equal(verdict.detail.pid, 4242);
  assert.equal(verdict.detail.startedAt, marker.startedAt);
  assert.match(verdict.summary, /without a graceful quit/);
});

test("只有子进程 dump 仍算被终止，但把 dump 作为上下文记录", () => {
  const verdict = judgePreviousRun({
    marker,
    lastExitReason: null,
    newCrashDumps: { ...noDumps, renderer: 2 },
    mainProcessErrorSinceStart: false,
  });
  assert.equal(verdict.outcome, "killed");
  assert.deepEqual(verdict.detail.newCrashDumps, { ...noDumps, renderer: 2 });
});

test("崩溃优先于主动退出原因：真的挂了就说挂了", () => {
  const verdict = judgePreviousRun({
    marker,
    lastExitReason: { at: "2026-01-02T04:00:00.000+08:00", reason: "storage maintenance finished" },
    newCrashDumps: { ...noDumps, main: 1 },
    mainProcessErrorSinceStart: false,
  });
  assert.equal(verdict.outcome, "crash");
});

test("本进程自己写的标记不算上一次运行，否则每次启动都误报被终止", () => {
  const verdict = judgePreviousRun({
    marker,
    selfPid: marker.pid,
    lastExitReason: null,
    newCrashDumps: noDumps,
    mainProcessErrorSinceStart: false,
  });
  assert.equal(verdict.outcome, "clean");
  assert.deepEqual(verdict.evidence, []);
  assert.equal(previousRunVerdictLevel(verdict), "info");
  assert.match(verdict.summary, /no previous run/);
});

test("别人的标记照旧判定，selfPid 不掩盖真正的异常退出", () => {
  const verdict = judgePreviousRun({
    marker,
    selfPid: marker.pid + 1,
    lastExitReason: null,
    newCrashDumps: noDumps,
    mainProcessErrorSinceStart: false,
  });
  assert.equal(verdict.outcome, "killed");
  assert.equal(verdict.detail.pid, marker.pid);
});
