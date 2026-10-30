import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();
const zhLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);

test("the sidebar footer is an action bar, not a fabricated identity", () => {
  // The app has no accounts; an avatar with a name implied one that never existed.
  assert.doesNotMatch(sidebarSource, /footer-profile/);
  assert.doesNotMatch(sidebarSource, /profile-menu/);
  assert.doesNotMatch(sidebarSource, /sidebar-profile-menu/);
  assert.doesNotMatch(sidebarSource, /IconUser/);
  assert.doesNotMatch(globalStyles, /\.footer-profile/);
  assert.doesNotMatch(globalStyles, /\.profile-menu/);
  for (const locale of [zhLocale, enLocale]) {
    assert.doesNotMatch(locale, /localProfile:/);
    assert.doesNotMatch(locale, /openProfileMenu:/);
  }
});

test("footer exposes settings, plugins, scheduled tasks and notifications in one row", () => {
  assert.match(sidebarSource, /className="footer-actions"/);
  assert.match(sidebarSource, /data-nav="settings"/);
  assert.match(sidebarSource, /data-nav="plugins"/);
  const pluginsAction = sidebarSource.match(
    /<TooltipButton[\s\S]*?data-nav="plugins"[\s\S]*?<\/TooltipButton>/,
  )?.[0] ?? "";
  assert.match(pluginsAction, /<IconPlug size=\{14\} aria-hidden \/>/);
  assert.doesNotMatch(sidebarSource, /data-nav="theme"/);
  assert.match(
    sidebarSource,
    /<NotificationCenter onBeforeOpen=\{\(\) => closeMenus\(false\)\} \/>/,
  );
  // Logs live in Settings → About; the footer stays down to daily controls.
  assert.doesNotMatch(sidebarSource, /openLogs/);
  // Every action is icon-only, so each needs a label for pointer and AT users.
  const actions = sidebarSource
    .split("<TooltipButton")
    .filter((chunk) => /className=(?:"footer-action"|\{`footer-action )/.test(chunk));
  assert.equal(actions.length, 3);
  for (const action of actions) {
    const attrs = action.slice(0, action.indexOf(">"));
    assert.match(attrs, /tooltip=/);
    assert.match(attrs, /ariaLabel=/);
  }
  // All footer destinations report their active state to assistive tech; the
  // Plugins button also reports the Back toggle a second activation performs.
  const footerAttributes = (marker) => {
    const at = sidebarSource.indexOf(marker);
    if (at < 0) return "";
    return sidebarSource.slice(
      sidebarSource.lastIndexOf("<TooltipButton", at),
      sidebarSource.indexOf("</TooltipButton>", at),
    );
  };
  assert.match(
    footerAttributes('data-nav="settings"'),
    /aria-pressed=\{page === "settings"\}/,
  );
  assert.match(
    footerAttributes('data-nav="plugins"'),
    /aria-pressed=\{page === "plugins"\}/,
  );
  assert.match(footerAttributes('data-nav="scheduled"'), /aria-pressed=\{page === "scheduled"\}/);
});

test("footer is the window-wide status bar, and the shell reserves its height", () => {
  // The bar is not a sidebar footer any more: it spans the window so the session
  // frame sits above it, which is why it is fixed to the bottom edge and why a
  // hairline is what separates it from the content rather than a sidebar rule.
  const block = globalStyles.match(/\.sidebar-footer\s*\{[^}]+/)?.[0] ?? "";
  assert.match(block, /position:\s*fixed/);
  assert.match(block, /inset-inline:\s*0/);
  assert.match(block, /bottom:\s*0/);
  assert.match(block, /height:\s*30px/);
  assert.match(block, /padding:\s*0 12px/);
  assert.match(block, /border-top:\s*1px solid var\(--ds-border-subtle\)/);
  // A fixed bar hides the last rows unless the shell pays for it.
  const shell = globalStyles.match(/\.app-shell\s*\{[^}]+/)?.[0] ?? "";
  assert.match(shell, /padding-bottom:\s*30px/);
  assert.match(globalStyles, /\.footer-build\s*\{[^}]*padding:\s*5px 8px/s);
});

test("footer action buttons share the notification trigger's hit target", () => {
  const block = globalStyles.match(/\.footer-action\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(block, /width:\s*32px/);
  assert.match(block, /height:\s*32px/);
  assert.match(block, /transition:[^;]*var\(--motion-duration-fast\)/);
});

test("build chip surfaces the version and only dots an actionable update", () => {
  assert.match(sidebarSource, /const update = useUpdateState\(\)/);
  assert.match(
    sidebarSource,
    /update\?\.status === "available" \|\| update\?\.status === "downloaded"/,
  );
  assert.match(sidebarSource, /className="footer-build-dot"/);
  // An actionable update routes to the Settings row that can act on it.
  assert.match(sidebarSource, /setSettingsAnchor\("updates\.title"\)/);
  assert.match(sidebarSource, /setSettingsTab\("about"\)/);
  assert.match(sidebarSource, /api\.updatesCheck\(\)/);
  const dot = globalStyles.match(/\.footer-build-dot\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(dot, /background:\s*var\(--ds-accent\)/);
});
