import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const [
  policy,
  reminders,
  settingsPreference,
  updateSettingsSource,
  updateBannerSource,
] = await Promise.all([
  import("../electron/main/update-policy.ts"),
  import("../electron/main/manual-update-reminder.ts"),
  import("../src/features/settings/update-preference.ts"),
  readFile(new URL("../src/features/settings/agent-sections.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/UpdateBanner.tsx", import.meta.url), "utf8"),
]);

const {
  resolveEffectiveUpdatePreference,
  resolveStoredUpdatePreference,
  UPDATE_FEED_REACHABLE,
} = policy;
const { ManualUpdateReminderTracker } = reminders;
const { persistUpdatePreference } = settingsPreference;

// This build ships with no reachable update feed (the intranet cannot reach
// github.com), so every delivery mode resolves to "disabled" here. The policy
// behind that flag still has to be right for the day a release ships an
// internal feed, so these tests exercise it with the flag on.
const FEED = { feedReachable: true };
// Named parameters, not `...args`: the flag is the last positional argument, so
// spreading a short call would land it in the `env` slot.
const resolveDefaultUpdatePreference = (platform, isPackaged, env = {}, distribution) =>
  policy.resolveDefaultUpdatePreference(platform, isPackaged, env, distribution, FEED);
const resolveUpdateMode = (platform, isPackaged, env = {}, distribution, preference) =>
  policy.resolveUpdateMode(platform, isPackaged, env, distribution, preference, FEED);

 test("installed builds keep automatic by default while portable and ZIP builds default to manual", () => {
  assert.equal(resolveDefaultUpdatePreference("win32", true, {}, "installed"), "automatic");
  assert.equal(resolveDefaultUpdatePreference("win32", true, {}, "zip"), "manual");
  assert.equal(resolveDefaultUpdatePreference("win32", true, {}, "portable"), "manual");
  assert.equal(
    resolveDefaultUpdatePreference("win32", true, { PORTABLE_EXECUTABLE_FILE: "Pi-Workspace.exe" }),
    "manual",
  );
  assert.equal(resolveDefaultUpdatePreference("darwin", true), "automatic");
  assert.equal(resolveDefaultUpdatePreference("linux", true, { APPIMAGE: "/tmp/app.AppImage" }), "automatic");
  assert.equal(resolveDefaultUpdatePreference("linux", true, {}), "manual");
});

test("unset preferences use package defaults and unsupported automatic preferences fail safe", () => {
  assert.equal(resolveStoredUpdatePreference(undefined, "automatic"), "automatic");
  assert.equal(resolveStoredUpdatePreference("manual", "automatic"), "manual");
  assert.equal(resolveStoredUpdatePreference("invalid", "manual"), "manual");
  assert.equal(resolveEffectiveUpdatePreference("automatic", false), "manual");
  assert.equal(resolveEffectiveUpdatePreference("automatic", true), "automatic");
});

test("manual preference disables in-app delivery and explicit automatic restores supported delivery", () => {
  assert.equal(resolveUpdateMode("win32", true, {}, "installed", "manual"), "manual");
  assert.equal(resolveUpdateMode("win32", true, {}, "zip"), "manual");
  assert.equal(resolveUpdateMode("win32", true, {}, "portable"), "manual");
  assert.equal(resolveUpdateMode("win32", true, {}, "zip", "automatic"), "in-app");
  assert.equal(resolveUpdateMode("win32", true, {}, "portable", "automatic"), "in-app");
  assert.equal(resolveUpdateMode("darwin", true, {}, undefined, "automatic"), "in-app");
  assert.equal(resolveUpdateMode("linux", true, {}, undefined, "automatic"), "manual");
  assert.equal(resolveUpdateMode("win32", false, {}, undefined, "automatic"), "disabled");
});

test("manual update reminder is persisted once per version and stays visible only in the current run", () => {
  const firstRun = new ManualUpdateReminderTracker();
  assert.deepEqual(firstRun.observe("0.15.9"), { show: true, persist: true });
  assert.deepEqual(firstRun.observe("0.15.9"), { show: true, persist: false });

  const afterRestart = new ManualUpdateReminderTracker("0.15.9");
  assert.deepEqual(afterRestart.observe("0.15.9"), { show: false, persist: false });
  assert.deepEqual(afterRestart.observe("0.15.10"), { show: true, persist: true });
});

test("Settings → Info saves only valid automatic/manual preferences", async () => {
  const writes = [];
  const saveSettings = async (patch) => writes.push(patch);
  assert.equal(await persistUpdatePreference("manual", saveSettings), true);
  assert.equal(await persistUpdatePreference("automatic", saveSettings), true);
  assert.equal(await persistUpdatePreference("disabled", saveSettings), false);
  assert.deepEqual(writes, [
    { updatePreference: "manual" },
    { updatePreference: "automatic" },
  ]);
  assert.match(updateSettingsSource, /<SettingsMenuSelect/);
  assert.match(updateSettingsSource, /persistUpdatePreference\(value, saveSettings\)/);
  assert.match(updateBannerSource, /manualReminder === true/);
});

test("dismissed update banner hides via persisted state, not component memory", () => {
  // The banner must consult the durable `dismissed` flag from UpdateState and
  // record the dismissal through the updatesDismiss IPC channel (#1317).
  assert.match(updateBannerSource, /update\.dismissed === true/);
  assert.match(updateBannerSource, /api\.updatesDismiss\(\)/);
});

test("this build ships with the update feed off, so every mode resolves to disabled", () => {
  assert.equal(UPDATE_FEED_REACHABLE, false);
  assert.equal(policy.supportsAutomaticUpdates("win32", true, {}), false);
  assert.equal(policy.supportsAutomaticUpdates("darwin", true, {}), false);
  assert.equal(policy.resolveDefaultUpdatePreference("win32", true, {}, "installed"), "manual");
  assert.equal(policy.resolveUpdateMode("win32", true, {}, "installed", "automatic"), "disabled");
  assert.equal(policy.resolveUpdateMode("darwin", true, {}, undefined, "automatic"), "disabled");
});
