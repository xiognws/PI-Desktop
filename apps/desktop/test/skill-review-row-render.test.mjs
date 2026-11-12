import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-workspace/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * The self-improvement row under a finished turn.
 *
 * Hermes prints its review summary into the output stream the moment the pass
 * finishes, which leaves it between that turn and the next one and lets later
 * turns push it up into history. The renderer does the same by anchor: the store
 * keeps a list of notices per session, and each one remembers the newest message
 * it could see when it landed (`afterMessageId`). These tests hold that placement
 * — a review of turn 1 stays above turn 2 — plus the switch that hides the row
 * without touching the review, and the two shapes of "no row to sit under".
 *
 * The real component, store, projection, and locales are used here; only the
 * messages are fixtures.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const APPLIED = {
  id: "notice-1",
  outcome: "applied",
  reason: null,
  actions: ["created: alpha"],
};

function notice(id, afterMessageId, extra = {}) {
  return {
    id,
    outcome: "applied",
    actions: ["created: alpha"],
    ...(afterMessageId ? { afterMessageId } : {}),
    ...extra,
  };
}

function message(id, role, content, extra = {}) {
  return { id, role, content, createdAt: "2026-11-12T00:00:00.000Z", ...extra };
}

async function withReview(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const [review, store, turns, slots] = await Promise.all([
      server.ssrLoadModule("/src/features/chat/transcript/SkillReviewRow.tsx"),
      server.ssrLoadModule("/src/stores/app-store.ts"),
      server.ssrLoadModule("/src/lib/assistant-turns.ts"),
      server.ssrLoadModule("/src/plugins/renderer-slots/use-slots.tsx"),
    ]);
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const useAppStore = store.useAppStore;
    const frame = (node) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(slots.SlotSessionProvider, { sessionId: "fixture" }, node),
        ),
      );
    const render = (value, settings) => {
      // `undefined` is "the user never touched the switch", which must show the row.
      // `renderToStaticMarkup` runs React's server snapshot, and zustand answers
      // that from the store's initial state, so the switch is set there.
      const state = useAppStore.getInitialState();
      const previous = state.settings;
      state.settings = settings;
      try {
        return frame(createElement(review.SkillReviewRow, { notice: value }));
      } finally {
        state.settings = previous;
      }
    };
    const project = (messages) => {
      const { entries } = turns.buildTranscriptEntries(messages);
      return { entries: entries.slice(0, -1), tailEntry: entries.at(-1) };
    };
    const renderTranscript = ({ entries, tailEntry, notices }) =>
      frame(
        createElement(review.SkillReviewAnnotatedHistory, {
          entries,
          tailEntry,
          notices,
          isRunning: false,
        }),
      );
    await run({
      render,
      renderTranscript,
      project,
      layoutSkillReviews: review.layoutSkillReviews,
    });
  } finally {
    await server.close();
  }
}

/** Where each needle sits, so an ordering claim is one assert. */
function assertInOrder(html, needles) {
  const found = needles.map((needle) => html.indexOf(needle));
  found.forEach((index, position) => {
    assert.ok(index >= 0, `missing "${needles[position]}" in: ${html}`);
  });
  const sorted = [...found].sort((left, right) => left - right);
  assert.deepEqual(found, sorted, `out of order: ${needles.join(" < ")}`);
}

test("the row reports each write on its own line, the way Hermes does", async () => {
  await withReview(({ render }) => {
    const html = render(APPLIED, { skillReviewVisible: true });
    assert.match(html, /skill-review-row/);
    assert.match(html, /role="status"/);
    // One line per operation with a glyph, not a summary sentence: the reader
    // wants to know which skill changed, not that "1 update" happened.
    assert.match(html, /<li class="skill-review-line">✍ created: alpha<\/li>/);
    assert.doesNotMatch(html, /Self-improvement review:/);
  });
});

test("a review of the first turn renders between it and the second turn", async () => {
  await withReview(({ renderTranscript, project }) => {
    const transcript = project([
      message("u1", "user", "first prompt"),
      message("a1", "assistant", "first answer", { status: "complete" }),
      message("u2", "user", "second prompt"),
      message("a2", "assistant", "second answer", { status: "complete" }),
    ]);
    // The anchor is the newest message the session had when the review landed —
    // the last message of the turn it reviewed, not the turn row's own id.
    const html = renderTranscript({ ...transcript, notices: [notice("notice-1", "a1")] });
    assertInOrder(html, [
      "first prompt",
      "first answer",
      "skill-review-row",
      "second prompt",
      "second answer",
    ]);
    assert.equal(html.match(/class="skill-review-row"/g)?.length, 1);
  });
});

test("a review stays under its turn as later turns arrive", async () => {
  await withReview(({ renderTranscript, project }) => {
    const transcript = project([
      message("u1", "user", "first prompt"),
      message("a1", "assistant", "first answer", { status: "complete" }),
      message("u2", "user", "second prompt"),
      message("a2", "assistant", "second answer", { status: "complete" }),
      message("u3", "user", "third prompt"),
      message("a3", "assistant", "third answer", { status: "complete" }),
    ]);
    const html = renderTranscript({ ...transcript, notices: [notice("notice-1", "a1")] });
    // Two more turns later the row is still under turn 1, not at the end of the
    // transcript where it used to sit.
    assertInOrder(html, ["first answer", "skill-review-row", "second prompt"]);
  });
});

test("several reviews keep their own places, oldest first", async () => {
  await withReview(({ renderTranscript, project }) => {
    const transcript = project([
      message("u1", "user", "first prompt"),
      message("a1", "assistant", "first answer", { status: "complete" }),
      message("u2", "user", "second prompt"),
      message("a2", "assistant", "second answer", { status: "complete" }),
      message("u3", "user", "third prompt"),
      message("a3", "assistant", "third answer", { status: "complete" }),
    ]);
    const html = renderTranscript({
      ...transcript,
      notices: [
        notice("notice-1", "a1", { actions: ["created: alpha"] }),
        notice("notice-2", "a2", { actions: ["patched: beta"] }),
      ],
    });
    assertInOrder(html, [
      "first answer",
      "created: alpha",
      "second prompt",
      "second answer",
      "patched: beta",
      "third prompt",
    ]);
    assert.equal(html.match(/class="skill-review-row"/g)?.length, 2);
  });
});

test("a review of the live tail renders under it", async () => {
  await withReview(({ renderTranscript, project }) => {
    const transcript = project([
      message("u1", "user", "first prompt"),
      message("a1", "assistant", "first answer", { status: "complete" }),
    ]);
    const html = renderTranscript({ ...transcript, notices: [notice("notice-1", "a1")] });
    // The turn it reports on is still the tail when the notice lands, so the row
    // is drawn after it — the same place the next turn later pushes it out of.
    assertInOrder(html, ["first answer", "skill-review-row"]);
  });
});

test("a review whose turn is gone falls back to the end, never the top", async () => {
  await withReview(({ renderTranscript, project, layoutSkillReviews }) => {
    const transcript = project([
      message("u1", "user", "first prompt"),
      message("a1", "assistant", "first answer", { status: "complete" }),
      message("u2", "user", "second prompt"),
      message("a2", "assistant", "second answer", { status: "complete" }),
    ]);
    // Paged out, reloaded away, or landed before any transcript existed: the
    // notice still reports, at the end of the list.
    const unanchored = notice("notice-1");
    const lost = notice("notice-2", "message-that-is-gone");
    const layout = layoutSkillReviews(transcript.entries, transcript.tailEntry, [
      unanchored,
      lost,
    ]);
    assert.deepEqual(
      layout.afterTail.map((entry) => entry.id),
      ["notice-1", "notice-2"],
    );
    assert.equal(layout.segments.length, 1);
    const html = renderTranscript({ ...transcript, notices: [unanchored, lost] });
    assertInOrder(html, ["first prompt", "second answer", "skill-review-row"]);
    assert.equal(html.match(/class="skill-review-row"/g)?.length, 2);
  });
});

test("a session with no review keeps handing the pane's own array to the list", async () => {
  await withReview(({ project, layoutSkillReviews }) => {
    const transcript = project([
      message("u1", "user", "first prompt"),
      message("a1", "assistant", "first answer", { status: "complete" }),
    ]);
    // `TranscriptHistory` bails on array identity for a tail-only update, which is
    // what keeps streaming out of the settled rows. Splicing must not cost that
    // when there is nothing to splice.
    const layout = layoutSkillReviews(transcript.entries, transcript.tailEntry, undefined);
    assert.equal(layout.segments.length, 1);
    assert.equal(layout.segments[0].entries, transcript.entries);
    assert.deepEqual(layout.afterTail, []);
  });
});

test("the switch hides the row and leaves the review alone", async () => {
  await withReview(({ render }) => {
    assert.equal(render(APPLIED, { skillReviewVisible: false }), "");
    // Absent means the row shows: the review runs either way, and a missing row
    // by default would be indistinguishable from a review that never ran.
    assert.match(render(APPLIED, { skillReviewVisible: true }), /skill-review-row/);
    assert.match(render(APPLIED, undefined), /skill-review-row/);
  });
});

test("a review that never ran stays out of the transcript", async () => {
  await withReview(({ render }) => {
    // Hermes announces a review only when it landed something; the gate answers
    // describe the scheduler, so they belong in the log rather than under a turn.
    for (const reason of [
      "too-few-tools",
      "cooldown",
      "mode",
      "already-running",
      "nothing-new",
      "nothing-to-save",
      "no-tool-calls",
      "no-skill-tools:Glob,Read",
      // A fork that never completed never looked; its status is the scheduler's.
      "aborted",
      "stopped",
    ]) {
      const value = { id: "notice-1", outcome: "skipped", reason, actions: [] };
      assert.equal(render(value, { skillReviewVisible: true }), "", reason);
    }
  });
});

test("a broken review still reports", async () => {
  await withReview(({ render }) => {
    const value = { id: "notice-1", outcome: "failed", reason: "provider exploded", actions: [] };
    const html = render(value, { skillReviewVisible: true });
    assert.match(html, /skill-review-row/);
    assert.match(html, /Skill review · failed/);
  });
});
