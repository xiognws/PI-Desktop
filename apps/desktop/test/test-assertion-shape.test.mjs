/**
 * Assertion shape in the workspace's own test files.
 *
 * Vitest reads an expectation's explanation from `expect(value, "why")`, not from
 * a second argument to the matcher — `toBe(value, "why")` is Jest's shape, and
 * its second argument does not type-check. It is a one-line mistake that has
 * landed twice in `packages/shared`, and each time it broke `tsc -p` for the whole
 * workspace: every packaging run died at "build workspace package dists" before
 * reaching the code it was supposed to ship.
 *
 * A broken file cannot report on itself — it does not compile — so the scan runs
 * from here, over the sources as text. Static checks are the point: this must not
 * depend on the file under test being importable.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const packagesRoot = join(repoRoot, "packages");

/** Matchers whose second argument must not be a string explanation. */
const MATCHERS = ["toBe", "toEqual", "toStrictEqual", "toMatch", "toContain", "toHaveLength"];

function testFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...testFiles(full));
      continue;
    }
    if (/\.test\.ts$/.test(entry.name)) found.push(full);
  }
  return found;
}

const offenders = [];
let scanned = 0;
for (const file of testFiles(packagesRoot)) {
  scanned += 1;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
    for (const matcher of MATCHERS) {
      // The first argument must be bracket-free: `toEqual(["one", "two"])` is a
      // two-element array, not a matcher with an explanation. A single value or a
      // property path is the shape that actually collides with Jest's `toBe`.
      const pattern = new RegExp(`\\.${matcher}\\([^()\\[\\]{}]*,\\s*["'\`]`);
      if (pattern.test(line)) {
        offenders.push(`${relative(repoRoot, file).split("\\").join("/")}:${index + 1}`);
      }
    }
  });
}

test("a package test never passes a string explanation to a matcher", () => {
  assert.ok(scanned > 0, "no package test files were scanned");
  assert.deepEqual(
    offenders,
    [],
    `these expectations do not type-check; write expect(value, "why").toBe(expected) instead:\n  ${offenders.join("\n  ")}`,
  );
});
