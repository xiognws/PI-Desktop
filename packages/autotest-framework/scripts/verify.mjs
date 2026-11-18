#!/usr/bin/env node
/**
 * Check a built framework package against the product's own rules.
 *
 * Two kinds of failure matter here, and both are cheaper to catch now than in a
 * customer's data directory:
 *
 *   integrity  every file matches its recorded sha256 and size, and nothing
 *              extra survived a rebuild;
 *   contract   the package still satisfies what the host enforces — a v2
 *              manifest naming a python entry, within the caps, with a
 *              widget.json the runner would accept.
 *
 * Usage:
 *   node scripts/verify.mjs            # verify dist/
 *   node scripts/verify.mjs <dir>      # verify a copied package
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(process.argv[2] ?? join(PKG, "dist"));

// The caps the host enforces (crates/host-core/src/widgets.rs). Duplicated
// deliberately: this check must fail a package that would be rejected on load,
// even if the host constants move.
const MAX_PACKAGE_FILES = 4096;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const SUPPORTED_API_VERSIONS = { min: 1, max: 2 };
const problems = [];
const note = (message) => problems.push(message);

const manifestPath = join(target, "MANIFEST.json");
if (!existsSync(manifestPath)) {
  console.error(`no MANIFEST.json in ${target} — run \`pnpm --filter @pi-workspace/autotest-framework bundle\` first`);
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

/* integrity */

const listed = new Set();
let bytes = 0;
for (const entry of manifest.files) {
  listed.add(entry.path);
  const file = join(target, entry.path);
  if (!existsSync(file)) {
    note(`${entry.path}: missing`);
    continue;
  }
  const content = await readFile(file);
  bytes += content.length;
  if (content.length !== entry.size) {
    note(`${entry.path}: size ${content.length}, expected ${entry.size}`);
    continue;
  }
  if (sha256(content) !== entry.sha256) {
    note(`${entry.path}: sha256 does not match the manifest`);
  }
}

for (const file of await walk(target)) {
  const path = rel(file);
  if (path === "MANIFEST.json" || path === "widget.json") continue;
  if (!listed.has(path)) note(`${path}: not described by the manifest`);
}

/* contract */

const widgetPath = join(target, "widget.json");
if (!existsSync(widgetPath)) {
  note("widget.json: missing — the host would not discover this package");
} else {
  let widget;
  try {
    widget = JSON.parse(await readFile(widgetPath, "utf8"));
  } catch (cause) {
    note(`widget.json: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (widget) {
    if (widget.schemaVersion !== 1) note(`widget.json: unsupported schemaVersion ${widget.schemaVersion}`);
    const version = widget.apiVersion;
    if (
      typeof version !== "number" ||
      version < SUPPORTED_API_VERSIONS.min ||
      version > SUPPORTED_API_VERSIONS.max
    ) {
      note(
        `widget.json: apiVersion ${version} outside ${SUPPORTED_API_VERSIONS.min}..=${SUPPORTED_API_VERSIONS.max}`,
      );
    }
    const runtime = widget.runtime;
    if (!runtime || typeof runtime !== "object") {
      note("widget.json: runtime is required for this package");
    } else {
      if (runtime.kind !== "python") note(`widget.json: expected a python runtime, got ${runtime.kind}`);
      if (typeof runtime.entry !== "string" || !runtime.entry.endsWith(".py")) {
        note(`widget.json: runtime.entry must be a .py file, got ${runtime.entry}`);
      } else if (!existsSync(join(target, runtime.entry))) {
        note(`widget.json: runtime.entry not in the package: ${runtime.entry}`);
      }
      for (const path of runtime.pythonPath ?? []) {
        if (!existsSync(join(target, path))) {
          note(`widget.json: pythonPath does not exist in the package: ${path}`);
        }
      }
    }
    if (!Array.isArray(widget.permissions) || !widget.permissions.length) {
      note("widget.json: a package that asks for nothing gets nothing");
    }
  }
}

/* caps */

if (manifest.files.length > MAX_PACKAGE_FILES) {
  note(`package has ${manifest.files.length} files; the host accepts at most ${MAX_PACKAGE_FILES}`);
}
if (bytes > MAX_PACKAGE_BYTES) {
  note(
    `package is ${(bytes / 1048576).toFixed(1)} MiB; the host accepts at most ` +
      `${MAX_PACKAGE_BYTES / 1048576} MiB`,
  );
}

if (problems.length) {
  console.error(`${manifest.name}@${manifest.version} is NOT shippable (${problems.length} problem(s)):`);
  for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  process.exit(1);
}

console.log(
  `${manifest.name}@${manifest.version} verified: ${manifest.files.length} files, ` +
    `${(bytes / 1048576).toFixed(2)} MiB, python entry, within the host caps`,
);
