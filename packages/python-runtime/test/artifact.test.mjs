/*
 * The python-runtime artifact contract.
 *
 * The package exists so a desktop build can say "I need python-runtime X" and
 * get the tree that was already built for those inputs, instead of re-creating
 * 182 MiB of identical bytes on every release. Three promises follow from that,
 * and none of them needs a real CPython to check:
 *
 *   1. the same inputs address the same artifact, and different inputs do not;
 *   2. the manifest carries no wall-clock field, so identical inputs stay
 *      byte-identical;
 *   3. verify catches a modified file and an undescribed extra file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = join(PKG, "scripts", "bundle.mjs");
const VERIFY = join(PKG, "scripts", "verify.mjs");

/** The hash the bundle would compute, without building anything. */
function inputHash() {
  const output = execFileSync(process.execPath, [BUNDLE, "--dry-run"], {
    encoding: "utf8",
    cwd: PKG,
  });
  const match = output.match(/inputHash:([0-9a-f]{64})/);
  assert.ok(match, `dry run must report an inputHash:\n${output}`);
  return match[1];
}

/** A tiny artifact that satisfies the verify contract. */
async function fixture(dir, { tamper } = {}) {
  const files = [
    { path: "runtime/python.exe", body: "interpreter" },
    { path: "site-packages/example/__init__.py", body: "x = 1\n" },
    { path: "tools/worker.py", body: "print('hi')\n" },
  ];
  const entries = [];
  for (const file of files) {
    const full = join(dir, file.path);
    await mkdir(join(full, ".."), { recursive: true });
    const body = tamper && file.path === tamper ? "tampered" : file.body;
    await writeFile(full, body);
    entries.push({
      path: file.path,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: Buffer.byteLength(body),
    });
  }
  await writeFile(
    join(dir, "MANIFEST.json"),
    JSON.stringify({ schemaVersion: 2, name: "fixture", version: "1.0.0", inputHash: "0".repeat(64), files: entries }),
  );
}

test("the input hash is stable for unchanged inputs", () => {
  const first = inputHash();
  const second = inputHash();
  assert.equal(first, second, "two dry runs over the same tree must agree");
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("the package declares its own version, separate from the product", async () => {
  const pkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8"));
  assert.equal(pkg.name, "@pi-workspace/python-runtime");
  // The artifact version is the interpreter release, not the app's version:
  // that separation is what lets the two be updated on different schedules.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test("the bundle refuses to write a wall-clock field into the manifest", async () => {
  const source = await readFile(BUNDLE, "utf8");
  // A `builtAt` would make identical inputs produce different bytes, which
  // defeats both the reuse and any content comparison downstream.
  assert.doesNotMatch(source, /builtAt:\s*new Date/);
  assert.match(source, /inputHash/);
  assert.match(source, /existing\.inputHash === inputHash/);
});

test("verify accepts an intact artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-pyrt-ok-"));
  try {
    await fixture(dir);
    const output = execFileSync(process.execPath, [VERIFY, dir], { encoding: "utf8" });
    assert.match(output, /verified: 3 files match the manifest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify rejects a file whose bytes changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-pyrt-tamper-"));
  try {
    await fixture(dir);
    await writeFile(join(dir, "site-packages/example/__init__.py"), "x = 2\n");
    assert.throws(
      () => execFileSync(process.execPath, [VERIFY, dir], { encoding: "utf8", stdio: "pipe" }),
      /NOT intact/,
      "a modified file must fail the check",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify rejects a file the manifest does not describe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-pyrt-extra-"));
  try {
    await fixture(dir);
    await writeFile(join(dir, "site-packages/stale.py"), "left over\n");
    assert.throws(
      () => execFileSync(process.execPath, [VERIFY, dir], { encoding: "utf8", stdio: "pipe" }),
      /NOT intact/,
      "a stale file surviving a rebuild must fail the check",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify reports a missing manifest instead of inventing one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-pyrt-empty-"));
  try {
    assert.throws(() => execFileSync(process.execPath, [VERIFY, dir], { encoding: "utf8", stdio: "pipe" }));
    assert.equal(existsSync(join(dir, "MANIFEST.json")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
