/**
 * Whether a crash on this machine would leave a dump (crash-report.ts).
 *
 * The report that prompted this: four runs that all ended `killed`, zero dumps, no
 * exit reason. `killed` also covers "it crashed and the handler was not there", and
 * nothing in the product could tell that apart from an external kill. These tests pin
 * the three ways the handler can be absent, so the boot line can say which.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { checkCrashReporterHealth } = await import("../electron/main/crash-report.ts");

function withDirs(run) {
  const root = mkdtempSync(join(tmpdir(), "pi-crash-health-"));
  const dumps = join(root, "crash-dumps");
  const executable = join(root, "app");
  mkdirSync(executable, { recursive: true });
  try {
    return run({ root, dumps, executable });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a writable dump directory with the handler beside the app is healthy", () => {
  withDirs(({ dumps, executable }) => {
    writeFileSync(join(executable, "chrome_crashpad_handler.exe"), "", "utf8");
    const health = checkCrashReporterHealth({
      crashDumpsDirectory: dumps,
      executableDirectory: executable,
      started: true,
      platform: "win32",
    });
    assert.deepEqual(health, { ok: true, problems: [] });
    // The probe must not leave anything behind for the next dump scan to count.
    assert.deepEqual(readdirSync(dumps), []);
  });
});

test("a missing handler is reported by path, not as a generic failure", () => {
  withDirs(({ dumps, executable }) => {
    const health = checkCrashReporterHealth({
      crashDumpsDirectory: dumps,
      executableDirectory: executable,
      started: true,
      platform: "win32",
    });
    assert.equal(health.ok, false);
    assert.equal(health.problems.length, 1);
    assert.match(health.problems[0], /crash handler is missing: .*chrome_crashpad_handler\.exe$/);
  });
});

test("a reporter that never started is unhealthy even when the files are in place", () => {
  withDirs(({ dumps, executable }) => {
    writeFileSync(join(executable, "chrome_crashpad_handler.exe"), "", "utf8");
    const health = checkCrashReporterHealth({
      crashDumpsDirectory: dumps,
      executableDirectory: executable,
      started: false,
      platform: "win32",
    });
    assert.equal(health.ok, false);
    assert.deepEqual(health.problems, ["crashReporter.start() did not run"]);
  });
});

test("an unwritable dumps directory is caught before anyone needs it", () => {
  withDirs(({ root, executable }) => {
    writeFileSync(join(executable, "chrome_crashpad_handler.exe"), "", "utf8");
    // A FILE where the directory should be: mkdir cannot fix that.
    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "", "utf8");
    const health = checkCrashReporterHealth({
      crashDumpsDirectory: blocked,
      executableDirectory: executable,
      started: true,
      platform: "win32",
    });
    assert.equal(health.ok, false);
    assert.match(health.problems.join("\n"), /crash dumps directory is not writable/);
  });
});

test("macOS does not report a missing handler, which lives inside the bundle", () => {
  withDirs(({ dumps, executable }) => {
    const health = checkCrashReporterHealth({
      crashDumpsDirectory: dumps,
      executableDirectory: executable,
      started: true,
      platform: "darwin",
    });
    assert.deepEqual(health, { ok: true, problems: [] });
  });
});

test("Electron 44 links Crashpad, so no handler file is expected", () => {
  // Measured on 44.9.3: the dist ships 19 files with no chrome_crashpad_handler.exe, and
  // electron.exe contains "crashpad". Demanding the file made every boot warn about a
  // crash it could not capture, which is how a real report gets ignored.
  withDirs(({ dumps, executable }) => {
    const health = checkCrashReporterHealth({
      crashDumpsDirectory: dumps,
      executableDirectory: executable,
      started: true,
      platform: "win32",
      electronVersion: "44.9.3",
    });
    assert.deepEqual(health, { ok: true, problems: [] });
  });
});

test("an Electron that ships the handler separately still reports it missing", () => {
  withDirs(({ dumps, executable }) => {
    const health = checkCrashReporterHealth({
      crashDumpsDirectory: dumps,
      executableDirectory: executable,
      started: true,
      platform: "win32",
      electronVersion: "22.3.27",
    });
    assert.equal(health.ok, false);
    assert.match(health.problems[0], /crash handler is missing/);
  });
});

test("an unreadable Electron version keeps the old expectation", () => {
  // A check that cannot tell which layout it is looking at must not silence itself.
  withDirs(({ dumps, executable }) => {
    const health = checkCrashReporterHealth({
      crashDumpsDirectory: dumps,
      executableDirectory: executable,
      started: true,
      platform: "win32",
      electronVersion: "not-a-version",
    });
    assert.equal(health.ok, false);
    assert.match(health.problems[0], /crash handler is missing/);
  });
});
