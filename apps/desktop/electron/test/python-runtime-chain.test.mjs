import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { resolvePythonRuntime, pythonEnv, pythonStrategyFromEnv } = await import(
  "../main/python-runtime.ts"
);

/*
 * Which Python the app runs.
 *
 * The order is a product decision, not an implementation detail: a customer's own
 * interpreter knows their libraries, and the tree we ship exists so a machine
 * without Python still works. These cases pin the order, the capability gate that
 * keeps a bare `python` from replacing a working bundle, and the environment each
 * kind of interpreter needs.
 */

const isWin = process.platform === "win32";
const exeName = isWin ? "python.exe" : "bin/python3";
const venvExe = isWin ? "Scripts/python.exe" : "bin/python3";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "py-chain-"));
  const dataDir = join(root, "data");
  const resources = join(root, "resources");
  const bundled = join(resources, "python");
  mkdirSync(join(bundled, "runtime"), { recursive: true });
  writeFileSync(join(bundled, "runtime", exeName), "");
  mkdirSync(join(bundled, "site-packages"), { recursive: true });
  writeFileSync(
    join(bundled, "MANIFEST.json"),
    JSON.stringify({ schemaVersion: 1, python: "3.12.13", platform: "win32", wheels: [], files: [] }),
  );
  const systemBin = join(root, "bin");
  mkdirSync(systemBin, { recursive: true });
  writeFileSync(join(systemBin, isWin ? "python.exe" : "python3"), "");
  return {
    root,
    dataDir,
    resources,
    bundled,
    systemExe: join(systemBin, isWin ? "python.exe" : "python3"),
    env: { PATH: systemBin },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeVenv(dataDir, version = "3.12") {
  const venv = join(dataDir, "python", "venv");
  mkdirSync(join(venv, isWin ? "Scripts" : "bin"), { recursive: true });
  const exe = join(venv, venvExe);
  writeFileSync(exe, "");
  return { venv, exe, version };
}

test("an explicit path wins over everything", () => {
  const fx = fixture();
  try {
    const runtime = resolvePythonRuntime({
      dataDir: fx.dataDir,
      resourcesPath: fx.resources,
      env: { ...fx.env, PI_DESKTOP_PYTHON: fx.systemExe },
      probe: () => "3.13",
      canRunTools: () => true,
    });
    assert.equal(runtime.state, "present");
    assert.equal(runtime.runtime.source, "explicit");
    assert.equal(runtime.runtime.executable, fx.systemExe);
    // 3.13 cannot load the 3.12 wheels we ship, so the library dir stays empty.
    assert.equal(runtime.runtime.sitePackages, "");
    assert.equal(runtime.runtime.home, "");
  } finally {
    fx.cleanup();
  }
});

test("a venv the user owns beside the data beats the system Python and the bundle", () => {
  const fx = fixture();
  try {
    const venv = makeVenv(fx.dataDir);
    const runtime = resolvePythonRuntime({
      dataDir: fx.dataDir,
      resourcesPath: fx.resources,
      env: fx.env,
      probe: (executable) => (executable === venv.exe ? "3.12" : "3.11"),
      canRunTools: () => true,
    });
    assert.equal(runtime.runtime.source, "user-venv");
    assert.equal(runtime.runtime.executable, venv.exe);
    // Same 3.12 line as the bundle, so the bundled libraries are usable.
    assert.equal(runtime.runtime.sitePackages, join(fx.bundled, "site-packages"));
  } finally {
    fx.cleanup();
  }
});

test("the system Python is used only when it can already import the document libraries", () => {
  const fx = fixture();
  try {
    const usable = resolvePythonRuntime({
      dataDir: fx.dataDir,
      resourcesPath: fx.resources,
      env: fx.env,
      probe: () => "3.12",
      canRunTools: () => true,
    });
    assert.equal(usable.runtime.source, "system");

    const bare = resolvePythonRuntime({
      dataDir: fx.dataDir,
      resourcesPath: fx.resources,
      env: fx.env,
      probe: () => "3.12",
      canRunTools: () => false,
    });
    assert.equal(bare.runtime.source, "bundled", "a bare python must not replace the bundle");
    assert.equal(bare.runtime.home, join(fx.bundled, "runtime"));
  } finally {
    fx.cleanup();
  }
});

test("too old or not CPython is skipped", () => {
  const fx = fixture();
  try {
    for (const version of ["2.7", "3.9", undefined]) {
      const runtime = resolvePythonRuntime({
        dataDir: fx.dataDir,
        resourcesPath: fx.resources,
        env: fx.env,
        probe: () => version,
        canRunTools: () => true,
      });
      assert.equal(runtime.runtime.source, "bundled", `version ${version} should be skipped`);
    }
  } finally {
    fx.cleanup();
  }
});

test("strategy=bundled ignores the venv and the PATH", () => {
  const fx = fixture();
  try {
    makeVenv(fx.dataDir);
    const runtime = resolvePythonRuntime({
      dataDir: fx.dataDir,
      resourcesPath: fx.resources,
      env: fx.env,
      strategy: "bundled",
      probe: () => "3.12",
      canRunTools: () => true,
    });
    assert.equal(runtime.runtime.source, "bundled");
  } finally {
    fx.cleanup();
  }
});

test("strategy=system fails loudly instead of silently using the bundle", () => {
  const fx = fixture();
  try {
    const runtime = resolvePythonRuntime({
      dataDir: fx.dataDir,
      resourcesPath: fx.resources,
      env: { PATH: "" },
      strategy: "system",
      probe: () => "3.12",
      canRunTools: () => true,
    });
    assert.equal(runtime.state, "missing");
  } finally {
    fx.cleanup();
  }
});

test("the environment matches the interpreter kind", () => {
  const bundled = {
    root: "R",
    executable: "R/runtime/python.exe",
    home: "R/runtime",
    sitePackages: "R/site-packages",
    source: "bundled",
    assetsRoot: "R",
  };
  const bundledEnv = pythonEnv(bundled, ["D/python-site"]);
  assert.equal(bundledEnv.PYTHONHOME, "R/runtime");
  assert.equal(bundledEnv.PYTHONNOUSERSITE, "1");
  assert.match(bundledEnv.PYTHONPATH, /python-site/);
  assert.ok(bundledEnv.PYTHONPATH.indexOf("python-site") < bundledEnv.PYTHONPATH.indexOf("site-packages"));

  const system = {
    root: "sys",
    executable: "sys/python.exe",
    home: "",
    sitePackages: "",
    source: "system",
    assetsRoot: "R",
  };
  const systemEnv = pythonEnv(system, ["D/python-site"]);
  // Setting PYTHONHOME on an interpreter that owns its prefix breaks it, and
  // hiding the user site would discard the libraries that made it worth choosing.
  assert.equal(systemEnv.PYTHONHOME, undefined);
  assert.equal(systemEnv.PYTHONNOUSERSITE, undefined);
  assert.equal(systemEnv.PYTHONPATH, "D/python-site");
});

test("the strategy variable has three understood values", () => {
  assert.equal(pythonStrategyFromEnv({ PI_PYTHON_STRATEGY: "bundled" }), "bundled");
  assert.equal(pythonStrategyFromEnv({ PI_PYTHON_STRATEGY: "SYSTEM" }), "system");
  assert.equal(pythonStrategyFromEnv({ PI_PYTHON_STRATEGY: "nonsense" }), "auto");
  assert.equal(pythonStrategyFromEnv({}), "auto");
});
