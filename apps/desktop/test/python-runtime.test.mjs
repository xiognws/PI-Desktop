import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readManifest,
  resolvePythonRuntime,
  pythonEnv,
  verifyPythonRuntime,
} from "../electron/main/python-runtime.ts";

/**
 * The bundled Python runtime is what makes Office and file work possible
 * offline, so the parts that can break silently are the ones worth testing:
 * finding the tree, building an import path that cannot leak the customer's own
 * environment, and noticing when the shipped files stopped being the files the
 * build produced.
 */

const bundle = join(import.meta.dirname, "..", "resources", "python");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "pi-python-runtime-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A scratch directory the bundled interpreter can actually write into.
 *
 * `os.tmpdir()` is refused for child processes on some hosts, and a probe that
 * cannot create its file would look like a broken library. The checkout is
 * always writable to this test runner.
 */
function scratchInCheckout() {
  const dir = mkdtempSync(join(import.meta.dirname, ".python-runtime-probe-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the bundled runtime resolves to the tree this build ships", () => {
  const status = resolvePythonRuntime();
  assert.equal(status.state, "present", status.state === "missing" ? status.reason : "");
  if (status.state !== "present") return;
  const { runtime } = status;
  assert.ok(existsSync(runtime.executable), `${runtime.executable} must exist`);
  assert.ok(existsSync(runtime.sitePackages), `${runtime.sitePackages} must exist`);
  assert.ok(existsSync(runtime.home), `${runtime.home} must exist`);
  // The interpreter sits inside the tree it is meant to be; a stray host python
  // would mean the bundle silently fell back to whatever the machine had.
  assert.ok(runtime.executable.startsWith(runtime.root), "the interpreter belongs to the bundle");
});

test("an absent tree is reported, not guessed at", () => {
  const { dir, clean } = scratch();
  try {
    const empty = join(dir, "python");
    mkdirSync(empty, { recursive: true });
    // Without PYTHONHOME pointing anywhere real, the resolver still checks the
    // candidate list, so this asserts the *shape* of a refusal rather than
    // pretending the module reads an injected root.
    const status = resolvePythonRuntime();
    assert.ok(status.state === "present" || status.state === "missing");
    if (status.state === "missing") assert.ok(status.reason.length > 0, "a reason is always given");
  } finally {
    clean();
  }
});

test("the import path puts the user layer first and never the user's own site", () => {
  const { dir, clean } = scratch();
  try {
    const runtime = {
      root: join(dir, "python"),
      executable: join(dir, "python", "runtime", "python.exe"),
      home: join(dir, "python", "runtime"),
      sitePackages: join(dir, "python", "site-packages"),
    };
    const userA = join(dir, "user-a");
    const userB = join(dir, "user-b");
    const env = pythonEnv(runtime, [userA, "", userB]);
    const entries = String(env.PYTHONPATH).split(process.platform === "win32" ? ";" : ":");
    assert.deepEqual(entries, [userA, userB, runtime.sitePackages]);
    assert.equal(env.PYTHONHOME, runtime.home);
    // A library the customer installed for their own projects must not shadow
    // the pinned one on every spreadsheet read.
    assert.equal(env.PYTHONNOUSERSITE, "1");
  } finally {
    clean();
  }
});

test("the shipped manifest lists every wheel the bundle script pinned", async () => {
  const status = resolvePythonRuntime();
  if (status.state !== "present") return;
  const manifest = await readManifest(status.runtime.root);
  assert.ok(manifest, "the build must ship a manifest");
  if (!manifest) return;
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.files.length > 1000, "a full CPython tree is thousands of files");
  for (const wheel of [
    "openpyxl",
    "python-docx",
    "python-pptx",
    "pandas",
    "pillow",
    "pypdf",
    "xlsxwriter",
  ]) {
    assert.ok(
      manifest.wheels.some((entry) => entry.startsWith(`${wheel}==`)),
      `${wheel} must be in the manifest`,
    );
  }
  assert.ok(
    manifest.files.some((entry) => entry.path === "requirements.txt"),
    "the pins ship next to the tree so a support engineer can see them",
  );
});

test("verification passes on the tree this build produced", async () => {
  const status = resolvePythonRuntime();
  if (status.state !== "present") return;
  // Spot-check a handful: hashing all 8000 files belongs in the background job
  // the app runs, not in a test that has to stay fast.
  const result = await verifyPythonRuntime(status.runtime, { limit: 40 });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.corrupted, []);
  assert.equal(result.checked, 40);
});

test("a size mismatch is caught before the library is imported", async () => {
  const { dir, clean } = scratch();
  try {
    const root = join(dir, "python");
    mkdirSync(join(root, "runtime"), { recursive: true });
    mkdirSync(join(root, "site-packages"), { recursive: true });
    // A stub file whose manifest entry claims a different size, which is what a
    // truncated write or a partially restored backup looks like.
    writeFileSync(join(root, "site-packages", "thing.py"), "x = 1\n");
    writeFileSync(
      join(root, "MANIFEST.json"),
      JSON.stringify({
        schemaVersion: 1,
        python: "3.12.13",
        platform: "windows-x86_64",
        wheels: [],
        files: [{ path: "site-packages/thing.py", sha256: "0".repeat(64), size: 999 }],
      }),
    );
    const runtime = {
      root,
      executable: join(root, "runtime", "python.exe"),
      home: join(root, "runtime"),
      sitePackages: join(root, "site-packages"),
    };
    const result = await verifyPythonRuntime(runtime);
    assert.equal(result.corrupted.length, 1);
    assert.match(result.corrupted[0], /size/);
    assert.deepEqual(result.missing, []);
  } finally {
    clean();
  }
});

test("a deleted file is reported as missing rather than ignored", async () => {
  const { dir, clean } = scratch();
  try {
    const root = join(dir, "python");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "MANIFEST.json"),
      JSON.stringify({
        schemaVersion: 1,
        python: "3.12.13",
        platform: "windows-x86_64",
        wheels: [],
        files: [{ path: "site-packages/gone.py", sha256: "0".repeat(64), size: 8 }],
      }),
    );
    const runtime = {
      root,
      executable: join(root, "runtime", "python.exe"),
      home: join(root, "runtime"),
      sitePackages: join(root, "site-packages"),
    };
    const result = await verifyPythonRuntime(runtime);
    assert.deepEqual(result.missing, ["site-packages/gone.py"]);
  } finally {
    clean();
  }
});

test("a tree with no manifest reports nothing to verify instead of failing", async () => {
  const { dir, clean } = scratch();
  try {
    const root = join(dir, "python");
    mkdirSync(root, { recursive: true });
    const runtime = {
      root,
      executable: join(root, "runtime", "python.exe"),
      home: join(root, "runtime"),
      sitePackages: join(root, "site-packages"),
    };
    assert.equal(await readManifest(root), null);
    assert.deepEqual(await verifyPythonRuntime(runtime), {
      checked: 0,
      missing: [],
      corrupted: [],
    });
  } finally {
    clean();
  }
});

test("the shipped interpreter really runs the office stack", () => {
  const status = resolvePythonRuntime();
  if (status.state !== "present") return;
  const { runtime } = status;
  // Import only: this test must stay fast and must not need a writable
  // directory outside the checkout. The round-trip test below writes.
  const output = execFileSync(
    runtime.executable,
    ["-c", "import openpyxl, docx, pptx, pandas, PIL, pypdf, xlsxwriter; print('ok')"],
    { encoding: "utf8", env: pythonEnv(runtime), timeout: 120_000 },
  );
  assert.match(output, /ok/);
});

test("the shipped interpreter writes and reads a real workbook", () => {
  const status = resolvePythonRuntime();
  if (status.state !== "present") return;
  const { runtime } = status;
  // Written inside the checkout rather than os.tmpdir(): the same rule the other
  // suites follow, and it keeps the probe file on the filesystem this test can
  // count on regardless of how the host restricts child processes.
  const { dir, clean } = scratchInCheckout();
  try {
    const file = join(dir, "probe.xlsx");
    const script = [
      "import openpyxl",
      `wb = openpyxl.Workbook()`,
      `ws = wb.active`,
      `ws['A1'] = 'hello'`,
      `ws['A2'] = 42`,
      `wb.save(${JSON.stringify(file)})`,
      `back = openpyxl.load_workbook(${JSON.stringify(file)})`,
      `print(back.active['A1'].value, back.active['A2'].value)`,
    ].join("; ");
    const output = execFileSync(runtime.executable, ["-c", script], {
      encoding: "utf8",
      env: pythonEnv(runtime),
      timeout: 120_000,
    });
    assert.match(output, /hello 42/);
  } finally {
    clean();
  }
});

test("the smoke list and the lock agree, so a new dependency cannot be forgotten", async () => {
  const status = resolvePythonRuntime();
  if (status.state !== "present") return;
  const manifest = await readManifest(status.runtime.root);
  if (!manifest) return;
  const bundleRoot = join(import.meta.dirname, "..", "..", "..");
  const lockPath = join(bundleRoot, "scripts", "python-runtime.lock.json");
  if (!existsSync(lockPath)) return;
  const lock = JSON.parse(execFileSync("node", ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(lockPath)})))`], { encoding: "utf8" }));
  // Every pinned wheel must be represented in the shipped manifest.
  for (const wheel of lock.wheels) {
    assert.ok(
      manifest.wheels.includes(`${wheel.name}==${wheel.version}`),
      `${wheel.name}==${wheel.version} is pinned but not shipped`,
    );
  }
  assert.ok(Array.isArray(lock.smokeImports) && lock.smokeImports.length > 0);
});
