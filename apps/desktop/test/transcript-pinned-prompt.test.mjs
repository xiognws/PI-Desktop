/*
 * Sticky latest prompt.
 *
 * The newest prompt scrolls up like any other row; once its top edge reaches the
 * top of the transcript it stays stuck to that edge, so the user keeps reading
 * what they last asked while the answer streams in underneath. The next prompt
 * takes the slot over.
 *
 * These tests pin the three pieces that make that work: which message pins, when
 * the row counts as having reached the top, and how the transcript marks the row
 * for CSS.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isPinnedPromptAtTop,
  latestUserPrompt,
  PINNED_PROMPT_ATTR,
  pinnedPromptSelector,
} from "../src/lib/pinned-prompt.ts";

function message(overrides) {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("the pin follows the newest prompt, not the newest row", () => {
  const messages = [
    message({ id: "u1", content: "first" }),
    message({ id: "a1", role: "assistant", content: "answer" }),
    message({ id: "u2", content: "second" }),
    message({ id: "a2", role: "assistant", content: "answer two", status: "streaming" }),
  ];
  assert.equal(latestUserPrompt(messages)?.id, "u2");
  assert.equal(latestUserPrompt([]), undefined);
  assert.equal(latestUserPrompt([message({ id: "a1", role: "assistant" })]), undefined);
});

test("an agent delivery is not the user speaking", () => {
  const messages = [
    message({ id: "u1", content: "mine" }),
    message({
      id: "relay",
      content: "Message from 🤖 helper: done",
      sessionMessage: { kind: "agent", sessionId: "s-other", title: "helper" },
    }),
  ];
  assert.equal(latestUserPrompt(messages)?.id, "u1", "pinning a relay would misquote the user");
});

test("the row sticks once its top edge reaches the scrollport top", () => {
  assert.equal(isPinnedPromptAtTop(100, 100), true, "meeting the top edge pins the row");
  assert.equal(isPinnedPromptAtTop(99, 100), true, "a row scrolled past stays pinned");
  assert.equal(isPinnedPromptAtTop(101, 100), false, "a row still below the edge scrolls free");
});

test("the row selector survives quotes and backslashes in an id", () => {
  assert.equal(pinnedPromptSelector('a"b\\c'), '[data-message-id="a\\"b\\\\c"]');
});

test("the transcript marks the pinned row instead of passing a flag down", async () => {
  const transcript = await readFile(
    new URL("../src/features/chat/transcript/ChatTranscript.tsx", import.meta.url),
    "utf8",
  );
  assert.match(transcript, /const pinnedMessage = useMemo\(\(\) => latestUserPrompt\(messages\)/);
  assert.match(transcript, /messageId: pinnedMessage\?\.id/);
  assert.match(transcript, /enabled: paneVisible && !find\.open/, "find owns the top edge while open");
  assert.match(
    transcript,
    /usePinnedPromptMarker\(contentRef, pinnedAtTop \? pinnedMessage\?\.id : undefined\)/,
  );
  // The old floating strip is gone: the row itself sticks now.
  assert.doesNotMatch(transcript, /<PinnedPrompt/);

  const marker = await readFile(
    new URL("../src/features/chat/transcript/hooks/usePinnedPromptMarker.ts", import.meta.url),
    "utf8",
  );
  assert.match(marker, /removeAttribute\(PINNED_PROMPT_ATTR\)/, "a stale mark is cleared first");
  assert.match(marker, /setAttribute\(PINNED_PROMPT_ATTR, "true"\)/);

  const styles = await readFile(new URL("../src/styles/chat-shell.css", import.meta.url), "utf8");
  assert.match(styles, /\.message-row\[data-pinned-prompt\] \{[\s\S]{0,200}position: sticky/);
  assert.match(styles, /\.message-row\[data-pinned-prompt\] \{[\s\S]{0,260}top: 0/);
  // `content-visibility: auto` would give the sticky box a containment context
  // and stop it tracking the scrollport, so the pinned row must opt out.
  assert.match(styles, /\.message-row\[data-pinned-prompt\] \{[\s\S]{0,260}content-visibility: visible/);
  assert.doesNotMatch(styles, /\.transcript-pinned-prompt/);
});

test("the marker attribute is the one CSS selects on", () => {
  assert.equal(PINNED_PROMPT_ATTR, "data-pinned-prompt");
});
