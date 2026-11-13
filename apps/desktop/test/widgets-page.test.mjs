/**
 * Widget packages inside the Tools page (D699).
 *
 * A widget package is a folder the user dropped into
 * `<userData>/widgets`; it is listed on the same page as the tool
 * packages this build ships, above them, and each action can be run from
 * there. Source contracts only: discovery, the digest and the enabled/trust
 * state live in host-core (`crates/host-core/src/widgets.rs`, covered by
 * Rust tests), loading and running live in the sidecar
 * (`packages/agent-runtime/src/widgets`, covered by vitest), and the IPC
 * boundary is pinned by `widgets-ipc.test.mjs`. This file pins the
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
const rustCapabilities = read("../../../crates/host-core/src/widgets.rs");
const rustRpc = read("../../../crates/host-core/src/rpc/mod.rs");

const LOCALES = ["en", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
// de/es/fr quote every key; the other catalogs use bare identifiers.
const quote = (locale, key) =>
  locale === "de" || locale === "es" || locale === "fr" ? `"${key}"` : `${key}`;

test("widgets are part of the tools page, not a page of their own", () => {
  // One surface: the tools page owns both lists. A separate route would mean a
  // second place to look for the same packages.
  assert.doesNotMatch(appState, /\| "widgets"/);
  assert.doesNotMatch(appShell, /WidgetsPage/);
  assert.match(toolsPage, /function WidgetSection\(/);
});

test("the section renders above the tool packages and only what was scanned", () => {
  const widgetAt = toolsPage.indexOf("<WidgetSection");
  const toolsAt = toolsPage.indexOf('t("tools.loading")');
  assert.ok(widgetAt > 0 && toolsAt > widgetAt, "widgets render before the tool list");

  // Nothing found means nothing shown: the folder is the user's, not ours.
  assert.match(toolsPage, /if \(packages\.length === 0\) return null;/);
  assert.match(toolsPage, /data-widget-section="true"/);
  assert.match(toolsPage, /data-widget=\{pkg\.id\}/);
  assert.match(toolsPage, /data-trust=\{pkg\.trust\}/);
  assert.match(toolsStyles, /\.tools-widget-section\s*\{/);
});

test("the page reads the host list and the sidecar runtime state", () => {
  assert.match(toolsPage, /api\.listWidgets\(\)/);
  // Runtime state is advisory: a failure there must not blank the list.
  assert.match(toolsPage, /api\.widgetRuntime\(\)\.catch\(\(\) => \(\{ states: \[\] \}\)\)/);
  assert.match(toolsPage, /t\("widgets\.loadFailed", \{ message: error \}\)/);
});

test("trust is pinned to the digest the user reviewed", () => {
  assert.match(toolsPage, /api\.setWidgetTrust\(pkg\.id, pkg\.digest, trusted\)/);
  assert.match(toolsPage, /pkg\.trust === "untrusted"/);
  // An unreviewed package cannot be switched on by accident.
  assert.match(toolsPage, /disabled=\{busyId === pkg\.id \|\| pkg\.trust === "untrusted"\}/, "switch is disabled while untrusted");
  assert.match(toolsPage, /api\.setWidgetEnabled\(id, enabled\)/);
  assert.match(toolsPage, /api\.revealWidget\(id\)/);
  assert.match(toolsPage, /api\.revealWidgetsDir\(\)/);
});

test("an action can be run from the client and its result shown", () => {
  // This is the client half of the two-way contract; the agent reaches the same
  // actions through the Widget tool.
  assert.match(toolsPage, /api\.invokeWidget\(pkg\.id, actionName, \{\}\)/);
  assert.match(toolsPage, /data-widget-result=\{actionName\}/);
  assert.match(toolsPage, /formatValue\(answer\.value\)/);
  // Junk in, readable text out: an action may return anything JSON-able.
  assert.match(toolsPage, /function formatValue\(value: unknown\): string/);
  assert.match(toolsStyles, /\.widgets-action-result\.is-error\s*\{/);
});

test("a result stays collapsed until the user opens it", () => {
  // A package may return pages of JSON and one card carries several actions, so
  // the payload must not push the rest of the card off the screen.
  assert.match(toolsPage, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(toolsPage, /aria-expanded=\{expanded\}/);
  assert.match(toolsPage, /data-widget-expanded=\{expanded \? "true" : "false"\}/);
  // The status line is what remains visible: outcome and duration.
  assert.match(toolsPage, /t\("widgets\.resultOk"\)/);
  assert.match(toolsPage, /t\("widgets\.resultFailed"\)/);
  assert.match(toolsPage, /function formatDuration\(ms: number\): string/);
  // A second run collapses the previous answer instead of stacking two.
  assert.match(toolsPage, /setExpanded\(false\);\n\s*const startedAt = Date\.now\(\);/);
  assert.match(toolsStyles, /\.widgets-result-toggle\s*\{/);
  assert.match(toolsStyles, /\.widgets-result-toggle:focus-visible\s*\{/);
});

test("permissions the user did not grant are marked on the page", () => {
  assert.match(toolsPage, /requestedPermissions/);
  assert.match(toolsPage, /grantedPermissions/);
  assert.match(toolsPage, /is-denied/);
  assert.match(toolsStyles, /\.widgets-permission\.is-denied\s*\{/);
});

test("the shared, host, and IPC layers agree on the package shape", () => {
  for (const method of [
    "widgetsList",
    "widgetsSetEnabled",
    "widgetsTrust",
    "widgetsReveal",
    "widgetsRoot",
    "widgetsRuntime",
    "widgetsInvoke",
  ]) {
    assert.match(protocol, new RegExp(`${method}: "pi-desktop/widgets/`), method);
  }
  assert.match(register, /registerWidgetsIpc\(\{ registrar, getHost, getSidecar \}\)/);
  assert.match(rustCapabilities, /const MANIFEST_FILE: &str = "widget\.json";/);
  assert.match(rustCapabilities, /const PACKAGES_DIR: &str = "widgets";/);
  // The scan root is a real answer even before any package exists.
  assert.match(rustRpc, /"widgets\.root" =>/);
});

test("every locale speaks the widget section", () => {
  for (const locale of LOCALES) {
    const catalog = read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    assert.ok(
      catalog.includes(`${quote(locale, "widgets")}: {`) || catalog.includes(`\n  widgets: {`),
      `${locale} defines the widgets block`,
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
      "resultOk",
      "resultFailed",
      "showResult",
      "hideResult",
    ]) {
      assert.ok(catalog.includes(`${quote(locale, key)}`), `${locale} defines widgets.${key}`);
    }
  }
});
