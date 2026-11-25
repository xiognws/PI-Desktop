#!/usr/bin/env node
/**
 * Apply and verify the retired-capability list for bundled plugins.
 *
 * `apps/desktop/resources/plugins/**` is written by the marketplace sync, so a
 * capability we removed by hand returns on the next `sync-bundled-plugins`. This
 * step runs *after* the sync and *before* electron-builder: it deletes the files
 * listed in scripts/bundled-plugins-retired-capabilities.json, prunes their stale
 * checksum rows, and then proves the result — the files are gone and no remaining
 * source file mentions them. Running it twice is a no-op.
 *
 * Usage:
 *   node scripts/retire-bundled-plugin-capabilities.mjs            # apply + verify
 *   node scripts/retire-bundled-plugin-capabilities.mjs --check    # verify only
 *   node scripts/retire-bundled-plugin-capabilities.mjs --root <dir> --config <file>
 *
 * Exit code 1 means the tree still violates the list; the message names the file.
 */
import { readFileSync, existsSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CONFIG = "scripts/bundled-plugins-retired-capabilities.json";
const PLUGINS_DIR = join("apps", "desktop", "resources", "plugins");

/** Files large enough to be a bundled UI build are not source; skip them when
 *  looking for leftover references. Scanning them costs seconds and finds only
 *  minified noise. */
const MAX_SCAN_BYTES = 512 * 1024;
const SCAN_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".json", ".ps1"];

function parseArgs(argv) {
  const args = { check: false, root: REPO, config: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--root") args.root = resolve(argv[++i] ?? REPO);
    else if (arg === "--config") args.config = resolve(argv[++i] ?? "");
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.config ??= join(args.root, CONFIG);
  return args;
}

function loadConfig(file) {
  let document;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${relative(process.cwd(), file)}: ${error.message}`);
  }
  const retired = document?.retired;
  if (!retired || typeof retired !== "object" || Array.isArray(retired)) {
    throw new Error(`${file}: "retired" must be an object of plugin id -> relative file list`);
  }
  const normalized = {};
  for (const [id, paths] of Object.entries(retired)) {
    if (id.startsWith("//")) continue;
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error(`${file}: ${id} must list at least one file`);
    }
    for (const entry of paths) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(`${file}: ${id} has a non-string file entry`);
      }
      // No absolute paths and no escaping the plugin directory: this list is data,
      // and data must not be able to delete anything outside the plugin.
      if (entry.includes("..") || entry.startsWith("/") || entry.includes("\\")) {
        throw new Error(`${file}: ${id} entry "${entry}" must be a plain relative POSIX path`);
      }
    }
    normalized[id] = [...paths];
  }
  return normalized;
}

/** Every file that could still reference a retired path, minus generated bundles. */
function* sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (!SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    try {
      if (statSync(full).size > MAX_SCAN_BYTES) continue;
    } catch {
      continue;
    }
    yield full;
  }
}

function referencesIn(file, needles) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return needles.filter((needle) => text.includes(needle));
}

function pruneChecksums(pluginDir, retiredPaths, log) {
  const file = join(pluginDir, "checksums.json");
  if (!existsSync(file)) return;
  let document;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return; // Not ours to repair; the host does not read this file either.
  }
  // Two layouts ship in the wild: a flat file -> hash map, and a map of nested
  // tables. Both are handled, because the point of pruning is that the file must
  // not mention a retired path afterwards (the gate scans it like any other JSON).
  const nested = Object.values(document).filter(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );
  const tables = [document, ...nested];
  let removed = 0;
  for (const table of tables) {
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    for (const retired of retiredPaths) {
      if (Object.prototype.hasOwnProperty.call(table, retired)) {
        delete table[retired];
        removed += 1;
      }
      const withSlash = `./${retired}`;
      if (Object.prototype.hasOwnProperty.call(table, withSlash)) {
        delete table[withSlash];
        removed += 1;
      }
    }
  }
  if (removed === 0) return;
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  log(`  pruned ${removed} checksum row(s)`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const retired = loadConfig(args.config);
  const pluginsRoot = join(args.root, PLUGINS_DIR);
  const problems = [];
  const lines = [];

  for (const [id, paths] of Object.entries(retired)) {
    const pluginDir = join(pluginsRoot, id);
    if (!existsSync(pluginDir)) {
      // A tree that never expanded this plugin has nothing to retire.
      lines.push(`${id}: not present in this tree, nothing to do`);
      continue;
    }
    if (!args.check) pruneChecksums(pluginDir, paths, (line) => lines.push(line));
    for (const rel of paths) {
      const target = join(pluginDir, rel.split("/").join(sep));
      if (existsSync(target) && !args.check) {
        rmSync(target, { force: true });
        lines.push(`${id}: removed ${rel}`);
      }
      if (existsSync(target)) problems.push(`${id}: ${rel} is still present`);
    }
    const needles = paths.map((rel) => rel.split("/").pop());
    for (const file of sourceFiles(pluginDir)) {
      const hits = referencesIn(file, needles);
      if (hits.length > 0) {
        problems.push(
          `${id}: ${relative(args.root, file)} still references ${[...new Set(hits)].join(", ")}`,
        );
      }
    }
  }

  for (const line of lines) console.log(line);
  if (problems.length > 0) {
    console.error("\nretired-capability check failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nFix by deleting the reference (or by listing the new file in " + CONFIG + ").",
    );
    return 1;
  }
  console.log(
    `\n[retire-bundled-plugin-capabilities] ${Object.keys(retired).length} plugin(s) checked, ` +
      `${Object.values(retired).reduce((sum, list) => sum + list.length, 0)} file(s) retired, 0 violations`,
  );
  return 0;
}

process.exit(main());
