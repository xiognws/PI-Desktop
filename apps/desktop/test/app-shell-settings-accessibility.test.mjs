/**
 * Settings replaces the whole window (D063), and the chat shell it covers has to
 * be hidden without being aria-hidden: a focused descendant inside `aria-hidden`
 * is an accessibility error, so the shell uses `hidden` + `inert` instead.
 *
 * The chat shell lives in `features/surfaces/chat/ChatSurfaceShell.tsx` since the
 * surface split (ADR 0410) — it also hides while another surface is on screen —
 * while `AppShell` keeps the window: the takeover itself, the overlays that must
 * cover any surface, and the status-bar reserve.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);
const chatShellSource = await readFile(
  new URL("../src/features/surfaces/chat/ChatSurfaceShell.tsx", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);

test("settings hides and inerts chat without aria-hiding a focused descendant", () => {
  // One computed flag drives both attributes: the Settings takeover and another
  // surface on screen hide the chat shell for the same reason.
  assert.match(chatShellSource, /const hidden = page === "settings" \|\| surface !== "chat";/);
  const chatShell = chatShellSource.match(/<div\s+className="app-chat-shell"[\s\S]*?>/)?.[0];

  assert.ok(chatShell, "chat shell must exist");
  assert.match(chatShell, /hidden=\{hidden\}/);
  assert.match(chatShell, /inert=\{hidden \? true : undefined\}/);
  assert.doesNotMatch(chatShell, /aria-hidden/);
});

test("entering Settings moves focus to its first search control", () => {
  assert.match(settingsPage, /const settingsSearchRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(
    settingsPage,
    /settingsSearchRef\.current\?\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(settingsPage, /<input\s+ref=\{settingsSearchRef\}/);
});

test("chat code loads inside the existing route boundary and stays mounted in Settings", () => {
  assert.match(
    chatShellSource,
    /const loadChatSurface = \(\) => import\("\.\.\/\.\.\/\.\.\/components\/ChatSurface"\)/,
  );
  // The route is wrapped in `lazyRoute` so one failed module fetch retries instead
  // of replacing the surface with the crash panel (ADR 0392); the loader itself is
  // still the same `import()`.
  assert.match(
    chatShellSource,
    /const ChatSurface = lazy\(\s*\(\) =>\s*lazyRoute\(loadChatSurface\)\(\)/,
  );
  assert.match(chatShellSource, /useEffect\(\(\) => \{\s*void loadChatSurface\(\)\.catch/);
  assert.doesNotMatch(chatShellSource, /import \{ ChatSurface \} from/);
  assert.match(
    chatShellSource,
    /<Suspense fallback=\{<RoutePending \/>\}>[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>[\s\S]*?<\/Suspense>/,
  );
  // The chat surface itself is mounted by the registry, not by a route branch:
  // it is the home surface and stays mounted for the whole session.
  assert.match(chatShellSource, /className="app-chat-shell"/);
  assert.match(chatShellSource, /<ChatSurface visible=\{page === "chat"\} \/>/);
  // Settings is rendered by the window, above every surface.
  assert.match(appShell, /page === "settings" \? \(/);
  assert.match(appShell, /import\("\.\.\/\.\.\/pages\/SettingsPage"\)/);
});

test("settings does not reserve the status bar the chat shell is hiding", async () => {
  const baseStyles = await readFile(new URL("../src/styles/base.css", import.meta.url), "utf8");
  const settingsStyles = await readFile(new URL("../src/styles/settings.css", import.meta.url), "utf8");

  // The reserve exists for the chat window's fixed status bar...
  assert.match(baseStyles, /\.app-shell \{[\s\S]{0,400}padding-bottom: 30px/);
  // ...which is the sidebar's fixed footer, so hiding the chat shell hides it.
  assert.match(
    chatShellSource,
    /className="app-chat-shell"[\s\S]{0,120}hidden=\{hidden\}/,
  );
  // Settings replaces the whole shell: without this the page ends 30px above the
  // window edge and an empty band shows where the bar used to be.
  assert.match(settingsStyles, /\.app-shell\.settings-mode \{[\s\S]{0,900}padding-bottom: 0/);
});
