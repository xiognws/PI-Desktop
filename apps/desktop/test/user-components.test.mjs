import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  USER_COMPONENTS_DIR,
  dataDirFromEnv,
  ensureComponentDir,
  listComponents,
  parkComponentDir,
  userComponentDir,
  userComponentPath,
  userComponentsRoot,
} from "../electron/main/user-components.ts";
import { resolveGenUiKitDir } from "../electron/main/gen-ui-kit.ts";
import { resolveManualPath } from "../electron/main/manual-path.ts";

/**
 * Data components the user may override (ADR 0396 § components).
 *
 * The shipped kit, catalog and handbook are defaults. A file under
 * `<data>/components/<name>/` wins, and everything the user did not provide
 * still comes from the image — so an override is additive, and deleting it is
 * the whole rollback.
 */

const scratch = () => mkdtempSync(join(tmpdir(), "pi-components-"));

test("the components root lives under the data directory", () => {
  assert.equal(userComponentsRoot("D:/data"), join("D:/data", USER_COMPONENTS_DIR));
  assert.equal(userComponentDir("D:/data", "gen-ui"), join("D:/data", "components", "gen-ui"));
});

test("userComponentPath reports only what is actually there", () => {
  const root = scratch();
  try {
    assert.equal(userComponentPath(root, "models.dev", "api.json"), null);
    mkdirSync(userComponentDir(root, "models.dev"), { recursive: true });
    writeFileSync(join(userComponentDir(root, "models.dev"), "api.json"), "{}", "utf8");
    assert.equal(
      userComponentPath(root, "models.dev", "api.json"),
      join(userComponentDir(root, "models.dev"), "api.json"),
    );
    assert.equal(userComponentPath(root, "models.dev", "missing.json"), null);
    assert.equal(userComponentPath("", "models.dev", "api.json"), null, "no data dir means no override");
    assert.equal(userComponentPath(null, "manual"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a user kit wins over the shipped one, and needs its stylesheet to count", () => {
  const root = scratch();
  try {
    mkdirSync(userComponentDir(root, "gen-ui"), { recursive: true });
    // Half a kit does not load: fall back to the shipped copy.
    writeFileSync(join(userComponentDir(root, "gen-ui"), "visualize-kit.html"), "<div></div>", "utf8");
    const withoutCss = resolveGenUiKitDir({ PI_DESKTOP_DATA_DIR: root });
    assert.notEqual(withoutCss, userComponentDir(root, "gen-ui"));

    writeFileSync(join(userComponentDir(root, "gen-ui"), "visualize.css"), ":root{}", "utf8");
    assert.equal(
      resolveGenUiKitDir({ PI_DESKTOP_DATA_DIR: root }),
      userComponentDir(root, "gen-ui"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a user handbook wins over the shipped one", () => {
  const root = scratch();
  try {
    const manualDir = userComponentDir(root, "manual");
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, "Pi-Workspace-mine.md"), "# mine", "utf8");
    const resolved = resolveManualPath(undefined, "", { PI_DESKTOP_DATA_DIR: root });
    assert.equal(resolved, join(manualDir, "Pi-Workspace-mine.md"));
    assert.equal(dataDirFromEnv({}), "", "an unset variable is an empty root, not a crash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the settings list reports what is actually in effect, not what exists", () => {
  const root = scratch();
  try {
    const before = listComponents(root);
    assert.deepEqual(
      before.map((row) => row.name),
      ["gen-ui", "models.dev", "manual"],
    );
    assert.ok(before.every((row) => !row.present && !row.overridden));

    // An empty directory is not an override: it changes nothing.
    mkdirSync(userComponentDir(root, "gen-ui"), { recursive: true });
    mkdirSync(userComponentDir(root, "manual"), { recursive: true });
    const partial = listComponents(root);
    assert.equal(partial.find((row) => row.name === "gen-ui").present, true);
    assert.equal(
      partial.find((row) => row.name === "gen-ui").overridden,
      false,
      "a kit without its stylesheet is not in effect",
    );
    assert.equal(partial.find((row) => row.name === "manual").overridden, false);

    writeFileSync(join(userComponentDir(root, "gen-ui"), "visualize.css"), ":root{}", "utf8");
    writeFileSync(join(userComponentDir(root, "manual"), "Pi-Workspace-mine.md"), "# mine", "utf8");
    mkdirSync(userComponentDir(root, "models.dev"), { recursive: true });
    writeFileSync(join(userComponentDir(root, "models.dev"), "api.json"), "{}", "utf8");
    const live = listComponents(root);
    assert.ok(live.every((row) => row.overridden), JSON.stringify(live));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turning an override off parks the folder instead of deleting it", () => {
  const root = scratch();
  try {
    const dir = ensureComponentDir(root, "models.dev");
    writeFileSync(join(dir, "api.json"), "{}", "utf8");
    assert.equal(ensureComponentDir(root, "models.dev"), dir, "ensuring twice is not an error");

    const { parked } = parkComponentDir(root, "models.dev");
    assert.ok(parked, "the folder is moved, not removed");
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(join(parked, "api.json")), true, "the user's file survives");
    assert.equal(
      listComponents(root).find((row) => row.name === "models.dev").overridden,
      false,
      "the shipped copy is in effect again",
    );

    // Nothing to park is not a failure.
    const again = parkComponentDir(root, "models.dev");
    assert.equal(again.parked, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
