import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/*
 * The file manager's code view classifies tokens with CodeMirror's
 * `classHighlighter` and hands them `tok-*` class names. For a long time the
 * bundle shipped those classes and no rules for them, so every language — C,
 * C++, Python, Rust, YAML, TOML — came out in one flat colour and read as plain
 * text even though the grammar was loaded.
 *
 * These cases hold the two halves together: every class the highlighter can emit
 * must have a rule, and the file types the view claims to know must resolve to a
 * grammar.
 */

const BUNDLE = resolve(
  import.meta.dirname,
  "../resources/plugins/pi.file-manager/views/assets/index.js",
);
const source = readFileSync(BUNDLE, "utf8");

/** Class names the bundled `classHighlighter` can put on a token span. */
function emittedTokenClasses() {
  const block = source.slice(
    source.indexOf('{tag:d.link,class:"tok-link"}'),
    source.indexOf("])", source.indexOf('{tag:d.link,class:"tok-link"}')),
  );
  const names = [...block.matchAll(/class:"(tok-[A-Za-z-]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 20, `expected the highlighter table, found ${names.length}`);
  return names;
}

/** Selector text of every CSS rule in the bundle. */
function selectors() {
  return [...source.matchAll(/([^{}]*)\{[^{}]*\}/g)].map((m) => m[1]);
}

test("every token class the highlighter emits has a colour rule", () => {
  const emitted = emittedTokenClasses();
  const all = selectors().join("\n");
  const missing = emitted.filter((name) => !all.includes(`.${name}`));
  assert.deepEqual(missing, [], `unstyled token classes: ${missing.join(", ")}`);
});

test("both themes define the hues the token rules reference", () => {
  for (const needle of ["--tok-type: #e5c07b", "--tok-type: #c18401", "--tok-macro: #56b6c2", "--tok-macro: #0184bc"]) {
    assert.ok(source.includes(needle), `missing ${needle}`);
  }
});

test("the languages the view advertises resolve to a grammar", () => {
  // One entry per language, extension list plus a load factory; a file whose
  // extension is missing here is what renders as flat text.
  for (const extension of ["c", "cpp", "hpp", "py", "rs", "yml", "toml", "ini", "json", "md", "sql", "sh", "ps1", "diff"]) {
    assert.ok(
      source.includes(`"${extension}"`),
      `no grammar is bound to .${extension}`,
    );
  }
  const table = source.slice(source.indexOf("I7=["), source.indexOf("],dl=new Map"));
  const entries = table.match(/name:"[^"]+",extensions:\[[^\]]*\],(?:filenames:\[[^\]]*\],)?load:/g) ?? [];
  assert.ok(entries.length >= 30, `expected the language table, found ${entries.length} entries`);
  assert.equal((table.match(/load:\(\)=>/g) ?? []).length, entries.length);
});

test("markdown opens rendered, and .env is a config file with a grammar", () => {
  assert.ok(source.includes("mdPreview:!0"), "markdown should preview by default");
  assert.ok(
    source.includes('["properties","ini","conf","cfg","editorconfig","env"]'),
    ".env must resolve to the Properties grammar",
  );
});
