import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  USER_COMPONENTS_DIR,
  dataDirFromEnv,
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
