#!/usr/bin/env node
/**
 * Preinstalled and user-pointed plugins, against the real host binary (ADR 0396).
 *
 * What unit tests cannot prove is the part that crosses launches: that a removal
 * is still a removal after a restart, that an app update refreshes what nobody
 * touched and leaves alone what somebody did, and that a directory the user names
 * is read where it is and never written to. This drives one host process per
 * launch, with a temporary image directory and a temporary data directory, and
 * asserts on `plugins.list` each time.
 *
 * Usage: node scripts/e2e-preinstalled-plugins.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const manifest = (id, version, extra = {}) =>
  JSON.stringify(
    {
      schemaVersion: 1,
      id,
      name: id,
      version,
      main: "main.js",
      permissions: ["ui.panel"],
      ...extra,
    },
    null,
    2,
  );

/** One plugin directory inside `root`, with a manifest and a trivial entry. */
async function writePlugin(root, id, version, extra = {}) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), manifest(id, version, extra), "utf8");
  await writeFile(join(dir, "main.js"), "export default {};\n", "utf8");
  return dir;
}

const rows = async (host) => {
  const { plugins } = await host.call("plugins.list");
  return plugins;
};
const row = async (host, id) => (await rows(host)).find((plugin) => plugin.id === id);

test("preinstalled plugins are removable, and the decision survives a restart", { timeout: 180_000 }, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-e2e-preinstalled-"));
  const image = join(temp, "image");
  const data = join(temp, "data");
  await mkdir(image, { recursive: true });

  const hostBinary = resolveHostBinary();
  const env = { PI_DESKTOP_PREINSTALLED_DIRS: image, PI_DESKTOP_APP_VERSION: "0.21.0-e2e" };
  const host = new Host(hostBinary, data, { env, quiet: true });
  t.after(async () => {
    await host.stop();
    await rm(temp, { recursive: true, force: true });
  });

  // The image ships two plugins.
  await writePlugin(image, "pi.keep", "1.0.0");
  await writePlugin(image, "pi.drop", "1.0.0");
  await host.start();

  let listed = await rows(host);
  assert.deepEqual(
    listed.map((plugin) => plugin.id).sort(),
    ["pi.drop", "pi.keep"],
    "an install image's plugins are registered without the user installing anything",
  );
  assert.ok(
    listed.every((plugin) => plugin.source === "preinstalled"),
    "the row says where it came from: " + JSON.stringify(listed.map((plugin) => plugin.source)),
  );
  assert.ok(listed.every((plugin) => plugin.bundled === true));

  // Removing one is allowed, and the image's files stay where they are.
  const dropped = await host.call("plugins.uninstall", { id: "pi.drop" });
  assert.equal(dropped.ok, true, "a preinstalled plugin can be uninstalled");
  assert.equal(await row(host, "pi.drop"), undefined);
  const { stat } = await import("node:fs/promises");
  await assert.doesNotReject(
    stat(join(image, "pi.drop", "manifest.json")),
    "the image's plugin directory belongs to the installation, not to the uninstall",
  );

  // Next launch: still gone, and the host remembers why.
  await host.stop();
  await host.start();
  assert.equal(await row(host, "pi.drop"), undefined, "a removal survives a restart");
  assert.ok(await row(host, "pi.keep"), "the untouched plugin comes back as usual");
  const { removed } = await host.call("plugins.preinstalledRemoved");
  assert.deepEqual(
    removed.map((entry) => entry.id),
    ["pi.drop"],
    "the decision is reported, not silently kept",
  );

  // An app update does not overturn the decision; it does refresh the rest.
  await host.stop();
  await writePlugin(image, "pi.keep", "2.0.0");
  await writePlugin(image, "pi.drop", "2.0.0");
  await host.start();
  assert.equal((await row(host, "pi.keep")).version, "2.0.0", "an untouched plugin follows the image");
  assert.equal(await row(host, "pi.drop"), undefined, "a newer image does not resurrect it");

  // Restoring is explicit, and comes back at the image's current version.
  const restored = await host.call("plugins.restorePreinstalled", { id: "pi.drop" });
  assert.equal(restored.plugin?.version, "2.0.0");
  assert.equal((await row(host, "pi.drop")).version, "2.0.0");

  // A directory the user names is read in place and wins over the image.
  const mine = join(temp, "mine");
  const checkout = await writePlugin(mine, "pi.acme", "3.0.0");
  const synced = await host.call("plugins.syncExtraDirs", { dirs: [mine] });
  assert.ok(Array.isArray(synced.plugins));
  const external = await row(host, "pi.acme");
  assert.equal(external?.source, "external");
  assert.equal(external?.version, "3.0.0");
  assert.equal(external?.path, checkout, "the row points at the user's own directory");

  // Uninstalling it removes the row and leaves the files alone.
  await host.call("plugins.uninstall", { id: "pi.acme" });
  assert.equal(await row(host, "pi.acme"), undefined);
  await assert.doesNotReject(
    import("node:fs/promises").then((fs) => fs.stat(join(checkout, "manifest.json"))),
    "removing an external plugin must not delete the user's files",
  );

  // Dropping the directory from the list retires its rows.
  await host.call("plugins.syncExtraDirs", { dirs: [mine] });
  assert.equal((await row(host, "pi.acme"))?.source, "external");
  await host.call("plugins.syncExtraDirs", { dirs: [] });
  assert.equal(await row(host, "pi.acme"), undefined, "no listed directory, no external rows");
});

test("an external copy wins over the image under the same id", { timeout: 120_000 }, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-e2e-external-"));
  const image = join(temp, "image");
  const data = join(temp, "data");
  const mine = join(temp, "mine");
  await mkdir(image, { recursive: true });
  const host = new Host(resolveHostBinary(), data, {
    env: { PI_DESKTOP_PREINSTALLED_DIRS: image },
    quiet: true,
  });
  t.after(async () => {
    await host.stop();
    await rm(temp, { recursive: true, force: true });
  });

  await writePlugin(image, "acme.todo", "1.0.0");
  await writePlugin(mine, "acme.todo", "2.0.0");
  await host.start();
  assert.equal((await row(host, "acme.todo")).source, "preinstalled");
  await host.call("plugins.syncExtraDirs", { dirs: [mine] });
  const chosen = await row(host, "acme.todo");
  assert.equal(chosen.source, "external", "the user pointed at this directory on purpose");
  assert.equal(chosen.version, "2.0.0");
});
