import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { scanPythonInstallations } = await import("../main/python-scan.ts");

/*
 * The Settings → System → Python list.
 *
 * What matters is that the list answers three questions per row — which file,
 * what version, and can it import the document libraries — and that it does not
 * offer the same interpreter twice or offer one that does not run.
 */

const isWin = process.platform === "win32";
const name = isWin ? "python.exe" : "python3";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "py-scan-"));
  const bin = join(root, "bin");
  const programs = join(root, "Programs", "Python");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(programs, "Python312"), { recursive: true });
  const onPath = join(bin, name);
  const inPrograms = join(programs, "Python312", name);
  writeFileSync(onPath, "");
  writeFileSync(inPrograms, "");
  return {
    root,
    bin,
    onPath,
    inPrograms,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("finds PATH and common install roots, deduped, best first", () => {
  const fx = fixture();
  try {
    const candidates = scanPythonInstallations({
      env: { PATH: fx.bin },
      platform: process.platform,
      extraRoots: [join(fx.root, "Programs", "Python")],
      probeVersion: () => "3.12",
      probeLibraries: () => true,
    });
    const paths = candidates.map((candidate) => candidate.path);
    // The machine may hold real interpreters in the usual roots (this one has a
    // `C:\Python310`), so assert containment and relative order rather than an
    // exact list.
    const onPathIndex = paths.indexOf(fx.onPath);
    const programsIndex = paths.indexOf(fx.inPrograms);
    assert.notEqual(onPathIndex, -1, "the PATH interpreter is missing");
    assert.notEqual(programsIndex, -1, "the Program Files interpreter is missing");
    assert.ok(onPathIndex < programsIndex, "PATH must rank above a common root");
    assert.equal(candidates[onPathIndex].source, "path");
    assert.equal(candidates[programsIndex].source, "common");
    assert.equal(
      candidates.filter((candidate) => candidate.path === fx.onPath).length,
      1,
      "the same file must not appear twice",
    );
  } finally {
    fx.cleanup();
  }
});

test("a file that cannot report a version is not offered", () => {
  const fx = fixture();
  try {
    const candidates = scanPythonInstallations({
      env: { PATH: fx.bin },
      platform: process.platform,
      probeVersion: (executable) => (executable === fx.onPath ? undefined : "3.11"),
      probeLibraries: () => false,
    });
    assert.equal(
      candidates.some((candidate) => candidate.path === fx.onPath),
      false,
      "a file that cannot answer must not be offered",
    );
  } finally {
    fx.cleanup();
  }
});

test("the configured interpreter is listed first and marked as such", () => {
  const fx = fixture();
  try {
    const candidates = scanPythonInstallations({
      env: { PATH: fx.bin },
      platform: process.platform,
      configured: fx.inPrograms,
      probeVersion: () => "3.12",
      probeLibraries: () => true,
    });
    assert.equal(candidates[0].path, fx.inPrograms);
    assert.equal(candidates[0].source, "configured");
    // It is the same file PATH would offer, and it appears once.
    assert.equal(candidates.filter((c) => c.path === fx.inPrograms).length, 1);
  } finally {
    fx.cleanup();
  }
});

test("a venv beside the data directory is offered before PATH", () => {
  const fx = fixture();
  try {
    const venv = join(fx.root, "data", "python", "venv");
    mkdirSync(join(venv, isWin ? "Scripts" : "bin"), { recursive: true });
    const venvExe = join(venv, isWin ? "Scripts/python.exe" : "bin/python3");
    writeFileSync(venvExe, "");
    const candidates = scanPythonInstallations({
      dataDir: join(fx.root, "data"),
      env: { PATH: fx.bin },
      platform: process.platform,
      probeVersion: () => "3.12",
      probeLibraries: () => true,
    });
    assert.equal(candidates[0].path, venvExe);
    assert.equal(candidates[0].source, "data-venv");
  } finally {
    fx.cleanup();
  }
});

test("the Microsoft Store alias directory is not scanned", () => {
  const fx = fixture();
  try {
    const store = join(fx.root, "WindowsApps");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "python.exe"), "");
    const candidates = scanPythonInstallations({
      env: { PATH: store },
      platform: "win32",
      probeVersion: () => "3.12",
      probeLibraries: () => true,
    });
    assert.equal(
      candidates.some((candidate) => candidate.path.startsWith(store)),
      false,
      "a Store stub is not an interpreter",
    );
  } finally {
    fx.cleanup();
  }
});

test("interpreter roots from the py launcher are offered as launcher entries", () => {
  const fx = fixture();
  try {
    const candidates = scanPythonInstallations({
      env: { PATH: fx.bin },
      platform: "win32",
      launcherPaths: [fx.inPrograms],
      probeVersion: () => "3.12",
      probeLibraries: () => true,
    });
    const launcher = candidates.find((candidate) => candidate.path === fx.inPrograms);
    assert.ok(launcher, "the launcher-registered interpreter is missing");
    assert.equal(launcher.source, "launcher");
  } finally {
    fx.cleanup();
  }
});
