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
 * The spawn card (ADR 0386) rendered through the real component.
 *
 * The projection has its own unit tests; this one proves the card mounts, wires
 * i18n, and marks its state, so a broken import or a null render cannot pass as
 * a green pure-function suite. Navigation is a store action and is not asserted
 * here — a static render never runs an effect or a click.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function withCardRender(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SpawnedSessionCard } = await server.ssrLoadModule(
      "/src/features/chat/transcript/SpawnedSessionCard.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (session) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(SpawnedSessionCard, { session }),
        ),
      );
    await run({ render });
  } finally {
    await server.close();
  }
}

const session = {
  sessionId: "child-1",
  messageId: "delivery-1",
  title: "Tests",
  task: "run the test suite",
  state: "running",
};

test("a running spawn renders its title, state and task", async () => {
  await withCardRender(({ render }) => {
    const html = render(session);
    assert.match(html, /class="spawned-session-card"/);
    assert.match(html, /data-state="running"/);
    assert.match(html, /Tests/);
    assert.match(html, /run the test suite/);
  });
});

test("a finished spawn drops the running mark", async () => {
  await withCardRender(({ render }) => {
    const html = render({ ...session, state: "completed" });
    assert.match(html, /data-state="completed"/);
    assert.doesNotMatch(html, /data-state="running"/);
  });
});

test("a title that repeats the task does not print it twice", async () => {
  await withCardRender(({ render }) => {
    const html = render({ ...session, title: "run the test suite" });
    assert.equal(html.split("run the test suite").length - 1, 1);
  });
});
