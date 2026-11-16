/**
 * A bundled plugin can ship switched off (ADR 0396).
 *
 * WorkBuddy is a built-in provider whose gateway runs inside Pi-Workspace, so
 * the plugin that used to carry that gateway has to arrive disabled: two
 * gateways cannot both own the loopback port. The decision itself is a manifest
 * field, and packages arrive from the marketplace with the publisher's own
 * default, so the product's answer is stamped while the package is expanded —
 * `scripts/bundled-plugins-default-disabled.json` is that answer.
 *
 * The other half of the contract lives in host-core: the flag decides the row
 * host-core *creates*, never the row a user already toggled. These tests pin
 * both halves from the JavaScript side, so the flag cannot quietly become a
 * policy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DISABLED_FILE,
  parseDefaultDisabled,
  readDefaultDisabledIds,
  withDefaultDisabled,
} from "../../../scripts/bundled-plugins-defaults.mjs";

const repo = new URL("../../../", import.meta.url);
const read = (relative) => readFileSync(new URL(relative, repo), "utf8");
const WORKBUDDY = "community.workbuddy-connect";

test("the WorkBuddy bridge is retired from the bundle, not merely switched off", () => {
  // The app runs this bridge itself: shipping the plugin too would put a second
  // gateway on one account, and its row would point at a key that is not ours.
  const excluded = JSON.parse(read("scripts/bundled-plugins-excluded.json"));
  assert.ok(
    excluded.excluded.includes(WORKBUDDY),
    `${WORKBUDDY} must be declared retired so the marketplace sync cannot bundle it`,
  );

  // The reason travels with the id, the way the default-disabled file carries its own.
  const reason = excluded[`//${WORKBUDDY}`];
  assert.equal(typeof reason, "string");
  assert.match(reason, /in-app|built-in provider/i);

  // And it is no longer a bundled-but-off plugin: that list now names nothing.
  const ids = readDefaultDisabledIds(fileURLToPath(repo));
  assert.ok(!ids.includes(WORKBUDDY), `${WORKBUDDY} is retired, not a bundled default`);
});

test("the declaration is stamped onto the expanded manifest, not the package", () => {
  const manifest = {
    schemaVersion: 1,
    id: WORKBUDDY,
    name: "WorkBuddy Connect",
    version: "0.4.1",
    main: "main.js",
    permissions: ["ui.panel", "background.service"],
  };
  const stamped = withDefaultDisabled(manifest, new Set([WORKBUDDY]));
  assert.equal(stamped.changed, true);
  assert.equal(stamped.manifest.enabledByDefault, false);
  // Everything else still belongs to the publisher.
  assert.deepEqual(
    { ...stamped.manifest, enabledByDefault: undefined },
    { ...manifest, enabledByDefault: undefined },
  );
  // The package's own object is not mutated in place.
  assert.equal("enabledByDefault" in manifest, false);

  // An explicit enable by the publisher stays an explicit enable.
  const optIn = withDefaultDisabled(
    { ...manifest, enabledByDefault: true },
    new Set([WORKBUDDY]),
  );
  assert.equal(optIn.changed, true);
  assert.equal(optIn.manifest.enabledByDefault, false);
});

test("a plugin the product does not name keeps its shipped default", () => {
  const untouched = withDefaultDisabled(
    { id: "pi.todo", version: "1.0.0", enabledByDefault: true },
    new Set([WORKBUDDY]),
  );
  assert.equal(untouched.changed, false);
  assert.equal(untouched.manifest.enabledByDefault, true);

  // Idempotent: a manifest already carrying the flag is not rewritten.
  const already = withDefaultDisabled(
    { id: WORKBUDDY, enabledByDefault: false },
    new Set([WORKBUDDY]),
  );
  assert.equal(already.changed, false);
});

test("a malformed declaration fails loudly instead of shipping quietly", () => {
  assert.throws(() => parseDefaultDisabled("{"), /default-disabled\.json/);
  assert.throws(() => parseDefaultDisabled("{}"), /must be an array/);
  assert.throws(
    () => parseDefaultDisabled(JSON.stringify({ defaultDisabled: ["pi.todo", ""] })),
    /non-empty strings/,
  );
  // A duplicate id is one entry, not two.
  assert.deepEqual(parseDefaultDisabled(
    JSON.stringify({ defaultDisabled: [WORKBUDDY, WORKBUDDY] }),
  ).ids, [WORKBUDDY]);
});

test("a plugin that only runs on one platform ships disabled on the others", () => {
  // The list is about where the plugin can do its job. `local.terminal` drives
  // the shell through macOS PTY modules, so a Windows build must not offer it as
  // a working tool that opens an empty panel.
  const windows = readDefaultDisabledIds(fileURLToPath(repo), "win32");
  assert.ok(windows.includes("local.terminal"), "win32 must disable local.terminal");
  const macos = readDefaultDisabledIds(fileURLToPath(repo), "darwin");
  assert.ok(!macos.includes("local.terminal"), "macOS keeps the terminal enabled");

  // The platform map parses on its own and still feeds the stamping step.
  const parsed = parseDefaultDisabled(JSON.stringify({
    defaultDisabled: ["pi.todo"],
    defaultDisabledOnPlatforms: { win32: ["local.terminal"] },
  }));
  assert.deepEqual(parsed.byPlatform, { win32: ["local.terminal"] });
  const stamped = withDefaultDisabled({ id: "local.terminal", enabledByDefault: true }, new Set(windows));
  assert.equal(stamped.changed, true);
  assert.equal(stamped.manifest.enabledByDefault, false);

  // Malformed platform entries are rejected, not ignored.
  assert.throws(
    () => parseDefaultDisabled(JSON.stringify({ defaultDisabled: [], defaultDisabledOnPlatforms: [] })),
    /must be an object/,
  );
  assert.throws(
    () => parseDefaultDisabled(JSON.stringify({ defaultDisabled: [], defaultDisabledOnPlatforms: { "bad key": [] } })),
    /platform names/,
  );
});

test("the sync script stamps it and host-core keeps the user's own choice", () => {
  const sync = read("scripts/sync-bundled-plugins.mjs");
  assert.match(sync, /new Set\(readDefaultDisabledIds\(REPO\)\)/);
  assert.match(sync, /withDefaultDisabled\(manifest, DEFAULT_DISABLED\)/);
  // The stamp lands in the expanded tree, which is the copy the host reads.
  assert.match(sync, /join\(dest, "manifest\.json"\)/);

  // host-core: the manifest default seeds the row, the previous row wins after
  // that. This lives in `preinstalled.rs` since the preinstalled-plugin work
  // moved the seeding there; the rule itself is unchanged.
  const registry = read("crates/host-core/src/plugins/preinstalled.rs");
  assert.match(registry, /previous\s*\.map\(\|p\| p\.enabled\)/);
  assert.match(registry, /\.unwrap_or\(manifest\.enabled_by_default\.unwrap_or\(true\)\)/);

  // and the regression test that proves the two compose.
  const rustTests = read("crates/host-core/src/plugins/tests.rs");
  assert.match(rustTests, /fn bundled_plugin_can_default_to_disabled_without_overwriting_user_state\(\)/);
  assert.match(rustTests, /an explicit enable survives the next launch/);
});
