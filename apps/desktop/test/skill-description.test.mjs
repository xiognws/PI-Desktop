import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG_DESCRIPTION_CHARS, catalogLine } from "../src/lib/skill-description.ts";

test("a description that fits is used as written", () => {
  const line = catalogLine("Turn a folder into a skill");
  assert.equal(line.text, "Turn a folder into a skill");
  assert.equal(line.shortened, false);
});

test("the limit is the number the catalog shows", () => {
  assert.equal(CATALOG_DESCRIPTION_CHARS, 60);
});

test("wrapped frontmatter collapses to one line before measuring", () => {
  const line = catalogLine("Learn from\n   a folder\nand write one skill", 60);
  assert.equal(line.text, "Learn from a folder and write one skill");
  assert.equal(line.shortened, false);
});

test("a long description keeps its first sentence when that sentence fits", () => {
  const text =
    "Turn any folder into a skill. It reads the files, follows the authoring guide, and writes exactly one document.";
  const line = catalogLine(text);
  assert.equal(line.text, "Turn any folder into a skill.");
  assert.equal(line.shortened, true);
  assert.ok(line.text.length <= CATALOG_DESCRIPTION_CHARS);
});

test("a first sentence that is itself too long is cut at a word boundary", () => {
  const text =
    "Read every markdown file in a repository and distil the repeated procedure into one skill document that the agent can load later";
  const line = catalogLine(text);
  assert.equal(line.shortened, true);
  assert.ok(line.text.length <= CATALOG_DESCRIPTION_CHARS, line.text);
  assert.ok(line.text.endsWith("…"));
  assert.ok(!line.text.includes("  "));
  assert.ok(line.text.startsWith("Read every markdown"), line.text);
});

test("a CJK description with no spaces is cut inside the limit", () => {
  const text =
    "把任意目录里的资料读一遍，提炼出可以复用的流程，最后写成一个技能文档供以后加载使用，不要遗漏关键命令的执行顺序，也不要把一次性的临时操作写进去，写完还要说明这个技能什么时候该被加载起来用";
  assert.ok(text.length > CATALOG_DESCRIPTION_CHARS);
  const line = catalogLine(text);
  assert.equal(line.shortened, true);
  assert.ok(line.text.length <= CATALOG_DESCRIPTION_CHARS, `${line.text} (${line.text.length})`);
  assert.ok(line.text.endsWith("…"));
});

test("an empty or whitespace description stays empty rather than becoming an ellipsis", () => {
  assert.deepEqual(catalogLine(""), { text: "", shortened: false });
  assert.deepEqual(catalogLine("   \n  "), { text: "", shortened: false });
});
