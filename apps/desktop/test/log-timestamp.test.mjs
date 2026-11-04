import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { localTimestamp } = await import("../electron/main/log-timestamp.ts");

test("stamps local time with the machine's offset", () => {
  // A fixed local wall-clock instant (constructed from local parts, so the test
  // is about the format and not about the machine's zone).
  const date = new Date(2026, 10, 4, 22, 27, 1, 94);
  const stamp = localTimestamp(date);
  assert.match(stamp, /^2026-11-04T22:27:01\.094[+-]\d{2}:\d{2}$/);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const expectedOffset = `${sign}${String(Math.trunc(offsetMinutes / 60)).padStart(2, "0")}:${String(
    Math.abs(offsetMinutes % 60),
  ).padStart(2, "0")}`;
  assert.equal(stamp.slice(-6), expectedOffset);
});

test("stays a real instant: parsing it back yields the same millisecond", () => {
  const date = new Date(2026, 0, 2, 3, 4, 5, 678);
  assert.equal(new Date(localTimestamp(date)).getTime(), date.getTime());
});

test("pads every field, including milliseconds", () => {
  const stamp = localTimestamp(new Date(2026, 0, 2, 3, 4, 5, 7));
  assert.match(stamp, /^2026-01-02T03:04:05\.007[+-]\d{2}:\d{2}$/);
});

test("defaults to now", () => {
  const before = Date.now();
  const parsed = new Date(localTimestamp()).getTime();
  const after = Date.now();
  assert.ok(parsed >= before && parsed <= after, `${parsed} not within [${before}, ${after}]`);
});

test("every log line this app writes is stamped by it", async () => {
  // The four record writers are the surface a human reads; a UTC `Z` stamp here
  // is what made a review that ran at 21:53 look like one that never ran.
  const { readFile } = await import("node:fs/promises");
  for (const file of [
    "../electron/main/logger.ts",
    "../electron/main/agent-sidecar.ts",
    "../electron/main/host-process.ts",
    "../electron/main/main-process-errors.ts",
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /ts: localTimestamp\(\),/, `${file} must stamp local time`);
    assert.doesNotMatch(source, /ts: new Date\(\)\.toISOString\(\),/, `${file} still stamps UTC`);
  }
});
