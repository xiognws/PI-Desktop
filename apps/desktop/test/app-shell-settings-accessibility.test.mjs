import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);

test("settings hides and inerts chat without aria-hiding a focused descendant", () => {
  const chatShell = appShell.match(
    /<div\s+className="app-chat-shell"[\s\S]*?>/,
  )?.[0];

  assert.ok(chatShell, "chat shell must exist");
  assert.match(chatShell, /hidden=\{page === "settings"\}/);
  assert.match(chatShell, /inert=\{page === "settings" \? true : undefined\}/);
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
    appShell,
    /const loadChatSurface = \(\) => import\("\.\.\/\.\.\/components\/ChatSurface"\)/,
  );
  assert.match(appShell, /const ChatSurface = lazy\(\(\) =>\s*loadChatSurface\(\)/);
  assert.match(appShell, /useEffect\(\(\) => \{\s*void loadChatSurface\(\)\.catch/);
  assert.doesNotMatch(appShell, /import \{ ChatSurface \} from/);
  assert.match(
    appShell,
    /<Suspense fallback=\{<RoutePending \/>\}>[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>[\s\S]*?<\/Suspense>/,
  );
  assert.match(
    appShell,
    /className="app-chat-shell"[\s\S]*?hidden=\{page === "settings"\}[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>/,
  );
});

test("settings does not reserve the status bar the chat shell is hiding", async () => {
  const baseStyles = await readFile(new URL("../src/styles/base.css", import.meta.url), "utf8");
  const settingsStyles = await readFile(new URL("../src/styles/settings.css", import.meta.url), "utf8");

  // The reserve exists for the chat window's fixed status bar...
  assert.match(baseStyles, /\.app-shell \{[\s\S]{0,400}padding-bottom: 30px/);
  // ...which is the sidebar's fixed footer, so hiding the chat shell hides it.
  assert.match(appShell, /className="app-chat-shell"[\s\S]{0,120}hidden=\{page === "settings"\}/);
  // Settings replaces the whole shell: without this the page ends 30px above the
  // window edge and an empty band shows where the bar used to be.
  assert.match(settingsStyles, /\.app-shell\.settings-mode \{[\s\S]{0,400}padding-bottom: 0/);
});
