/**
 * Contract tests for the launcher surface load retry.
 *
 * The launcher is prewarmed while boot is still allocating its first window and
 * the plugin host. On a small fraction of starts the `file://` navigation is
 * aborted within milliseconds (`ERR_FAILED (-2)`) and the same load succeeds on
 * the next attempt; without the retry the launcher stays unbuilt for the whole
 * session and every plugin panel behind it looks dead.
 *
 * Only an aborted navigation is retried. A missing file or an invalid URL is a
 * build defect and must surface immediately, or the retry would add a second of
 * delay to a failure nobody can recover from.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { isLauncherLoadRace, loadLauncherSurface } = await import(
  "../electron/main/launcher-surface-load.ts"
);

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const abortError = () =>
  new Error(
    "ERR_FAILED (-2) loading 'file:///D:\\Apps\\Pi-next\\resources\\app.asar\\out\\renderer\\index.html#surface=plugin-launcher'",
  );

test("only an aborted navigation counts as a boot race", () => {
  assert.equal(isLauncherLoadRace(abortError()), true);
  assert.equal(isLauncherLoadRace(new Error("ERR_ABORTED (-3) loading 'file:///x'")), true);
  // A real defect keeps its single attempt.
  assert.equal(
    isLauncherLoadRace(new Error("ERR_FILE_NOT_FOUND (-6) loading 'file:///x/index.html'")),
    false,
  );
  assert.equal(isLauncherLoadRace(new Error("ERR_INVALID_URL (-300) loading 'file://'")), false);
  assert.equal(isLauncherLoadRace(undefined), false);
});

test("a load that lost the race is retried until it lands", async () => {
  const attempts = [];
  const waits = [];
  await loadLauncherSurface(
    async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length < 2) throw abortError();
    },
    { delayMs: 700, sleep: async (ms) => waits.push(ms) },
  );
  assert.equal(attempts.length, 2);
  assert.deepEqual(waits, [700]);
});

test("a real failure is not retried and keeps its own error", async () => {
  let calls = 0;
  const failure = new Error("ERR_FILE_NOT_FOUND (-6) loading 'file:///missing.html'");
  await assert.rejects(
    () =>
      loadLauncherSurface(
        async () => {
          calls += 1;
          throw failure;
        },
        { delayMs: 700, sleep: async () => {} },
      ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("the retry is bounded and reports the last failure", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    () =>
      loadLauncherSurface(
        async () => {
          calls += 1;
          throw abortError();
        },
        { attempts: 3, delayMs: 50, sleep: async (ms) => waits.push(ms) },
      ),
    /ERR_FAILED/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [50, 50]);
});

test("a recovered race is reported so it stays visible in the log", async () => {
  const retries = [];
  let calls = 0;
  await loadLauncherSurface(
    async () => {
      calls += 1;
      if (calls === 1) throw abortError();
    },
    {
      delayMs: 0,
      sleep: async () => {},
      onRetry: (info) => retries.push(info),
    },
  );
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].attempt, 1);
});

test("the launcher wires the retry and reports why a load failed", async () => {
  const launcher = await read("../electron/main/bootstrap/launcher.ts");
  assert.match(launcher, /loadLauncherSurface\(/);
  assert.match(launcher, /did-fail-load/);
  assert.match(launcher, /render-process-gone/);
  assert.match(launcher, /plugin\.launcher\.load\.failed/);
  // The window is still destroyed when every attempt failed, so a dead surface
  // cannot be cached as the launcher for the session.
  assert.match(launcher, /if \(!window\.isDestroyed\(\)\) window\.destroy\(\)/);
});
