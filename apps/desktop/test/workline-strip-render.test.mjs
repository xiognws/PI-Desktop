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
 * The sidebar workline strip (ADR 0385).
 *
 * The projection has its own unit tests; this one renders the real component so
 * a broken import, a missing i18n key, or a null-return regression shows up as
 * markup instead of a green pure-function suite. The host read is stubbed: an
 * effect never runs in a static render, and the strip must not touch IPC before
 * it has something to show.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API_STUB = fileURLToPath(new URL("./helpers/workline-api.stub.ts", import.meta.url));

async function withStripRender(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: "workline-api-stub",
        enforce: "pre",
        resolveId(source) {
          return source.endsWith("lib/api") ? API_STUB : null;
        },
      },
    ],
  });
  try {
    const { WorklineStrip } = await server.ssrLoadModule("/src/components/WorklineStrip.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (props) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(WorklineStrip, {
            sessions: [],
            runningSessions: {},
            pendingPermissions: {},
            onOpenSession: () => {},
            ...props,
          }),
        ),
      );
    await run({ render });
  } finally {
    await server.close();
  }
}

const sessions = [
  { id: "s1", title: "Refactor the tests" },
  { id: "s2", title: "Write the docs" },
  { id: "s3", title: "Idle session" },
];

test("an idle sidebar renders nothing at all", async () => {
  await withStripRender(({ render }) => {
    assert.equal(render({ sessions }), "");
  });
});

test("a running session renders one row with its state", async () => {
  await withStripRender(({ render }) => {
    const html = render({ sessions, runningSessions: { s1: true } });
    assert.match(html, /Refactor the tests/);
    // Structure, not copy: the catalogue is built separately from this bundle.
    assert.match(html, /class="workline-strip"/);
    assert.match(html, /class="workline-row"/);
    assert.match(html, /data-workline-state="running"/);
    // A status string the catalogue already ships proves i18n is wired up.
    assert.match(html, /Working/);
    // The idle session is history, not a workline.
    assert.doesNotMatch(html, /Idle session/);
  });
});

test("a pending permission renders as the blocked state", async () => {
  await withStripRender(({ render }) => {
    const html = render({ sessions, runningSessions: {}, pendingPermissions: { s2: [{}] } });
    assert.match(html, /Write the docs/);
    assert.match(html, /Permission required/);
    assert.match(html, /data-state="waiting"/);
  });
});
