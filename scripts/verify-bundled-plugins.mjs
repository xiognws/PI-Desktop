#!/usr/bin/env node
/**
 * Verify the plugins this build ships are accepted by host-core.
 *
 * Starts the host against a throwaway data dir with
 * `PI_DESKTOP_BUILTIN_PLUGINS_DIR` pointing at `apps/desktop/resources/plugins`
 * and asks it for `plugins.list`, which runs the real manifest validation and
 * capability derivation the app performs at launch. A manifest the host would
 * reject shows up here instead of as a silently missing plugin in the UI.
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Host, resolveHostBinary } from "./e2e/host.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtin = join(repo, "apps", "desktop", "resources", "plugins");
const dataDir = await mkdtemp(join(tmpdir(), "pi-bundled-check-"));

// Static pass first: a manifest is accepted even when the file it names is
// missing (an uninstalled plugin that never loads is not a manifest error), so
// the entry points a bundled copy needs are checked against the disk.
const entryProblems = [];
for (const id of await readdir(builtin)) {
  const dir = join(builtin, id);
  const manifestPath = join(dir, "manifest.json");
  const manifest = await readFile(manifestPath, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  if (!manifest) continue;
  const required = [manifest.main, manifest.ui?.panel, manifest.renderer?.ui].filter(Boolean);
  for (const relative of required) {
    const exists = await stat(join(dir, ...String(relative).split("/")))
      .then(() => true)
      .catch(() => false);
    if (!exists) entryProblems.push(`${id}: ${relative}`);
  }
}
console.log(`entry points: ${entryProblems.length ? `${entryProblems.length} missing` : "all present"}`);
for (const problem of entryProblems) console.log(`  MISSING ${problem}`);

const host = new Host(resolveHostBinary(), dataDir, {
  env: { PI_DESKTOP_BUILTIN_PLUGINS_DIR: builtin },
  quiet: true,
});
try {
  await host.start();
  const { plugins } = await host.call("plugins.list", {});
  const rows = plugins ?? [];
  const broken = rows.filter((row) => row.status === "error" || row.error_message);
  const enabled = rows.filter((row) => row.enabled);
  const withPanel = rows.filter((row) => (row.capabilities ?? []).includes("panel"));
  const withViews = rows.filter((row) => (row.capabilities ?? []).includes("views"));
  const withTools = rows.filter((row) => (row.capabilities ?? []).includes("commands"));
  console.log(`rows: ${rows.length} (enabled ${enabled.length}, disabled ${rows.length - enabled.length})`);
  console.log(`bundled: ${rows.filter((row) => row.bundled).length}`);
  console.log(`panel: ${withPanel.length}, views: ${withViews.length}, commands: ${withTools.length}`);
  if (broken.length) {
    console.log(`broken: ${broken.length}`);
    for (const row of broken) console.log(`  ${row.id}: ${row.status} ${row.error_message ?? ""}`);
  } else {
    console.log("broken: 0");
  }
  console.log("ids:", rows.map((row) => row.id).sort().join(","));
} finally {
  await host.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
