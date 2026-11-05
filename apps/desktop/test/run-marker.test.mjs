import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  describeUnfinishedRun,
  parseRunMarker,
  readLastExitReason,
  readRunMarker,
  recordExitReason,
  runMarkerPath,
  setRunMarkerDirectory,
  writeRunMarker,
  clearRunMarker,
} = await import("../electron/main/run-marker.ts");

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "pi-run-marker-"));
  setRunMarkerDirectory(directory);
  try {
    return run(directory);
  } finally {
    setRunMarkerDirectory(null);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("parses a stored marker and rejects anything unusable", () => {
  assert.deepEqual(parseRunMarker('{"pid":42,"startedAt":"2026-11-05T15:41:29.003+08:00","version":"0.21.0"}'), {
    pid: 42,
    startedAt: "2026-11-05T15:41:29.003+08:00",
    version: "0.21.0",
  });
  assert.equal(parseRunMarker("not json"), null);
  assert.equal(parseRunMarker('{"startedAt":"2026-11-05T00:00:00+08:00"}'), null, "pid is required");
  assert.equal(parseRunMarker('{"pid":1,"startedAt":""}'), null, "empty start time is not usable");
  assert.deepEqual(parseRunMarker('{"pid":1,"startedAt":"t"}'), {
    pid: 1,
    startedAt: "t",
    version: "unknown",
  });
});

test("describes the previous run so the boot log can name it", () => {
  assert.equal(describeUnfinishedRun(null), null);
  const line = describeUnfinishedRun({ pid: 62240, startedAt: "2026-11-05T14:52:36.899+08:00", version: "0.21.0" });
  assert.match(line, /without a graceful quit/);
  assert.match(line, /pid 62240/);
  assert.match(line, /2026-11-05T14:52:36\.899\+08:00/);
});

test("a starting run writes a marker that a later boot can read", () => {
  withDirectory((directory) => {
    assert.equal(readRunMarker(), null, "nothing recorded yet");
    writeRunMarker("0.21.0");
    const marker = readRunMarker();
    assert.equal(marker?.pid, process.pid);
    assert.equal(marker?.version, "0.21.0");
    assert.match(marker?.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/);
    assert.match(readFileSync(runMarkerPath(directory), "utf8"), /"pid"/);
  });
});

test("a graceful quit clears the marker, so the next boot stays quiet", () => {
  withDirectory(() => {
    writeRunMarker("0.21.0");
    clearRunMarker();
    assert.equal(readRunMarker(), null);
    assert.equal(describeUnfinishedRun(readRunMarker()), null);
  });
});

test("a deliberate early exit records its reason for the next boot", () => {
  withDirectory(() => {
    recordExitReason("storage unavailable: drive offline");
    const last = readLastExitReason();
    assert.equal(last?.reason, "storage unavailable: drive offline");
    assert.match(last?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    recordExitReason("storage maintenance finished; relaunching");
    assert.equal(readLastExitReason()?.reason, "storage maintenance finished; relaunching");
  });
});

test("the marker helpers do nothing when no directory is known", () => {
  setRunMarkerDirectory(null);
  assert.equal(readRunMarker(), null);
  assert.doesNotThrow(() => writeRunMarker("0.21.0"));
  assert.doesNotThrow(() => recordExitReason("nowhere"));
  assert.doesNotThrow(() => clearRunMarker());
});
