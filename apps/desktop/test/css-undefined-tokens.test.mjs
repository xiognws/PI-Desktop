import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/*
 * Every `var(--ds-*)` must name a token some stylesheet declares.
 *
 * A misspelt or renamed token does not fail a build, a type check or a render
 * test: CSS substitution happens at computed-value time, so the declaration is
 * simply dropped. That is how the pinned prompt row shipped with
 * `background: var(--ds-bg)` - no `--ds-bg` exists, so the row was transparent
 * and the answer streamed through it. Names one hyphen away from a real token
 * (`--ds-border`, `--ds-text-tertiary`, `--ds-accent-foreground`) are the whole
 * failure mode, so they are checked mechanically.
 */

const STYLES = join(import.meta.dirname, "..", "src", "styles");

function sheets() {
  return readdirSync(STYLES)
    .filter((name) => name.endsWith(".css"))
    .map((name) => ({ name, text: readFileSync(join(STYLES, name), "utf8") }));
}

test("every design token a stylesheet references is declared", () => {
  const defined = new Set();
  const declaration = /(--[a-z0-9-]+)\s*:/g;
  const reference = /var\(\s*(--[a-z0-9-]+)\s*(,)?/g;
  const missing = [];

  for (const { text } of sheets()) {
    for (const match of text.matchAll(declaration)) defined.add(match[1]);
  }

  for (const { name, text } of sheets()) {
    for (const match of text.matchAll(reference)) {
      const token = match[1];
      // A fallback is a deliberate answer, not a missing token.
      if (!token.startsWith("--ds") || match[2] || defined.has(token)) continue;
      missing.push(`${name}: ${token}`);
    }
  }

  assert.deepEqual(missing, [], "undefined design tokens are dropped silently at computed-value time");
});

test("the pinned prompt row paints an opaque surface", () => {
  /*
   * The row sticks to the top of the transcript while the answer scrolls
   * underneath it, so it has to paint. `transparent` there means the text of
   * both layers overlaps, which reads as "the pin does not work".
   */
  const sheet = sheets().find(({ name }) => name === "chat-shell.css");
  assert.ok(sheet, "chat-shell.css is missing");
  const rule = sheet.text.match(/\.message-row\[data-pinned-prompt\]\s*\{([^}]*)\}/);
  assert.ok(rule, "the pinned prompt rule is missing");
  assert.match(rule[1], /position:\s*sticky/);
  const background = rule[1].match(/background:\s*([^;]+);/);
  assert.ok(background, "the pinned row must paint a background");
  assert.doesNotMatch(background[1], /transparent/, "a pinned row with a transparent surface hides its own text");
  assert.match(background[1], /var\(--ds-bg-primary\)|var\(--ds-bg-secondary\)/, "the background must be a real surface token");
});
