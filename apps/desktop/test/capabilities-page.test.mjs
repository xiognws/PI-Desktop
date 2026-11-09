/**
 * Capability packages inside the Tools page (D691).
 *
 * A capability package is a folder the user dropped into
 * `<userData>/capabilities`; it is listed on the same page as the tool
 * packages this build ships, above them, and each action can be run from
 * there. Source contracts only: discovery, the digest and the enabled/trust
 * state live in host-core (`crates/host-core/src/capabilities.rs`, covered by
 * Rust tests), loading and running live in the sidecar
 * (`packages/agent-runtime/src/capabilities`, covered by vitest), and the IPC
 * boundary is pinned by `capabilities-ipc.test.mjs`. This file pins the
 * renderer wiring: where the section sits, what it shows, and how it runs an
 * action.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const appState = read("../src/stores/app-state.ts");
const appShell = read("../src/features/app/AppShell.tsx");
const toolsPage = read("../src/pages/ToolsPage.tsx");
const toolsStyles = read("../src/features/tools/tools.css");
const api = read("../src/lib/api.ts");
const protocol = read("../../../packages/shared/src/protocol.ts");
const register = read("../electron/main/ipc/register.ts");
const rustCapabilities = read("../../../crates/host-core/src/capabilities.rs");
const rustRpc = read("../../../crates/host-core/src/rpc/mod.rs");

const LOCALES = ["en", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
// de/es/fr quote every key; the other catalogs use bare identifiers.
const quote = (locale, key) =>
  locale === "de" || locale === "es" || locale === "fr" ? `"${key}"` : `${key}`;

test("capabilities are part of the tools page, not a page of their own", () => {
  // One surface: the tools page owns both lists. A separate route would mean a
  // second place to look for the same packages.
  assert.doesNotMatch(appState, /\| "capabilities"/);
  assert.doesNotMatch(appShell, /CapabilitiesPage/);
  assert.match(toolsPage, /function CapabilitySection\(/);
});

test("the section renders above the tool packages and only what was scanned", () => {
  const capabilityAt = toolsPage.indexOf("<CapabilitySection");
  const toolsAt = toolsPage.indexOf('t("tools.loading")');
  assert.ok(capabilityAt > 0 && toolsAt > capabilityAt, "capabilities render before the tool list");

  // Nothing found means nothing shown: the folder is the user's, not ours.
  assert.match(toolsPage, /if \(packages\.length === 0\) return null;/);
  assert.match(toolsPage, /data-capability-section="true"/);
  assert.match(toolsPage, /data-capability=\{pkg\.id\}/);
  assert.match(toolsPage, /data-trust=\{pkg\.trust\}/);
  assert.match(toolsStyles, /\.tools-capability-section\s*\{/);
});

test("the page reads the host list and the sidecar runtime state", () => {
  assert.match(toolsPage, /api\.listCapabilities\(\)/);
  // Runtime state is advisory: a failure there must not blank the list.
  assert.match(toolsPage, /api\.capabilityRuntime\(\)\.catch\(\(\) => \(\{ states: \[\] \}\)\)/);
  assert.match(toolsPage, /t\("capabilities\.loadFailed", \{ message/);
});

test("trust is pinned to the digest the user reviewed", () => {
  assert.match(toolsPage, /api\.setCapabilityTrust\(pkg\.id, pkg\.digest, trusted\)/);
  assert.match(toolsPage, /pkg\.trust === "untrusted"/);
  // An unreviewed package cannot be switched on by accident.
  assert.match(toolsPage, /disabled=\{busyId === pkg\.id \|\| pkg\.trust === "untrusted"\}/);
  assert.match(toolsPage, /api\.setCapabilityEnabled\(id, enabled\)/);
  assert.match(toolsPage, /api\.revealCapability\(id\)/);
  assert.match(toolsPage, /api\.revealCapabilitiesDir\(\)/);
});

test("an action can be run from the client and its result shown", () => {
  // This is the client half of the two-way contract; the agent reaches the same
  // actions through the Capability tool.
  assert.match(toolsPage, /api\.invokeCapability\(pkg\.id, actionName, \{\}\)/);
  assert.match(toolsPage, /data-capability-result=\{actionName\}/);
  assert.match(toolsPage, /formatValue\(answer\.value\)/);
  // Junk in, readable text out: an action may return anything JSON-able.
  assert.match(toolsPage, /function formatValue\(value: unknown\): string/);
  assert.match(toolsStyles, /\.capabilities-action-result\.is-error\s*\{/);
});

test("permissions the user did not grant are marked on the page", () => {
  assert.match(toolsPage, /requestedPermissions/);
  assert.match(toolsPage, /grantedPermissions/);
  assert.match(toolsPage, /is-denied/);
  assert.match(toolsStyles, /\.capabilities-permission\.is-denied\s*\{/);
});

test("the shared, host, and IPC layers agree on the package shape", () => {
  for (const method of [
    "capabilitiesList",
    "capabilitiesSetEnabled",
    "capabilitiesTrust",
    "capabilitiesReveal",
    "capabilitiesRoot",
    "capabilitiesRuntime",
    "capabilitiesInvoke",
  ]) {
    assert.match(protocol, new RegExp(`${method}: "pi-desktop/capabilities/`), method);
  }
  assert.match(register, /registerCapabilitiesIpc\(\{ registrar, getHost, getSidecar \}\)/);
  assert.match(rustCapabilities, /const MANIFEST_FILE: &str = "capability\.json";/);
  assert.match(rustCapabilities, /const PACKAGES_DIR: &str = "capabilities";/);
  // The scan root is a real answer even before any package exists.
  assert.match(rustRpc, /"capabilities\.root" =>/);
});

test("every locale speaks the capability section", () => {
  for (const locale of LOCALES) {
    const catalog = read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    assert.ok(
      catalog.includes(`${quote(locale, "capabilities")}: {`),
      `${locale} defines the capabilities block`,
    );
    for (const key of [
      "title",
      "loadFailed",
      "enableLabel",
      "broken",
      "factPermissions",
      "factRuntime",
      "runtimeAbsent",
      "trustLabel",
      "trustAgain",
      "revokeTrust",
      "reveal",
      "revealDir",
      "run",
      "running",
    ]) {
      assert.ok(catalog.includes(`${quote(locale, key)}`), `${locale} defines capabilities.${key}`);
    }
  }
});
