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
 * What the status bar shows for an in-app provider's balance.
 *
 * The rule under test is the one the user stated: the chip exists only for a
 * metered account with credit left. No surface, an unmetered plan, a failed
 * read and a zero balance must render nothing at all — not a dash, not a zero,
 * and no layout box. Each case is rendered through the real component and the
 * real locale, so the assertion is what the user sees.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const SURFACE = {
  id: "workbuddy",
  label: "WorkBuddy",
  enabled: true,
  port: 18765,
  running: true,
  providerId: "row-workbuddy",
  creditsPath: "/workbuddy/v1/credits",
};

const credits = (over = {}) => ({
  total: 2452.71,
  accounts: [{ name: "enterprise", remain: 2452.71, size: 10000 }],
  free: false,
  fetchedAt: Date.UTC(2026, 10, 13, 10, 30),
  ...over,
});

async function withRender(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { StatusBarCreditsView } = await server.ssrLoadModule(
      "/src/components/StatusBarCredits.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (props) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(StatusBarCreditsView, {
            surface: SURFACE,
            credits: null,
            pending: false,
            onRefresh: () => {},
            ...props,
          }),
        ),
      );
    await run({ render });
  } finally {
    await server.close();
  }
}

test("a metered balance with credit left shows the number and its unit", async () => {
  await withRender(({ render }) => {
    const html = render({ credits: credits() });
    assert.match(html, /statusbar-credits-chip/);
    assert.match(html, /2,452\.71/, "the balance is shown as the account spells it");
    assert.match(html, /credits/);
  });
});

test("an unmetered plan renders nothing at all", async () => {
  await withRender(({ render }) => {
    assert.equal(render({ credits: credits({ free: true }) }), "");
  });
});

test("a zero balance renders nothing at all", async () => {
  await withRender(({ render }) => {
    assert.equal(render({ credits: credits({ total: 0 }) }), "");
  });
});

test("a failed read renders nothing at all", async () => {
  await withRender(({ render }) => {
    assert.equal(render({ credits: null, reason: "unavailable" }), "");
    assert.equal(render({ credits: null, reason: "session_dead" }), "");
  });
});

test("a provider without a credit surface renders nothing at all", async () => {
  await withRender(({ render }) => {
    const { creditsPath, ...bare } = SURFACE;
    const html = render({ surface: bare, credits: credits() });
    assert.equal(html, "");
  });
});
