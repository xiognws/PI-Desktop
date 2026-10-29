import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `data-root.ts` imports Electron, so it cannot be executed outside the app. The
// wiring it owns — when the capability root is repointed and when the link is
// skipped — is asserted from the source instead; the mechanics of linking and
// merging are covered by data-root-home.test.mjs.
const root = new URL("../electron/main/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const source = readFileSync(join(root, "data-root.ts"), "utf8");
const installation = readFileSync(join(root, "installation.ts"), "utf8");

test("the capability root is repointed before anything resolves a path", () => {
  const repoint = source.indexOf('process.env.PI_DESKTOP_AGENTS_DIR = join(root, "agents")');
  const link = source.indexOf("applyHomeLinks(");
  assert.ok(repoint > 0, "data-root must set PI_DESKTOP_AGENTS_DIR");
  assert.ok(link > repoint, "links are applied after the capability root is repointed");
  assert.match(source, /const agentsPinned = Boolean\(process\.env\.PI_DESKTOP_AGENTS_DIR\?\.trim\(\)\)/);
});

test("an explicitly pinned capability root does not create the ~/.agents link", () => {
  assert.match(source, /\.filter\(\(link\) => !\(agentsPinned && link\.home === join\(home, HOME_LINK_DIRS\.agents\)\)\)/);
});

test("the relocation runs before any writer, at module scope", () => {
  const call = installation.indexOf("applyReleaseDataRoot(isDevelopmentBuild)");
  assert.ok(call > 0, "installation.ts must apply the data root");
  assert.equal(
    installation.slice(0, call).includes("app.whenReady"),
    false,
    "the data root must be claimed synchronously, not after ready",
  );
});
