#!/usr/bin/env node
/**
 * Populate the plugins this build ships (`apps/desktop/resources/plugins`) from
 * the plugin marketplace, so an intranet install has every marketplace plugin
 * bundled instead of downloading them at first run.
 *
 * The host reconciles whatever sits in that directory against its registry on
 * every launch (ADR 0241 / ADR 0105), so expanding packages into one directory
 * per plugin id is the whole integration: no client code change, no catalog
 * source change.
 *
 * Usage:
 *   node scripts/sync-bundled-plugins.mjs                 # fetch + expand all
 *   node scripts/sync-bundled-plugins.mjs --dry-run       # report only
 *   node scripts/sync-bundled-plugins.mjs --only pi.todo,pi.gitlens
 *   node scripts/sync-bundled-plugins.mjs --from <dir>    # reuse mirrored .piplug files
 *
 * Package URLs resolve through `--base` when the catalog's own base is
 * unreachable: the corporate intranet cannot resolve raw.githubusercontent.com,
 * so the default base is the gh-proxy mirror of the catalog's declared base.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(REPO, "apps", "desktop", "resources", "plugins");
const OFFICIAL_CATALOG = "https://plugins.aiuo.net/catalog.json";
const PROXY_PREFIX = "https://gh-proxy.com/";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const DRY_RUN = has("dry-run");
const FORCE = has("force");
const KEEP_TESTS = has("keep-tests");
const STRIPPED_TEST_DIRS = new Set(["tests", "test", "__tests__", "spec", "specs"]);
const ONLY = (flag("only", "") || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const FROM = flag("from", "");
const JOBS = Number(flag("jobs", "6"));
const STAGING = join(REPO, ".plugin-packages");

/**
 * Plugin ids this repository already ships in-tree and tracks in git.
 *
 * A first-party plugin under `resources/plugins` can carry local patches (the
 * checked-in `pi.file-manager` is `0.5.3-pi.1`, not the marketplace's `0.9.0`),
 * so replacing it with the released package would silently drop those patches
 * and the upstream provenance files. Skipping is the safe default; `--force`
 * exists for a deliberate takeover.
 */
function trackedPluginIds() {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--", "apps/desktop/resources/plugins"],
      { cwd: REPO, encoding: "utf8" },
    );
    const ids = new Set();
    for (const line of output.split("\n")) {
      const rest = line.trim().replace(/^apps\/desktop\/resources\/plugins\//, "");
      const id = rest.split("/")[0];
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}
const TRACKED = trackedPluginIds();

/**
 * Plugin ids this build must never bundle.
 *
 * Declared in `scripts/bundled-plugins-excluded.json` so a deliberate removal
 * survives the next sync: without it, the catalog would expand the package
 * again and the host would show the plugin once more.
 */
function excludedPluginIds() {
  try {
    const text = readFileSync(join(REPO, "scripts", "bundled-plugins-excluded.json"), "utf8");
    const ids = JSON.parse(text).excluded;
    return new Set(
      (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id.trim()),
    );
  } catch (error) {
    throw new Error(`bundled-plugins-excluded.json: ${error.message}`);
  }
}
const EXCLUDED = excludedPluginIds();

function compareVersions(left, right) {
  const parse = (value) => {
    const text = String(value ?? "").trim().replace(/^v/, "").split("+")[0];
    const [core, pre] = text.split("-");
    const numbers = core.split(".").map((part) => Number(part));
    return { numbers, pre: pre ? pre.split(".") : [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.numbers.length, b.numbers.length); i += 1) {
    const x = a.numbers[i] ?? 0;
    const y = b.numbers[i] ?? 0;
    if (x !== y) return x - y;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && nx !== ny) return nx - ny;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Minimal store/deflate zip reader: `.piplug` files are zips with no extras. */
function readZipEntries(bytes) {
  const scanFrom = Math.max(0, bytes.length - 66000);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= scanFrom; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip: bad central header");
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressed);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`zip: unsupported compression ${method} for ${name}`);
    if (uncompressed && data.length !== uncompressed) throw new Error(`zip: size mismatch for ${name}`);
    entries.push({ name, data });
  }
  return entries;
}

function safeRelative(name) {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`zip: unsafe entry path ${name}`);
  }
  return normalized;
}

async function loadCatalog() {
  const catalogPath = flag("catalog", "");
  if (catalogPath) return JSON.parse(await readFile(catalogPath, "utf8"));
  const res = await fetch(OFFICIAL_CATALOG, { headers: { "user-agent": "pi-desktop-bundle-sync" } });
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
  return res.json();
}

const catalog = await loadCatalog();
const declaredBase = String(catalog.artifactBaseUrl ?? "").replace(/\/+$/, "");
const BASE = flag("base", declaredBase ? `${PROXY_PREFIX}${declaredBase}` : "");

const wanted = [];
for (const plugin of catalog.plugins) {
  if (EXCLUDED.has(plugin.id)) continue;
  if (ONLY.length && !ONLY.includes(plugin.id)) continue;
  const candidates = plugin.versions.filter(
    (version) => version.yanked !== true && version.shasum && version.url,
  );
  if (!candidates.length) continue;
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  wanted.push({ id: plugin.id, version: candidates[0].version, ...candidates[0] });
}

console.log(`target: ${TARGET}`);
console.log(
  `plugins: ${wanted.length}${ONLY.length ? ` (filtered: ${ONLY.join(", ")})` : ""}` +
    `${EXCLUDED.size ? ` (excluded: ${[...EXCLUDED].join(", ")})` : ""}`,
);
console.log(`packages: ${(wanted.reduce((sum, item) => sum + (item.sizeBytes || 0), 0) / 1048576).toFixed(1)} MiB`);
if (DRY_RUN) {
  for (const item of wanted) console.log(`  ${item.id}@${item.version} ${((item.sizeBytes || 0) / 1024).toFixed(0)} KiB`);
  process.exit(0);
}

// An excluded id can still sit on disk from an earlier sync. The host
// reconciles this directory rather than the catalog, so drop the leftover copy
// instead of letting it stay visible.
for (const id of EXCLUDED) {
  await rm(join(TARGET, id), { recursive: true, force: true });
}

await mkdir(STAGING, { recursive: true });

async function fetchPackage(item) {
  const file = join(STAGING, `${item.id}-${item.version}.piplug`);
  const local = FROM ? join(FROM, "packages", `${item.id}-${item.version}.piplug`) : "";
  if (local) {
    const bytes = await readFile(local);
    return { bytes, source: "from" };
  }
  const existing = await stat(file).catch(() => null);
  if (existing) {
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") === item.shasum) {
      return { bytes, source: "staging" };
    }
  }
  const relative = String(item.url).replace(/^\/+/, "");
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(relative)
    ? relative
    : `${BASE}/${relative.replace(/^packages\//, "packages/")}`;
  let lastError = "unknown";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(absolute, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== item.shasum) throw new Error(`sha256 mismatch (${digest})`);
      if (item.sizeBytes && bytes.length !== item.sizeBytes) throw new Error(`size mismatch ${bytes.length}`);
      await writeFile(file, bytes);
      return { bytes, source: "network" };
    } catch (error) {
      lastError = error.message;
      await new Promise((done) => setTimeout(done, 400 * attempt));
    }
  }
  throw new Error(`${item.id}@${item.version}: ${lastError}`);
}

let cursor = 0;
const results = [];
await Promise.all(
  Array.from({ length: Math.min(JOBS, wanted.length) }, async () => {
    while (cursor < wanted.length) {
      const item = wanted[cursor];
      cursor += 1;
      try {
        const { bytes, source } = await fetchPackage(item);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== item.shasum) throw new Error("sha256 mismatch");
        const entries = readZipEntries(bytes);
        const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
        if (!manifestEntry) throw new Error("package has no manifest.json");
        const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
        if (manifest.id !== item.id) throw new Error(`manifest id ${manifest.id} != catalog ${item.id}`);
        if (manifest.version !== item.version) {
          throw new Error(`manifest version ${manifest.version} != catalog ${item.version}`);
        }
        if (TRACKED.has(item.id) && !FORCE) {
          const current = await readFile(join(TARGET, item.id, "manifest.json"), "utf8")
            .then((text) => JSON.parse(text).version)
            .catch(() => "unknown");
          results.push({ ...item, ok: true, skipped: "tracked", inTreeVersion: current });
          continue;
        }
        const dest = join(TARGET, item.id);
        await rm(dest, { recursive: true, force: true });
        const writtenPaths = [];
        let stripped = 0;
        for (const entry of entries) {
          const relative = safeRelative(entry.name);
          // Test suites are not runtime assets, and they are what endpoint
          // protection heuristics flag inside a bundled copy: a published
          // `cn.star.computer-use` test file trips one on this build host and
          // gets deleted, leaving a half-written plugin. Dropping them at the
          // root (never nested runtime assets) keeps the shipped tree whole.
          if (!KEEP_TESTS && STRIPPED_TEST_DIRS.has(relative.split("/")[0])) {
            stripped += 1;
            continue;
          }
          const path = join(dest, ...relative.split("/"));
          if (!path.startsWith(dest + sep) && path !== dest) throw new Error(`zip: escapes target ${entry.name}`);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, entry.data);
          writtenPaths.push(relative);
        }
        results.push({ ...item, ok: true, source, files: writtenPaths.length, stripped, paths: writtenPaths });
      } catch (error) {
        results.push({ ...item, ok: false, error: error.message });
      }
      if (results.length % 10 === 0) console.log(`  ${results.length}/${wanted.length}`);
    }
  }),
);

const tracked = results.filter((item) => item.ok && item.skipped === "tracked");
const written = results.filter((item) => item.ok && !item.skipped && item.source !== "from");
const reused = results.filter((item) => item.ok && !item.skipped && item.source === "from");
const failed = results.filter((item) => !item.ok);

// Endpoint protection can delete a file milliseconds after it is written, so a
// successful write is not proof the bundled tree is complete. Re-read what the
// package announced and report anything that is no longer on disk.
const missing = [];
for (const item of [...written, ...reused]) {
  const lost = [];
  for (const relative of item.paths ?? []) {
    const present = await stat(join(TARGET, item.id, ...relative.split("/")))
      .then(() => true)
      .catch(() => false);
    if (!present) lost.push(relative);
  }
  if (lost.length) missing.push({ id: item.id, version: item.version, files: lost });
}

await writeFile(
  join(TARGET, ".bundled-plugins.json"),
  JSON.stringify(
    {
      syncedAt: new Date().toISOString(),
      catalogGeneratedAt: catalog.generatedAt ?? null,
      packageBase: BASE,
      testFilesStripped: [...written, ...reused].reduce((sum, item) => sum + (item.stripped ?? 0), 0),
      plugins: written
        .map((item) => ({ id: item.id, version: item.version, files: item.files }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      keptInTree: tracked
        .map((item) => ({ id: item.id, inTreeVersion: item.inTreeVersion, catalogVersion: item.version }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      failed: failed.map((item) => ({ id: item.id, version: item.version, error: item.error })),
      missing,
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `expanded: ${written.length + reused.length}/${results.length} (${written.length} downloaded, ${reused.length} reused), ` +
    `${tracked.length} kept in-tree, ${failed.length} failed, ${missing.length} incomplete`,
);
for (const item of tracked) {
  console.log(`  KEPT ${item.id}: in-tree ${item.inTreeVersion} (catalog ${item.version}) — use --force to replace`);
}
for (const item of failed) {
  console.log(`  FAIL ${item.id}@${item.version}: ${item.error}`);
}
for (const item of missing) {
  console.log(`  MISSING ${item.id}@${item.version}: ${item.files.length} file(s), e.g. ${item.files.slice(0, 3).join(", ")}`);
}
if (failed.length || missing.length) process.exitCode = 1;
