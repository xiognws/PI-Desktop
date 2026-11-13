/**
 * Developer-only settings destinations are retained in development builds
 * but omitted from packaged builds. Navigation, search, and stale-page
 * handling must honor the same visibility rules.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  resolveSettingsTab,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

const settingsPage = readFileSync(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const searchDialog = readFileSync(
  new URL("../src/components/SearchDialog.tsx", import.meta.url),
  "utf8",
);
const composer = readFileSync(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const composerToolbar = readFileSync(
  new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
  "utf8",
);

const settingsPrimitives = readFileSync(
  new URL("../src/features/settings/primitives.tsx", import.meta.url),
  "utf8",
);

const identity = (key) => key;
const developerOnlyIds = SETTINGS_NAV.filter(entry => entry.developerOnly === true).map(entry => entry.id);

test("Live Voice is gone from the settings index", () => {
  assert.equal(SETTINGS_NAV.some((entry) => entry.id === "voice"), false);
  assert.equal(
    SETTINGS_NAV.some((entry) =>
      entry.keywordKeys.some((key) => key.startsWith("liveVoice.")),
    ),
    false,
  );
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      const options = { developerMode, includeDevelopmentOnly };
      assert.equal(
        visibleSettingsNav(developerMode, includeDevelopmentOnly)
          .some((entry) => entry.id === "voice"),
        false,
      );
      assert.equal(isSettingsDestinationHidden("voice", developerMode, includeDevelopmentOnly), true);
      for (const query of [
        "liveVoice.title",
        "liveVoice.enable",
        "liveVoice.provider",
      ]) {
        assert.deepEqual(searchSettings(query, identity, options), []);
      }
    }
  }
});

test("Cloud sync and Remote Hosts are gone from the settings index", () => {
  for (const id of ["sync", "remoteHosts"]) {
    assert.equal(SETTINGS_NAV.some((entry) => entry.id === id), false);
  }
  assert.equal(
    SETTINGS_NAV.some((entry) =>
      entry.keywordKeys.some(
        (key) =>
          key.startsWith("settings.configSync.") ||
          key.startsWith("settings.remoteHosts."),
      ),
    ),
    false,
  );
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      const options = { developerMode, includeDevelopmentOnly };
      assert.deepEqual(
        searchSettings("settings.nav.remoteHosts", identity, options),
        [],
      );
      assert.deepEqual(
        searchSettings("settings.configSync.connectionTitle", identity, options),
        [],
      );
    }
  }
});

test("developer mode retains the developer-only destinations in development", () => {
  const off = visibleSettingsNav(false).map((entry) => entry.id);
  const on = visibleSettingsNav(true).map((entry) => entry.id);

  for (const id of developerOnlyIds) {
    assert.equal(off.includes(id), false);
    assert.equal(on.includes(id), true);
  }
  assert.deepEqual(off, on.filter((id) => !developerOnlyIds.includes(id)));
  assert.deepEqual(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true).map((entry) => entry.id),
    developerOnlyIds,
  );
  assert.ok(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true)
      .every((entry) => entry.experimentalBadgeKey),
  );
});

test("packaged builds hide developer-only destinations", () => {
  const packaged = visibleSettingsNav(true, false).map((entry) => entry.id);
  for (const id of developerOnlyIds) {
    assert.equal(packaged.includes(id), false);
    assert.equal(isSettingsDestinationHidden(id, true, false), true);
  }
  assert.equal(isSettingsDestinationHidden("appearance", true, false), false);
});

test("a destination id retired by the D684 split still opens a page", () => {
  // A stored selection, a native menu, or a link written before the split must
  // not land on an empty content pane.
  assert.equal(resolveSettingsTab("general"), "appearance");
  assert.equal(resolveSettingsTab("ai"), "behavior");
  assert.equal(resolveSettingsTab("nonsense"), DEFAULT_SETTINGS_TAB);
  assert.equal(DEFAULT_SETTINGS_TAB, SETTINGS_NAV[0].id);
  // An id the index still owns is returned unchanged, including a
  // developer-gated one: visibility is decided separately.
  for (const entry of SETTINGS_NAV) {
    assert.equal(resolveSettingsTab(entry.id), entry.id);
  }
});

test("settings search mirrors developer and packaged visibility", () => {
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("settings routes, global search, and composer use build visibility", () => {
  assert.match(settingsPage, /const includeDevelopmentOnly = import\.meta\.env\.DEV/);
  assert.match(settingsPage, /visibleSettingsNav\(developerMode, includeDevelopmentOnly\)/);
  assert.match(settingsPage, /isSettingsDestinationHidden\([\s\S]*includeDevelopmentOnly/);
  // A hidden destination falls back to the default one by name, so the
  // fallback cannot drift from the index (D684).
  assert.match(settingsPage, /setSettingsTab\(DEFAULT_SETTINGS_TAB\)/);
  assert.doesNotMatch(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(searchDialog, /includeDevelopmentOnly: import\.meta\.env\.DEV/);
  // The composer has no voice affordance left (ADR 0387).
  assert.doesNotMatch(composer, /useVoiceInput|VoiceOverlay|voiceEnabled|VoiceMicButton/);
  assert.doesNotMatch(
    composerToolbar,
    /LiveVoiceControls|VoiceMicButton|voicePhase|onVoiceToggle|onVoiceCancel/,
  );
});
