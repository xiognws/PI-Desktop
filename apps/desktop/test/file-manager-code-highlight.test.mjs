import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/*
 * What the file manager's code view promises, held as a source contract.
 *
 * The editor gets its syntax colours from a CodeMirror `HighlightStyle` with
 * inline colours (the `gr.define([{tag:..., color:...}])` pair in the bundle) and
 * its grammar from the `LanguageDescription` table `I7`. Those two are what make
 * a `.cpp` or `.rs` file readable; a file type missing from the table is the one
 * that renders as flat text, so the table is what this file pins.
 */

const BUNDLE = resolve(
  import.meta.dirname,
  "../resources/plugins/pi.file-manager/views/assets/index.js",
);
const source = readFileSync(BUNDLE, "utf8");
const table = () =>
  source.slice(source.indexOf("I7=["), source.indexOf("],dl=new Map"));

test("every common code and config extension is bound to a grammar", () => {
  const entries = table();
  assert.ok(entries.length > 500, "the language table must be present");

  const bound = new Set(
    [...entries.matchAll(/extensions:\[([^\]]*)\]/g)]
      .flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])),
  );
  for (const extension of [
    // the languages a desktop project is actually made of
    "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "ino",
    "py", "pyi", "rs", "go", "java", "kt", "cs", "php", "rb", "lua", "sql",
    // configuration
    "json", "jsonc", "yml", "yaml", "toml", "ini", "conf", "cfg", "properties", "editorconfig", "env",
    // scripts, docs, everything else
    "sh", "bash", "zsh", "ps1", "diff", "patch", "md", "markdown", "mdx",
    "html", "css", "xml", "vue",
  ]) {
    assert.ok(bound.has(extension), `no grammar is bound to .${extension}`);
  }
});

test("files that carry no extension still get a language by name", () => {
  const entries = table();
  for (const filename of ["Dockerfile", "Containerfile", "Gemfile", "Rakefile"]) {
    assert.ok(entries.includes(`"${filename}"`), `${filename} is not mapped by name`);
  }
});

test("the syntax colours are real, for both themes", () => {
  // Inline colours, not CSS classes: a class table with no rules paints nothing,
  // and this view shipped such a table once (it is dead code, not a style).
  const dark = source.slice(source.indexOf("y$=gr.define("), source.indexOf("b$=gr.define("));
  const light = source.slice(source.indexOf("b$=gr.define("), source.indexOf("Sb=t=>"));
  for (const [theme, block] of [["dark", dark], ["light", light]]) {
    assert.ok(block.length > 200, `${theme} highlight style missing`);
    assert.match(block, /color:"#[0-9a-f]{6}"/i, `${theme} style carries no colours`);
    assert.ok(!/class:"tok-/.test(block), `${theme} style emits classes instead of colours`);
  }
  // ...and the editor installs it.
  assert.match(source, /Rb\.of\(Ub\(t\)\)/, "the editor does not install the highlight style");
});

test("markdown opens rendered, and .env is a config file with a grammar", () => {
  assert.ok(source.includes("mdPreview:!0"), "markdown should preview by default");
  assert.ok(
    source.includes('["properties","ini","conf","cfg","editorconfig","env"]'),
    ".env must resolve to the Properties grammar",
  );
});
