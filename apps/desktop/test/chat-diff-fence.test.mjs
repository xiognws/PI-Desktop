import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-workspace/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  classifyDiffLine,
  isDiffFenceLanguage,
  parseDiffLines,
} from "../src/lib/diff-lines.ts";

/*
 * A unified diff pasted into a reply used to render as a plain code block: the
 * `+` / `-` prefixes were the only hint, and on a highlighted line they read as
 * punctuation. The fence now classifies its own rows, so a pasted diff and a
 * host-captured change look the same.
 */

const FENCE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const keep = true;",
  "-const removed = true;",
  "+const added = true;",
  "+const alsoAdded = true;",
  "\\ No newline at end of file",
].join("\n");

test("every diff row is classified as add, del, context, hunk or metadata", () => {
  const lines = parseDiffLines(FENCE);
  assert.deepEqual(
    lines.map((line) => line.type),
    ["meta", "meta", "meta", "meta", "hunk", "context", "del", "add", "add", "meta"],
  );
  assert.equal(lines[7].text, "+const added = true;");
});

test("a line that merely starts with a dash stays content", () => {
  // `-- ` is a removal of a line beginning with a dash, and `--- a/x` is a file
  // header — the difference decides whether the row is tinted red.
  assert.equal(classifyDiffLine("-- not a header"), "del");
  assert.equal(classifyDiffLine("--- a/src/a.ts"), "meta");
  assert.equal(classifyDiffLine("++++++"), "add");
});

test("only diff-shaped fence languages route to the diff renderer", () => {
  for (const lang of ["diff", "patch", "udiff", "DIFF"]) {
    assert.equal(isDiffFenceLanguage(lang), true, lang);
  }
  for (const lang of ["", "sql", "ts", "typescript", "markdown"]) {
    assert.equal(isDiffFenceLanguage(lang), false, lang);
  }
});

test("a diff fence renders tinted rows, and a source fence still renders a code block", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  try {
    // `useThemeMode` reads the theme off the document during render.
    globalThis.document = { documentElement: { dataset: {} } };
    const { Markdown } = await server.ssrLoadModule("/src/components/Markdown.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (source) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(Markdown, { source }),
        ),
      );

    const diff = render("```diff\n" + FENCE + "\n```\n");
    assert.match(diff, /class="code-block chat-diff"/);
    assert.match(diff, /chat-diff-body/);
    assert.equal(diff.match(/diff-line add/g)?.length, 2, diff);
    assert.equal(diff.match(/diff-line del/g)?.length, 1, diff);
    assert.equal(diff.match(/diff-line hunk/g)?.length, 1, diff);
    // The gutter sign is what makes a row readable without relying on colour.
    assert.match(diff, /class="diff-line-sign" aria-hidden="true">\+</);
    assert.match(diff, /class="diff-line-sign" aria-hidden="true">−</);
    // Metadata rows are scaffolding: no sign, muted.
    assert.match(diff, /class="diff-line meta"/);

    const sql = render("```sql\nSELECT 1;\n```\n");
    assert.match(sql, /class="code-block"/);
    assert.doesNotMatch(sql, /chat-diff/, "a source fence must not become a diff");
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});
