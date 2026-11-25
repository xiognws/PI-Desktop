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

test("the shipped runtime is offered first, with its libraries already present", () => {
  const fx = fixture();
  try {
    const bundledRoot = join(fx.root, "resources", "python");
    const bundledExe = join(bundledRoot, "runtime", name);
    const sitePackages = join(bundledRoot, "site-packages");
    mkdirSync(join(bundledRoot, "runtime"), { recursive: true });
    mkdirSync(sitePackages, { recursive: true });
    writeFileSync(bundledExe, "");

    const candidates = scanPythonInstallations({
      env: { PATH: fx.bin },
      platform: process.platform,
      probeVersion: () => "3.12",
      // A user interpreter would report missing libraries here; the bundled one
      // must not depend on this probe at all, because its wheels reach it through
      // PYTHONPATH rather than its own site-packages.
      bundled: { path: bundledExe, version: "3.12", sitePackages },
    });

    assert.equal(candidates[0].path, bundledExe, "the shipped runtime ranks first");
    assert.equal(candidates[0].source, "bundled");
    assert.equal(candidates[0].version, "3.12");
    assert.equal(
      candidates.filter((candidate) => candidate.path === bundledExe).length,
      1,
      "it must not also appear as a PATH or common-root find",
    );
  } finally {
    fx.cleanup();
  }
});

test("a build without a bundled site-packages counts zero libraries", () => {
  const fx = fixture();
  try {
    const bundledExe = join(fx.root, "resources", "python", "runtime", name);
    mkdirSync(join(fx.root, "resources", "python", "runtime"), { recursive: true });
    writeFileSync(bundledExe, "");

    const candidates = scanPythonInstallations({
      env: { PATH: "" },
      platform: process.platform,
      probeVersion: () => "3.12",
      bundled: { path: bundledExe, sitePackages: join(fx.root, "nowhere") },
    });

    assert.equal(candidates[0].source, "bundled");
    // A missing site-packages is a zero, not a crash: the row still offers the
    // interpreter, the count just says there is nothing beside it.
    assert.equal(candidates[0].libraryCount, 0);
  } finally {
    fx.cleanup();
  }
});

test("finds PATH and common install roots, deduped, best first", () => {
  const fx = fixture();
  try {
    const candidates = scanPythonInstallations({
      env: { PATH: fx.bin },
      platform: process.platform,
      extraRoots: [join(fx.root, "Programs", "Python")],
      probeVersion: () => "3.12",
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
    });
    const launcher = candidates.find((candidate) => candidate.path === fx.inPrograms);
    assert.ok(launcher, "the launcher-registered interpreter is missing");
    assert.equal(launcher.source, "launcher");
  } finally {
    fx.cleanup();
  }
});

test("a Python directory of the user's own naming is found on the drive root", () => {
  // `C:\Python3119` is what a machine looks like after a second minor version:
  // the launcher does not know it, PATH does not carry it, and no hard-coded root
  // matches. Reading the drive root is the only way the Settings list sees it.
  const fx = fixture();
  try {
    const custom = join(fx.root, "Python3119");
    mkdirSync(custom, { recursive: true });
    const exe = join(custom, name);
    writeFileSync(exe, "");

    const candidates = scanPythonInstallations({
      env: { PATH: "" },
      platform: process.platform,
      probeVersion: (path) => (path === exe ? "3.11" : undefined),
      driveRoots: [fx.root],
    });

    const found = candidates.find((candidate) => candidate.path === exe);
    assert.ok(found, "the custom-named install is offered");
    assert.equal(found.source, "common");
    assert.equal(found.version, "3.11");
  } finally {
    fx.cleanup();
  }
});

test("counts the distributions each interpreter can actually see", () => {
  const fx = fixture();
  try {
    // The bundled tree counts what ships in resources/python/site-packages.
    const bundledRoot = join(fx.root, "resources", "python");
    const bundledExe = join(bundledRoot, "runtime", name);
    const bundledSite = join(bundledRoot, "site-packages");
    mkdirSync(join(bundledRoot, "runtime"), { recursive: true });
    for (const dist of ["lxml-6.1.3.dist-info", "openpyxl-3.1.5.dist-info", "pip-26.2.1.dist-info"]) {
      mkdirSync(join(bundledSite, dist), { recursive: true });
    }
    writeFileSync(bundledExe, "");

    // A user interpreter counts the dist-info directories beside its own exe.
    const userRoot = join(fx.root, "Python3119");
    mkdirSync(join(userRoot, "Lib", "site-packages", "pandas-2.2.3.dist-info"), { recursive: true });
    mkdirSync(join(userRoot, "Lib", "site-packages", "numpy-2.5.4.dist-info"), { recursive: true });
    // A plain module and a cache directory are not libraries.
    mkdirSync(join(userRoot, "Lib", "site-packages", "__pycache__"), { recursive: true });
    writeFileSync(join(userRoot, "Lib", "site-packages", "single_file.py"), "");
    const userExe = join(userRoot, name);
    writeFileSync(userExe, "");

    const candidates = scanPythonInstallations({
      env: { PATH: "" },
      platform: "win32",
      probeVersion: (path) => (path === bundledExe ? "3.12" : path === userExe ? "3.11" : undefined),
      driveRoots: [fx.root],
      bundled: { path: bundledExe, version: "3.12", sitePackages: bundledSite },
    });

    assert.equal(candidates[0].libraryCount, 3, "the bundled tree counts its own wheel set");
    const user = candidates.find((candidate) => candidate.path === userExe);
    assert.ok(user, "the user interpreter is listed");
    assert.equal(user.libraryCount, 2, "only dist-info directories count as libraries");
  } finally {
    fx.cleanup();
  }
});
