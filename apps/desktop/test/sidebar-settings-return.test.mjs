import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextSidebarTransition } from "../src/features/app/useSidebarTransition.ts";
import { loadStyles } from "./helpers/styles.mjs";

const idle = (collapsed = false, presented = true) => ({ collapsed, presented, phase: "idle" });

/**
 * The chat shell lives in `features/surfaces/chat/` since ADR 0410, and it hides
 * for two reasons now: the Settings takeover, and another surface being on
 * screen. Both go through one computed flag, so the portal layer that must not
 * render over Settings follows both without a second condition to keep in sync.
 */
test("Settings hides the mounted chat shell and keeps its portal layers out of view", async () => {
  const [chatShellSource, appShell, styles, portalVisibility] = await Promise.all([
    readFile(
      new URL("../src/features/surfaces/chat/ChatSurfaceShell.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/features/app/AppShell.tsx", import.meta.url), "utf8"),
    loadStyles(),
    readFile(new URL("../src/lib/portal-visibility.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(
    chatShellSource,
    /const hidden = page === "settings" \|\| surface !== "chat";/,
  );
  assert.match(chatShellSource, /<PortalVisibilityProvider visible=\{!hidden\}>/);
  assert.match(chatShellSource, /className="app-chat-shell"[\s\S]*?hidden=\{hidden\}/);
  assert.match(chatShellSource, /inert=\{hidden \? true : undefined\}/);
  const chatShell = chatShellSource.match(/<div\s+className="app-chat-shell"[\s\S]*?>/)?.[0];
  assert.ok(chatShell, "chat shell must exist");
  assert.doesNotMatch(chatShell, /aria-hidden/);
  assert.match(
    chatShellSource,
    /className="app-chat-shell"[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>/,
  );
  // The takeover itself is the window's, above every surface.
  assert.match(appShell, /\{page === "settings" \? \([\s\S]*?<SettingsPage \/>/);
  // Global search covers whichever surface is up, so it is mounted with the
  // window rather than inside the chat shell.
  assert.match(appShell, /<SearchDialog[\s\S]{0,80}open=\{searchOpen\}/);
  assert.match(styles, /\.app-chat-shell\s*\{\s*display:\s*contents;/);
  assert.match(styles, /\.app-chat-shell\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(portalVisibility, /<PortalVisibilityContext\.Consumer>[\s\S]*visible \? node : null/);
  assert.match(portalVisibility, /createPortal\(visiblePortalContent\(node\), document\.body\)/);
});

test("initial shell presentation and settings return never play sidebar entrance", () => {
  assert.deepEqual(nextSidebarTransition(idle(false, false), false, true), idle());
  for (const collapsed of [false, true]) {
    const hidden = nextSidebarTransition(idle(collapsed), collapsed, false);
    assert.deepEqual(hidden, idle(collapsed, false));
    assert.deepEqual(nextSidebarTransition(hidden, collapsed, true), idle(collapsed));
  }
});
