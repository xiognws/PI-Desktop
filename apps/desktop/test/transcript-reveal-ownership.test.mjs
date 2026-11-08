import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { transcriptRevealOwnership } = await import(
  "../src/lib/transcript-reading-position.ts"
);

const bookmark = (pinned) => ({
  pinned,
  messageId: "m1",
  offset: 24,
  scrollTop: 480,
  windowSize: 20,
});
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("an unpinned bookmark owns a reveal even when follow still reads pinned", () => {
  assert.equal(
    transcriptRevealOwnership(bookmark(false), false, true),
    "reading-position",
  );
});

test("a pending restore owns the reveal", () => {
  assert.equal(transcriptRevealOwnership(undefined, true, true), "reading-position");
});

test("a pinned pane without a bookmark bottoms", () => {
  assert.equal(transcriptRevealOwnership(undefined, false, true), "pinned");
});

test("an unpinned pane without a bookmark reapplies its retained offset", () => {
  assert.equal(transcriptRevealOwnership(undefined, false, false), "retained");
  assert.equal(transcriptRevealOwnership(bookmark(true), false, false), "retained");
});

test("both transcript hooks route the reveal edge through the shared rule", async () => {
  const [readingHook, scrollHook] = await Promise.all([
    read("../src/hooks/use-transcript-reading-position.ts"),
    read("../src/features/chat/transcript/hooks/useTranscriptScroll.ts"),
  ]);
  // The bookmark, not the possibly stale follow flag, claims an unpinned
  // reveal; the old `!pinnedRef.current` gate let follow bottom it (#1771).
  assert.match(
    readingHook,
    /bookmark\?\.pinned === false[\s\S]*?pendingRef\.current = bookmark[\s\S]*?pinnedRef\.current = false/,
  );
  assert.doesNotMatch(
    readingHook,
    /!wasVisibleRef\.current && !pinnedRef\.current/,
  );
  assert.match(scrollHook, /transcriptRevealOwnership\(/);
  assert.match(
    scrollHook,
    /ownership === "reading-position"[\s\S]*?pinnedRef\.current = false/,
  );
});

test("an explicit latest replaces a pending restore with a sampled bottom", async () => {
  const [scrollHook, readingHook] = await Promise.all([
    read("../src/features/chat/transcript/hooks/useTranscriptScroll.ts"),
    read("../src/hooks/use-transcript-reading-position.ts"),
  ]);
  // The sampler gives up while a restore is pending, so a jump started during
  // one left the old unpinned bookmark in place and the next reveal restored
  // it (#1771 keeps that bookmark authoritative). Deliberate follow therefore
  // samples through a dedicated path that ignores the pending restore.
  assert.match(
    readingHook,
    /const rememberFollow = useCallback\(\(\) => \{[\s\S]*?if \(position\) sessionReadingState\(sessionId\)\.position = position;/,
  );
  assert.match(
    readingHook,
    /captureTranscriptReadingPosition\(scroller, content, true, windowSize\)/,
  );
  assert.match(
    scrollHook,
    /const jumpToLatest = useCallback[\s\S]*?rememberFollowReadingPosition\(\);\s*latestNavigation\.start/,
  );
  assert.doesNotMatch(
    scrollHook,
    /const jumpToLatest = useCallback[\s\S]*?rememberReadingPosition\(\);[\s\S]*?latestNavigation\.start/,
  );
  // A hide can commit before the trip lands, so the arrival must re-sample the
  // scroller it actually reached instead of trusting the pre-trip offset.
  assert.match(
    scrollHook,
    /latestNavigation\.start\(\(\) => \{[\s\S]*?scrollToBottom\(\);[\s\S]*?rememberFollowReadingPosition\(\);/,
  );
});


test("lands an in-flight trip before bottoming a revealed pane", async () => {
  // A pane that hid mid-trip must not keep the navigation owner active: its
  // frames measure a hidden box and would swallow the reveal's bottom scroll.
  const ring = await read("../src/hooks/use-transcript-reading-position.ts");
  const latestJ = await read("../src/features/chat/transcript/hooks/useTranscriptLatestNavigation.ts");
  const scrollJ = await read("../src/features/chat/transcript/hooks/useTranscriptScroll.ts");
  assert.match(latestJ, /if \(!visible\) navigation\.landed\(\);/);
  assert.match(scrollJ, /if \(ownership === "pinned"\) \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*latestNavigation\.landed\(\);\s*scrollToBottom\(\);/);
  assert.match(scrollJ, /if \(latestNavigation\.phase\(\) === "moving"\) return;/);
  assert.ok(ring.includes("rememberFollow"));
});
