/*
 * The autotest-framework package contract.
 *
 * This package is delivered through the product's widget mechanism, so it has to
 * satisfy two owners at once: its own build (reuse a package whose inputs did not
 * change) and the host (a v2 manifest, a python entry, within the caps that keep
 * a package a package).
 *
 * The tests build against a fixture checkout rather than the real one, so they
 * state the rules instead of depending on whatever the framework happens to
 * contain today.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const PKG = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = join(PKG, "scripts", "bundle.mjs");
const VERIFY = join(PKG, "scripts", "verify.mjs");

function run(script, args) {
  return execFileSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: PKG });
}

/**
 * A checkout shaped like the real framework, including the two directories that
 * must not be shipped.
 */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "pi-framework-src-"));
  const files = {
    "core/engine.py": "ENGINE = True\n",
    "libs/helpers.py": "HELPER = True\n",
    "hal/bus.py": "BUS = True\n",
    "utils/text.py": "def clean(value):\n    return value.strip()\n",
    // Residue that must never reach the package.
    "core/__pycache__/engine.cpython-312.pyc": "binary-ish",
    // Test assets and vendor binaries: excluded by path, not by size.
    "libs/sdb_convert/VIUFR/image.hex": "00 01 02",
    "libs/zcan/kerneldlls/zps.dll": "MZ",
  };
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

function plan(source) {
  const output = run(BUNDLE, ["--dry-run", "--source", source]);
  const read = (key) => {
    const match = output.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    assert.ok(match, `dry run must report ${key}:\n${output}`);
    return match[1].trim();
  };
  return { files: Number(read("files")), hash: read("inputHash") };
}

test("the package declares its own version, separate from the product", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  assert.equal(pkg.name, "@pi-workspace/autotest-framework");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test("the framework's dependency lock is its own, pinned, and says why", () => {
  const lock = JSON.parse(readFileSync(join(PKG, "requirements.lock.json"), "utf8"));
  // Sharing the Office stack is impossible, not merely undesirable: the two
  // resolve incompatible numpy majors. The lock records that so nobody merges
  // them later for tidiness.
  assert.match(lock["//whySeparate"], /numpy/);
  assert.equal(lock.python, "3.12");
  assert.ok(Array.isArray(lock.wheels) && lock.wheels.length > 0, "the lock carries the resolved set");
  // Every entry must be installable with `--require-hashes`: an exact version and
  // a digest, never a range.
  for (const wheel of lock.wheels) {
    assert.match(wheel.version, /^\d/, `${wheel.name} must pin an exact version`);
    assert.match(wheel.sha256, /^[0-9a-f]{64}$/, `${wheel.name} must carry a sha256`);
  }
});


test("the plan counts the whole framework, and only drops build residue", () => {
  const source = checkout();
  try {
    const { files } = plan(source);
    // Four source files plus the firmware image and the vendor DLL: the driver
    // distribution and the data the converter operates on are part of the
    // framework, so they ship with it. Only the .pyc is residue.
    assert.equal(files, 6);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("the input hash is stable, and moves when the source moves", () => {
  const source = checkout();
  try {
    const first = plan(source).hash;
    assert.equal(plan(source).hash, first, "unchanged inputs must not change the address");

    writeFileSync(join(source, "core/engine.py"), "ENGINE = False\n");
    assert.notEqual(plan(source).hash, first, "an edited source file is a different package");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("a missing checkout is skipped, not half-built", () => {
  // The skip notice goes to stderr: it is a warning about this build, not part
  // of the artifact description, so it must not pollute stdout parsing.
  const result = spawnSync(
    process.execPath,
    [BUNDLE, "--dry-run", "--source", join(tmpdir(), "pi-framework-does-not-exist")],
    { encoding: "utf8", cwd: PKG },
  );
  assert.equal(result.status, 0, "a missing checkout is not a build failure");
  assert.match(result.stderr, /skipping: the framework checkout is not at/);
});
test("the bundle writes no wall-clock field, so the same inputs produce the same bytes", () => {
  const source = readFileSync(BUNDLE, "utf8");
  assert.doesNotMatch(source, /builtAt:\s*new Date/);
  assert.match(source, /existing\.inputHash === inputHash/);
});
test("verify rejects a package that drifted from its manifest", () => {
  const source = checkout();
  const dist = join(PKG, "dist");
  try {
    rmSync(dist, { recursive: true, force: true });
    run(BUNDLE, ["--source", source]);
    // An intact package passes.
    assert.match(run(VERIFY, []), /verified: .* python entry, within the host caps/);

    // A file that no longer matches its digest is caught.
    writeFileSync(join(dist, "src", "core", "engine.py"), "ENGINE = 'tampered'\n");
    assert.throws(() => run(VERIFY, []), /NOT shippable/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
