#!/usr/bin/env node
/**
 * Re-check a built artifact against its own manifest.
 *
 * This is the same guarantee the app gives itself at runtime: every file listed
 * in `MANIFEST.json` must exist with the recorded size and sha256, and no file
 * may have appeared that the manifest does not describe. It runs here so a
 * broken artifact fails before it is copied into an installer, not on a
 * customer's machine.
 *
 * Usage:
 *   node scripts/verify.mjs            # verify dist/
 *   node scripts/verify.mjs <dir>      # verify a copied artifact
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(process.argv[2] ?? join(PKG, "dist"));
const manifestPath = join(target, "MANIFEST.json");

if (!existsSync(manifestPath)) {
  console.error(`no MANIFEST.json in ${target} — run \`pnpm --filter @pi-workspace/python-runtime bundle\` first`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const rel = (file) => relative(target, file).split(sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function walk(root) {
  const out = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await visit(root);
  return out;
}

const problems = [];
const listed = new Set();

for (const entry of manifest.files) {
  listed.add(entry.path);
  const file = join(target, entry.path);
  if (!existsSync(file)) {
    problems.push(`${entry.path}: missing`);
    continue;
  }
  const bytes = await readFile(file);
  if (bytes.length !== entry.size) {
    problems.push(`${entry.path}: size ${bytes.length}, expected ${entry.size}`);
    continue;
  }
  const digest = sha256(bytes);
  if (digest !== entry.sha256) {
    problems.push(`${entry.path}: sha256 ${digest.slice(0, 12)}…, expected ${entry.sha256.slice(0, 12)}…`);
  }
}

// An extra file means the artifact no longer matches what the manifest claims:
// either a stale file survived a rebuild, or something wrote into the tree.
for (const file of await walk(target)) {
  const path = rel(file);
  if (path !== "MANIFEST.json" && !listed.has(path)) {
    problems.push(`${path}: not described by the manifest`);
  }
}

if (problems.length) {
  console.error(`${manifest.name}@${manifest.version} is NOT intact (${problems.length} problem(s)):`);
  for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  process.exit(1);
}

console.log(
  `${manifest.name}@${manifest.version} verified: ${manifest.files.length} files match the manifest ` +
    `(inputHash ${String(manifest.inputHash).slice(0, 12)}…)`,
);
