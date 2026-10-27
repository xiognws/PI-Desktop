/**
 * The built-in capability strip on the plugins page.
 *
 * It exists to answer "what is switched on" without leaving the page, so the
 * contract worth pinning is which rows get a real switch and which only get an
 * entry point: anything with more than one value must link out instead of
 * growing a second copy of its settings form here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readPluginsSourceSync } from "./helpers/source-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), "utf8");

const pluginsPage = read("../src/pages/PluginsPage.tsx");
const pluginsSource = readPluginsSourceSync();
const panel = read("../src/features/plugins/BuiltinCapabilitiesPanel.tsx");
const en = read("../../../packages/i18n/src/locales/en/index.ts");
const zh = read("../../../packages/i18n/src/locales/zh-CN/index.ts");

test("the capability strip renders above the plugin list, on both tabs", () => {
  assert.match(pluginsPage, /import \{ BuiltinCapabilitiesPanel \}/);
  assert.match(
    pluginsPage,
    /<BuiltinCapabilitiesPanel \/>\s*\{tab === "installed" \?/,
  );
});

test("developer tools is a real switch that writes the setting", () => {
  assert.match(panel, /<SettingsToggle/);
  assert.match(panel, /checked=\{developerMode\}/);
  assert.match(panel, /saveSettings\(\{ developerMode: !developerMode \}\)/);
  assert.match(panel, /api\.setSettings\(next\)/);
  assert.match(panel, /useAppStore\.setState\(\{ settings: next \}\)/);
});

test("subagents show a tally and an entry point, never a switch", () => {
  assert.match(panel, /api\s*\.subagentCatalog\(\)/);
  assert.match(panel, /builtins\.filter\(\(row\) => row\.enabled\)/);
  // The row's only control is the link: a single switch here would flatten the
  // per-role choices the settings page owns.
  const subagentRow = panel.slice(
    panel.indexOf('t("plugins.capabilitySubagents")'),
    panel.indexOf('t("plugins.capabilityWebSearch")'),
  );
  assert.doesNotMatch(subagentRow, /<SettingsToggle/);
  assert.match(subagentRow, /openSettingsPage\("subagents"\)/);
});

test("web search is described as model-provided rather than offered as a switch", () => {
  const row = panel.slice(panel.indexOf('t("plugins.capabilityWebSearch")'));
  assert.match(row, /t\("plugins\.capabilityModelProvided"\)/);
  assert.doesNotMatch(row, /<SettingsToggle/);
  assert.match(row, /openSettingsPage\("agent"\)/);
});

test("voice input is not part of the strip", () => {
  assert.doesNotMatch(panel, /voice/i);
  assert.doesNotMatch(pluginsSource, /capabilityVoice/);
});

test("both shipped locales carry the capability keys", () => {
  const keys = [
    "builtinTitle",
    "capabilitySwitch",
    "capabilityDeveloper",
    "capabilityDeveloperDesc",
    "capabilitySubagents",
    "capabilitySubagentsDesc",
    "capabilityTally",
    "capabilityWebSearch",
    "capabilityWebSearchDesc",
    "capabilityModelProvided",
    "capabilityOpenSettings",
    "manageSettings",
    "openModelSettings",
  ];
  for (const key of keys) {
    assert.match(en, new RegExp(`^\\s*${key}: `, "m"), `en missing plugins.${key}`);
    assert.match(zh, new RegExp(`^\\s*${key}: `, "m"), `zh-CN missing plugins.${key}`);
  }
});
