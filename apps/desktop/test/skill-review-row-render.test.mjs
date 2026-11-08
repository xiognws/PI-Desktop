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
 * Two things decide whether a person ever sees it: the notice must survive
 * later turns (it describes the last review of the session, and the transcript
 * draws it as the history list's trailing slot), and the Skills settings switch
 * must hide the row without touching the review. The real component, store, and
 * locales are rendered here; only the notice is placed by the test.
 *
 * A preceding revision compared a turn id passed down from the transcript, but
 * the transcript's row ids and the runtime's turn ids are different namespaces:
 * the comparison never matched, so the row never rendered. Position decides it now.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function withRow(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SkillReviewRow } = await server.ssrLoadModule(
      "/src/features/chat/transcript/SkillReviewRow.tsx",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (notice, settings) => {
      const state = useAppStore.getInitialState();
      Object.assign(state, {
        skillReviewBySession: notice ? { s1: notice } : {},
        settings: settings === undefined ? state.settings : settings,
      });
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(SkillReviewRow, { sessionId: "s1" }),
        ),
      );
    };
    await run({ render });
  } finally {
    await server.close();
  }
}

const applied = {
  outcome: "applied",
  reason: null,
  actions: ["created: alpha"],
};

test("the row reports the review under the turn it belongs to", async () => {
  await withRow(({ render }) => {
    const html = render(applied, { skillReviewVisible: true });
    assert.match(html, /skill-review-row/);
    assert.match(html, /Self-improvement review: created: alpha/);
    assert.match(html, /role="status"/);
  });
});

test("the row survives later turns until the next review lands", async () => {
  await withRow(({ render }) => {
    // It is drawn as the trailing slot, so it is the row under the newest turn;
    // clearing it per turn would make the line vanish the moment anything streams.
    assert.match(render(applied, { skillReviewVisible: true }), /skill-review-row/);
  });
});

test("the switch hides the row and leaves the notice alone", async () => {
  await withRow(({ render }) => {
    assert.equal(render(applied, { skillReviewVisible: false }), "");
    // Absent means the row shows: the review runs either way, and a missing row
    // by default would be indistinguishable from a review that never ran.
    assert.match(render(applied, { skillReviewVisible: undefined }), /skill-review-row/);
  });
});

test("a review that never ran stays out of the transcript", async () => {
  await withRow(({ render }) => {
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
      const notice = { outcome: "skipped", reason, actions: [] };
      assert.equal(render(notice, { skillReviewVisible: true }), "", reason);
    }
  });
});

test("a broken review still reports", async () => {
  await withRow(({ render }) => {
    const notice = { outcome: "failed", reason: "provider exploded", actions: [] };
    const html = render(notice, { skillReviewVisible: true });
    assert.match(html, /skill-review-row/);
    assert.match(html, /Skill review · failed/);
  });
});
