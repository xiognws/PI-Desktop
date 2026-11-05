/**
 * The rename in ADR 0381 deliberately left a set of identifiers spelled the way
 * they were. Each one is addressed by something this repository does not
 * control — an installed plugin, a saved MCP client config, a user's own file, a
 * shell script — so renaming it breaks that caller silently and buys nothing a
 * user can see. This test is the tripwire; the reasoning is in the ADR.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

test("the preload namespace plugins call is unchanged", () => {
  assert.match(
    read("apps/desktop/electron/preload/index.ts"),
    /exposeInMainWorld\("piDesktop",\s*api\)/,
  );
});

test("IPC channels keep the prefix they were published with", () => {
  const protocol = read("packages/shared/src/protocol.ts");
  assert.match(protocol, /storageGet: "pi-desktop\/storage\/get"/);
  assert.match(protocol, /agentPrompt: "pi-desktop\/agent\/prompt"/);
  // A channel renamed to the new brand would be a wire break, not a rebranding.
  assert.doesNotMatch(protocol, /"pi-workspace\//);
});

test("the MCP surface an external client stores is unchanged", () => {
  const mcp = read("apps/desktop/electron/main/mcp-control.ts");
  assert.match(mcp, /MCP_SERVER_NAME = "pi-desktop"/);
  assert.match(mcp, /name: "pi_desktop_invoke"/);
});

test("the workspace ignore file users create is unchanged", () => {
  assert.match(
    read("crates/host-core/src/tools/ignore_rules.rs"),
    /WORKSPACE_IGNORE_FILE: &str = "\.pi-desktopignore"/,
  );
});

test("the packed host binary keeps the name the packager and main agree on", () => {
  assert.match(
    read("crates/host-core/Cargo.toml"),
    /name = "pi-desktop-host-core"/,
  );
  assert.match(
    read("apps/desktop/package.json"),
    /"from": "\.\.\/\.\.\/target\/release\/pi-desktop-host-core/,
  );
});

test("the environment contract below Electron keeps its prefix", () => {
  const installation = read("apps/desktop/electron/main/installation.ts");
  assert.match(installation, /PI_DESKTOP_DEV/);
  assert.match(installation, /PI_DESKTOP_DATA_DIR/);
});

test("bundled plugin ids stay addressable", () => {
  for (const id of ["pi.file-manager", "pi.browser", "pi.prompt-enhancement"]) {
    const manifest = JSON.parse(
      read(`apps/desktop/resources/plugins/${id}/manifest.json`),
    );
    assert.equal(manifest.id, id, `${id} manifest id`);
  }
  const fileManager = JSON.parse(
    read("apps/desktop/resources/plugins/pi.file-manager/manifest.json"),
  );
  // `engines.piDesktop` is a published manifest contract.
  assert.equal(typeof fileManager.engines.piDesktop, "string");
});
