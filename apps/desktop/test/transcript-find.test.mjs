/**
 * Contract tests for find-in-conversation.
 *
 * The shortcut is registry-owned and the transcript owns the text, so the two
 * halves are tested where they live: the registry carries the id and its
 * default binding, the shell forwards the keystroke instead of searching
 * itself, and the bar reuses the highlight helpers global search already had.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const shortcuts = await read("../../../packages/shared/src/keyboard-shortcuts.ts");
const helper = await read("../../../packages/shared/src/transcript-find.ts");
const requestModule = await read("../src/lib/transcript-find-request.ts");
const runtime = await read("../src/features/app/useAppShellRuntime.tsx");
const transcript = await read("../src/features/chat/transcript/ChatTranscript.tsx");
const bar = await read("../src/features/chat/transcript/TranscriptFindBar.tsx");
const hook = await read("../src/features/chat/transcript/use-transcript-find.ts");
const styles = await read("../src/styles/chat-shell.css");
const highlights = await read("../src/styles/messages.css");
const en = await read("../../../packages/i18n/src/locales/en/index.ts");
const zh = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");

test("the shortcut is part of the configurable registry, next to global search", () => {
  assert.match(shortcuts, /"findInTranscript",/);
  assert.match(shortcuts, /id: "findInTranscript",\s*\n\s*group: "navigation",\s*\n\s*defaultBinding: "Mod\+F",/);
  // Global search keeps Mod+K; the two must not share a keystroke.
  assert.match(shortcuts, /id: "openSearch", group: "navigation", defaultBinding: "Mod\+K" \}/);
});

test("the shell forwards the keystroke instead of searching itself", () => {
  assert.match(runtime, /import \{ requestTranscriptFind \} from "\.\.\/\.\.\/lib\/transcript-find-request";/);
  assert.match(runtime, /case "findInTranscript":[\s\S]{0,160}requestTranscriptFind\(\);/);
  // One forwarding site: the shortcut switch. The menu-command switch speaks a
  // different vocabulary and must not learn this id.
  assert.equal(runtime.match(/requestTranscriptFind\(\);/g)?.length, 1);
  assert.match(requestModule, /export function requestTranscriptFind\(\)/);
});

test("the bar is mounted by the transcript, over the rows it searches", () => {
  assert.match(transcript, /const find = useTranscriptFind\(contentRef, scrollRef, releaseFollow\);/);
  assert.match(transcript, /\{find\.open \? \(\s*<TranscriptFindBar/);
  // Enter steps, Shift+Enter steps back, Escape closes — the browser's own pair.
  assert.match(bar, /event\.key === "Escape"[\s\S]{0,120}onClose\(\);/);
  assert.match(bar, /event\.key === "Enter"[\s\S]{0,120}onStep\(event\.shiftKey \? -1 : 1\)/);
  assert.match(styles, /\.transcript-find \{[\s\S]*?position: absolute;/);
  // The steps are labelled: an arrow alone reads as decoration beside a count.
  assert.match(bar, /className="transcript-find-step"[\s\S]{0,220}<span>\{t\("chat\.findPrevious"\)\}<\/span>/);
  assert.match(bar, /className="transcript-find-step"[\s\S]{0,220}<span>\{t\("chat\.findNext"\)\}<\/span>/);
});

test("matches come from the rendered text and reuse the search helpers", () => {
  assert.match(hook, /import \{ transcriptSearchRanges \} from "\.\.\/\.\.\/\.\.\/lib\/transcript-search-highlight";/);
  assert.match(hook, /const found = transcriptSearchRanges\(root, query\);/);
  assert.match(hook, /stepFindIndex\(current, ranges\.current\.length, delta\)/);
  // Two highlight groups: the set, and the one being read.
  assert.match(hook, /CSS\.highlights\.set\(ALL_HIGHLIGHT, new Highlight\(\.\.\.ranges\.current\)\)/);
  assert.match(hook, /CSS\.highlights\.set\(ACTIVE_HIGHLIGHT, new Highlight\(range\)\)/);
  assert.match(highlights, /::highlight\(transcript-find\)/);
  assert.match(highlights, /::highlight\(transcript-find-active\)/);
  // Stepping scrolls the transcript itself: the target row is paint-contained
  // until it is marked, and pinned-follow would pull the view back.
  assert.match(hook, /export function useTranscriptFind\(\s*content: RefObject<HTMLElement \| null>,\s*scroller: RefObject<HTMLElement \| null>,\s*releaseFollow\?: \(\) => void,/);
  assert.match(hook, /row\.classList\.add\(TARGET_CLASS\)/);
  assert.match(hook, /box\.scrollTop \+= measure\.top - viewport\.top/);
  assert.doesNotMatch(hook, /\.scrollIntoView\(/);
  assert.match(highlights, /\.message-row\.transcript-find-target \{\s*content-visibility: visible;/);
  // The transcript hands the hook its scroller and the follow release.
  assert.match(transcript, /useTranscriptFind\(contentRef, scrollRef, releaseFollow\)/);
  // Stepping and wrapping are pure arithmetic, covered by the shared tests.
  assert.match(helper, /export function stepFindIndex\(/);
  assert.match(helper, /export function findPosition\(/);
});

test("the bar speaks nine locales and names its own shortcut", () => {
  for (const locale of [en, zh]) {
    assert.match(locale, /findInConversation:/);
    assert.match(locale, /findPosition: "\{\{current\}\} of \{\{total\}\}"|findPosition: "\{\{current\}\} \/ \{\{total\}\}"/);
    assert.match(locale, /findPrevious:/);
    assert.match(locale, /findNext:/);
    assert.match(locale, /findClose:/);
    assert.match(locale, /findInTranscript:/);
  }
});
