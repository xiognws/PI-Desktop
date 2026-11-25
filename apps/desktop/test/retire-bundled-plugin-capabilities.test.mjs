import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "retire-bundled-plugin-capabilities.mjs");
const CONFIG_REL = join("scripts", "bundled-plugins-retired-capabilities.json");
const PLUGIN_REL = join("apps", "desktop", "resources", "plugins", "local.fixture-bot");

/** A throwaway tree that mirrors the real layout: scripts/ + resources/plugins/<id>. */
function fixture({ retired = ["src/recorder.js", "src/recorder.ps1"], leftovers = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "retire-capabilities-"));
  const plugin = join(root, PLUGIN_REL);
  mkdirSync(join(plugin, "src"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(plugin, "main.js"), "module.exports = {};\n");
  writeFileSync(join(plugin, "src", "recorder.js"), "module.exports = { spawn };\n");
  writeFileSync(join(plugin, "src", "recorder.ps1"), "param([string]$x)\n");
  writeFileSync(
    join(plugin, "checksums.json"),
    JSON.stringify({ "main.js": "aaa", "src/recorder.js": "bbb" }, null, 2),
  );
  writeFileSync(
    join(root, CONFIG_REL),
    JSON.stringify(
      {
        "//": "fixture",
        retired: { "local.fixture-bot": retired },
      },
      null,
      2,
    ),
  );
  if (leftovers) {
    // A file that still requires the retired module: the case the gate exists for.
    writeFileSync(join(plugin, "src", "entry.js"), "const r = require('./recorder.js');\n");
  }
  return { root, plugin };
}

function run(root, ...extra) {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...extra], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("removes the listed files and prunes their checksum rows", () => {
  const { root, plugin } = fixture();
  const first = run(root);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(existsSync(join(plugin, "src", "recorder.js")), false);
  assert.equal(existsSync(join(plugin, "src", "recorder.ps1")), false);
  const checksums = JSON.parse(readFileSync(join(plugin, "checksums.json"), "utf8"));
  assert.deepEqual(Object.keys(checksums), ["main.js"]);
  assert.match(first.stdout, /2 file\(s\) retired, 0 violations/);
});

test("running twice is a no-op that still passes", () => {
  const { root } = fixture();
  assert.equal(run(root).code, 0);
  const second = run(root);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /0 violations/);
});

test("--check reports a violation and deletes nothing", () => {
  const { root, plugin } = fixture();
  const checked = run(root, "--check");
  assert.equal(checked.code, 1);
  assert.match(checked.stderr, /still present/);
  assert.equal(existsSync(join(plugin, "src", "recorder.js")), true);
});

test("a leftover reference fails the gate after deletion", () => {
  const { root, plugin } = fixture({ leftovers: true });
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /entry\.js still references recorder\.js/);
  // The delete half still happened: the gate must not leave a half-applied tree.
  assert.equal(existsSync(join(plugin, "src", "recorder.js")), false);
});

test("a tree without the plugin is not a failure", () => {
  const root = mkdtempSync(join(tmpdir(), "retire-capabilities-empty-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, CONFIG_REL),
    JSON.stringify({ retired: { "local.fixture-bot": ["src/recorder.js"] } }, null, 2),
  );
  const result = run(root);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /not present in this tree/);
});

test("a path that escapes the plugin directory is rejected", () => {
  const { root } = fixture({ retired: ["../escape.js"] });
  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /plain relative POSIX path/);
});

test("the real config lists the retired pi-bot recorder", () => {
  const config = JSON.parse(readFileSync(join(REPO, CONFIG_REL), "utf8"));
  const paths = config.retired["local.pi-bot"];
  assert.ok(Array.isArray(paths) && paths.length > 0, "local.pi-bot must list its retired files");
  assert.ok(paths.includes("src/windows-microphone.ps1"));
  assert.ok(paths.includes("src/windows-microphone.js"));
});
