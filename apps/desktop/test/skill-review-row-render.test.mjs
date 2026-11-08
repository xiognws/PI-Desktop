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
 * Two things decide whether a person ever sees it: the notice must belong to the
 * turn it describes (a newer turn must not inherit an older verdict), and the
 * Skills settings switch must hide the row without touching the review. The real
 * component, store, and locales are rendered here; only the notice is placed by
 * the test.
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
    const render = (notice, turnId, settings) => {
      const state = useAppStore.getInitialState();
      Object.assign(state, {
        skillReviewBySession: notice ? { s1: notice } : {},
        settings: settings === undefined ? state.settings : settings,
      });
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(SkillReviewRow, { sessionId: "s1", turnId }),
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
  turnId: "turn-2",
};

test("the row reports the review under the turn it belongs to", async () => {
  await withRow(({ render }) => {
    const html = render(applied, "turn-2", { skillReviewVisible: true });
    assert.match(html, /skill-review-row/);
    assert.match(html, /created: alpha/);
    assert.match(html, /role="status"/);
  });
});

test("a newer turn does not inherit the previous turn's verdict", async () => {
  await withRow(({ render }) => {
    assert.equal(render(applied, "turn-3", { skillReviewVisible: true }), "");
  });
});

test("the switch hides the row and leaves the notice alone", async () => {
  await withRow(({ render }) => {
    assert.equal(render(applied, "turn-2", { skillReviewVisible: false }), "");
    // Absent means the row shows: the review runs either way, and a missing row
    // by default would be indistinguishable from a review that never ran.
    assert.match(render(applied, "turn-2", { skillReviewVisible: undefined }), /skill-review-row/);
  });
});
