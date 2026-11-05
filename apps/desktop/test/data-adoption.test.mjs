import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  adoptDirectory,
  adoptLegacyHomeProfile,
  DEVELOPMENT_DATA_DIR_NAME,
  INSTALLATION_DATA_DIR_NAME,
  LEGACY_DEVELOPMENT_DATA_DIR_NAME,
  LEGACY_DEVELOPMENT_INSTALLATION_NAME,
  LEGACY_DEVELOPMENT_MAIN_DIR_NAME,
  LEGACY_INSTALLATION_DATA_DIR_NAME,
  LEGACY_INSTALLATION_NAME,
} = await import("../electron/main/data-paths.ts");

let counter = 0;
/** A throwaway directory the test owns and removes when it is done. */
function scratch(label) {
  counter += 1;
  const dir = join(tmpdir(), `piworkspace-${label}-${process.pid}-${counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("a data root from before the rename is adopted whole", () => {
  const base = scratch("root");
  try {
    const legacy = join(base, LEGACY_INSTALLATION_NAME);
    mkdirSync(join(legacy, "data"), { recursive: true });
    writeFileSync(join(legacy, "data", "pi.sqlite"), "database");
    mkdirSync(join(legacy, "userdata"), { recursive: true });
    writeFileSync(join(legacy, "userdata", "preferences"), "renderer state");
    const target = join(base, "PiWorkspace");

    assert.equal(adoptDirectory(target, [legacy], "data root"), true);
    assert.equal(
      readFileSync(join(target, "data", "pi.sqlite"), "utf8"),
      "database",
    );
    assert.equal(
      readFileSync(join(target, "userdata", "preferences"), "utf8"),
      "renderer state",
    );
    // A move must not leave a second copy behind for the next launch to adopt
    // all over again.
    assert.equal(existsSync(legacy), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an existing target is never overwritten by a retired root", () => {
  const base = scratch("existing");
  try {
    const legacy = join(base, LEGACY_INSTALLATION_NAME);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "stale"), "older");
    const target = join(base, "PiWorkspace");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "current"), "in use");

    assert.equal(adoptDirectory(target, [legacy], "data root"), false);
    assert.equal(existsSync(join(target, "stale")), false);
    assert.equal(readFileSync(join(target, "current"), "utf8"), "in use");
    assert.equal(existsSync(legacy), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("nothing is created when there is no predecessor to adopt", () => {
  const base = scratch("absent");
  try {
    const target = join(base, "PiWorkspace");
    assert.equal(
      adoptDirectory(target, [join(base, LEGACY_INSTALLATION_NAME)], "data root"),
      false,
    );
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("adoption falls back to a copy when the source is on another volume", (t) => {
  if (process.platform !== "win32" || !existsSync("D:\\")) {
    return t.skip("needs a second Windows volume");
  }
  const source = `D:\\piworkspace-adoption-${process.pid}-${Date.now()}`;
  const base = scratch("cross-volume");
  try {
    mkdirSync(join(source, "data"), { recursive: true });
    writeFileSync(join(source, "data", "pi.sqlite"), "database");

    assert.equal(
      adoptDirectory(join(base, "PiWorkspace"), [source], "data root"),
      true,
    );
    assert.equal(
      readFileSync(join(base, "PiWorkspace", "data", "pi.sqlite"), "utf8"),
      "database",
    );
    // A copy leaves the source in place, so a launch that died mid-copy finds
    // its originals again instead of an empty profile.
    assert.equal(existsSync(source), true);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test("a shipped home profile from before the rename is adopted", () => {
  const home = scratch("home");
  try {
    // `~/.pi-desktop` *was* the data directory: `pi.sqlite` sits directly in it,
    // which is why the profile is adopted onto the root rather than into a
    // `data` child of it.
    const legacy = join(home, LEGACY_INSTALLATION_DATA_DIR_NAME);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "pi.sqlite"), "database");

    adoptLegacyHomeProfile(home, false);

    assert.equal(
      readFileSync(join(home, INSTALLATION_DATA_DIR_NAME, "pi.sqlite"), "utf8"),
      "database",
    );
    assert.equal(existsSync(legacy), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the development home profile adopts its own retired name", () => {
  const home = scratch("home-dev");
  try {
    const legacy = join(home, LEGACY_DEVELOPMENT_MAIN_DIR_NAME);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "marker"), "development profile");

    adoptLegacyHomeProfile(home, true);

    assert.equal(
      readFileSync(join(home, DEVELOPMENT_DATA_DIR_NAME, "marker"), "utf8"),
      "development profile",
    );
    // A development profile must not land on the shipped name, or the two
    // installations would share one database again (D236).
    assert.equal(existsSync(join(home, INSTALLATION_DATA_DIR_NAME)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("retired identifiers stay spelled the way earlier releases wrote them", () => {
  // These are the only strings that can still find a user's existing data. A
  // tidy-up here silently strands every profile created before the rename.
  assert.equal(LEGACY_INSTALLATION_DATA_DIR_NAME, ".pi-desktop");
  assert.equal(LEGACY_DEVELOPMENT_DATA_DIR_NAME, ".pi-desktop-dev");
  assert.equal(LEGACY_DEVELOPMENT_MAIN_DIR_NAME, ".pi-desktop-dev-main");
  assert.equal(LEGACY_INSTALLATION_NAME, "PI-Desktop");
  assert.equal(LEGACY_DEVELOPMENT_INSTALLATION_NAME, "PI-Desktop Dev");
  // And the current names must not collide with them.
  assert.notEqual(INSTALLATION_DATA_DIR_NAME, LEGACY_INSTALLATION_DATA_DIR_NAME);
  assert.notEqual(DEVELOPMENT_DATA_DIR_NAME, LEGACY_DEVELOPMENT_DATA_DIR_NAME);
});
