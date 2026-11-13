import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  MAX_EXTRA_DIRS,
  PATH_DELIMITER,
  addExtraDir,
  isInsideDirectory,
  listPluginDirectories,
  parsePluginPaths,
  pluginPathsFile,
  removeExtraDir,
  resolveExtraPluginDirs,
  resolvePreinstalledPluginsDirs,
  writePluginPaths,
} from "../electron/main/plugin-paths.ts";

/**
 * Where plugin directories come from (ADR 0396).
 *
 * The preinstalled set ships with the image and the extra set is the user's own;
 * both reach host-core as environment variables because only Electron knows
 * whether it runs from `resources/` or a checkout. What matters here is that a
 * bad entry can never turn into a wrong directory: relative paths are dropped
 * (the host's working directory is the data directory), duplicates collapse, and
 * the list has a ceiling.
 */

const scratch = () => mkdtempSync(join(tmpdir(), "pi-plugin-paths-"));

test("resolvePreinstalledPluginsDirs returns every directory that exists", () => {
  const root = scratch();
  try {
    const packaged = join(root, "resources");
    mkdirSync(join(packaged, "plugins"), { recursive: true });
    const moduleDir = join(root, "checkout", "out", "main");
    mkdirSync(join(root, "checkout", "resources", "plugins"), { recursive: true });
    mkdirSync(moduleDir, { recursive: true });

    const dirs = resolvePreinstalledPluginsDirs({
      resourcesPath: packaged,
      moduleDirectory: moduleDir,
    });
    // Packaged first, then the checkout layout, so a distribution can layer its
    // own set in front of a vendored one.
    assert.deepEqual(dirs, [
      join(packaged, "plugins"),
      join(root, "checkout", "resources", "plugins"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePreinstalledPluginsDirs is empty for a build that ships none", () => {
  const root = scratch();
  try {
    assert.deepEqual(
      resolvePreinstalledPluginsDirs({
        resourcesPath: join(root, "missing"),
        moduleDirectory: join(root, "also-missing"),
      }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parsePluginPaths drops what the host could misread", () => {
  const absolute = join(tmpdir(), "checkout");
  const parsed = parsePluginPaths(
    JSON.stringify({
      extraDirs: [
        absolute,
        ` ${absolute} `,
        "relative/plugins",
        "",
        42,
        null,
        join(tmpdir(), "second"),
      ],
    }),
  );
  assert.deepEqual(parsed.extraDirs, [absolute, join(tmpdir(), "second")]);
});

test("parsePluginPaths survives a hand-edited file", () => {
  for (const raw of ["", "not json", "null", "[]", '{"extraDirs":"nope"}', "{}"]) {
    assert.deepEqual(parsePluginPaths(raw), { extraDirs: [] }, raw);
  }
});

test("parsePluginPaths stops at the ceiling", () => {
  const listed = Array.from({ length: MAX_EXTRA_DIRS + 5 }, (_, index) =>
    join(tmpdir(), `plugins-${index}`),
  );
  const parsed = parsePluginPaths(JSON.stringify({ extraDirs: listed }));
  assert.equal(parsed.extraDirs.length, MAX_EXTRA_DIRS);
});

test("resolveExtraPluginDirs reads the settings file and keeps only real directories", () => {
  const root = scratch();
  try {
    const present = join(root, "my-plugins");
    const absent = join(root, "gone");
    mkdirSync(present, { recursive: true });
    writeFileSync(
      pluginPathsFile(root),
      JSON.stringify({ extraDirs: [present, absent] }),
      "utf8",
    );
    assert.deepEqual(resolveExtraPluginDirs(root, {}), [present]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit environment list wins over the settings file", () => {
  const root = scratch();
  const overrideRoot = scratch();
  try {
    const fromFile = join(root, "from-file");
    const fromEnv = join(overrideRoot, "from-env");
    mkdirSync(fromFile, { recursive: true });
    mkdirSync(fromEnv, { recursive: true });
    writeFileSync(pluginPathsFile(root), JSON.stringify({ extraDirs: [fromFile] }), "utf8");

    const dirs = resolveExtraPluginDirs(root, {
      PI_DESKTOP_EXTRA_PLUGIN_DIRS: fromEnv,
    });
    assert.deepEqual(dirs, [fromEnv]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(overrideRoot, { recursive: true, force: true });
  }
});

test("no settings file and no override means no extra directories", () => {
  const root = scratch();
  try {
    assert.deepEqual(resolveExtraPluginDirs(root, {}), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the delimiter matches the platform the host runs on", () => {
  assert.equal(PATH_DELIMITER, process.platform === "win32" ? ";" : ":");
  assert.ok(!sep.includes(PATH_DELIMITER) || PATH_DELIMITER === ":");
});

test("writePluginPaths round-trips through the parser", () => {
  const root = scratch();
  try {
    const kept = join(root, "kept");
    mkdirSync(kept, { recursive: true });
    const written = writePluginPaths(root, [kept, "relative/nope", ""]);
    assert.deepEqual(written.extraDirs, [kept], "what the host scans is what was written");
    const entries = listPluginDirectories(root);
    assert.deepEqual(entries, [{ path: kept, exists: true, counted: true }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a listed directory that is gone is reported but not counted", () => {
  const root = scratch();
  try {
    const gone = join(root, "gonetoday");
    writePluginPaths(root, [gone]);
    const entries = listPluginDirectories(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].exists, false);
    assert.equal(
      entries[0].counted,
      false,
      "the host only scans what exists, and the page must not pretend otherwise",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addExtraDir keeps the first position and honours the ceiling", () => {
  const first = join(tmpdir(), "a");
  assert.deepEqual(addExtraDir([], first), [first]);
  assert.deepEqual(addExtraDir([first], first), [first], "adding twice changes nothing");
  assert.deepEqual(addExtraDir([first], "  "), [first], "a blank entry is not a directory");
  const many = Array.from({ length: MAX_EXTRA_DIRS }, (_, index) => join(tmpdir(), `m-${index}`));
  assert.equal(addExtraDir(many, join(tmpdir(), "overflow")).length, MAX_EXTRA_DIRS);
});

test("removeExtraDir removes exactly the entry asked for", () => {
  const one = join(tmpdir(), "one");
  const two = join(tmpdir(), "two");
  assert.deepEqual(removeExtraDir([one, two], one), [two]);
  assert.deepEqual(removeExtraDir([two], one), [two], "removing an unlisted path is a no-op");
});

test("isInsideDirectory is separator-agnostic and does not match prefixes", () => {
  assert.equal(isInsideDirectory("D:\\work\\plugins", "D:\\work\\plugins\\acme.todo\\main.js"), true);
  assert.equal(isInsideDirectory("D:\\work\\plugins\\", "D:/work/plugins/acme.todo/main.js"), true);
  assert.equal(isInsideDirectory("D:\\work\\plugins", "D:\\work\\plugins"), true);
  assert.equal(
    isInsideDirectory("D:\\work\\plugins", "D:\\work\\plugins-old\\main.js"),
    false,
    "a sibling whose name merely starts the same is not inside",
  );
  assert.equal(isInsideDirectory("", "D:\\work\\plugins"), false);
});

