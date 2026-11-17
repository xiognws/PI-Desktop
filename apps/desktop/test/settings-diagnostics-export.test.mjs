/**
 * The About page's support-bundle row, rendered for real.
 *
 * Two things can break without a type error: the row can drift out of the page,
 * and `api.exportDiagnostics` can point at a channel nobody registered. So this
 * renders the page from the shipped catalogs (never a stubbed `t`) and then calls
 * the api method against a stubbed preload bridge, which is the renderer's whole
 * half of the contract. The main process's half — collect, zip, write — is
 * covered in `electron/test/diagnostics-export.test.mjs`.
 *
 * One Vite server serves both checks: starting one costs a minute on a cold
 * module graph, and neither check needs its own.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = fileURLToPath(new URL("..", import.meta.url));

test("About renders the export row, and the api method reaches its channel", async (t) => {
  const server = await createServer({
    root: here,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const i18next = (await import("i18next")).default;
  const { initReactI18next, I18nextProvider } = await import("react-i18next");
  const { catalogs } = await import("@pi-workspace/i18n");
  const { AboutSettings } = await server.ssrLoadModule(
    "/src/features/settings/pages/AboutSettings.tsx",
  );

  for (const locale of ["en", "zh-CN"]) {
    const i18n = i18next.createInstance();
    await i18n.use(initReactI18next).init({
      lng: locale,
      fallbackLng: "en",
      resources: { [locale]: { translation: catalogs[locale] } },
      initImmediate: false,
    });
    const html = renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(AboutSettings, {
          settings: null,
          saveSettings: async () => {
            throw new Error("rendering must not save settings");
          },
        }),
      ),
    );

    const settings = catalogs[locale].settings;
    assert.ok(
      html.includes(settings.diagnosticsExport),
      `${locale}: missing the export row title`,
    );
    assert.ok(
      html.includes(settings.diagnosticsExportDesc),
      `${locale}: missing the row's explanation`,
    );
    // A resolved catalog, not a raw key rendered because i18n was absent.
    assert.doesNotMatch(html, /settings\.diagnostics/, `${locale}: untranslated key`);
    // The row sits after the logs row: the bundle is the next step once someone
    // has been told where the logs are.
    assert.ok(
      html.indexOf(settings.openLogs) < html.indexOf(settings.diagnosticsExport),
      `${locale}: the export row moved above the logs row`,
    );
  }

  // The renderer's half of the IPC contract: channel name, no stray arguments,
  // and a payload this side can read as its own result type.
  const calls = [];
  const previous = globalThis.window;
  globalThis.window = {
    piDesktop: {
      invoke: async (channel, ...args) => {
        calls.push({ channel, args });
        return {
          ok: true,
          data: { ok: true, path: "/tmp/pi-diagnostics.zip", files: 2, bytes: 64 },
        };
      },
    },
  };
  t.after(() => {
    globalThis.window = previous;
  });

  const { api } = await server.ssrLoadModule("/src/lib/api.ts");
  const result = await api.exportDiagnostics();

  assert.deepEqual(calls, [{ channel: "pi-desktop/diagnostics/export", args: [] }]);
  assert.deepEqual(result, {
    ok: true,
    path: "/tmp/pi-diagnostics.zip",
    files: 2,
    bytes: 64,
  });
});
