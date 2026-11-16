import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { AstEditStaging, createAstEditApplyTool, createAstEditTool } = await import(
  "../main/ast-edit-tool.ts"
);

/*
 * `AstEdit` is a two-step tool: it proposes a structural rewrite, then applies it
 * on request. The properties that make that safe rather than convenient:
 *
 *  - proposing changes nothing on disk;
 *  - applying is bound to the text the proposal was computed from, so a file
 *    edited in between aborts instead of being overwritten;
 *  - a proposal belongs to one session and is consumed by one apply.
 */

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), "ast-edit-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function tools(root, sessionId = "s1") {
  const staging = new AstEditStaging();
  const options = { getRoots: async () => [root], staging };
  return {
    propose: createAstEditTool(options),
    apply: createAstEditApplyTool(options),
    staging,
    sessionId,
  };
}

const signal = new AbortController().signal;
const proposalIdFrom = (content) => content.match(/proposalId `([^`]+)`/)?.[1];

test("a proposal reports the rewrite but leaves every file untouched", async () => {
  const source = "console.log(one);\nconsole.log(two);\n";
  const fx = workspace({ "src/app.ts": source });
  try {
    const t = tools(fx.root);
    const result = await t.propose({
      args: { pattern: "console.log($X)", rewrite: "logger.info($X)", path: "src" },
      sessionId: t.sessionId,
      signal,
    });

    assert.equal(result.ok, true);
    assert.match(result.content, /staged 2 replacement\(s\) in 1 file\(s\)/);
    assert.match(result.content, /app\.ts — 2 replacement\(s\)/);
    // Paths are reported relative to the searched base, exactly like AstSearch.
    // 路径相对搜索基准，与 AstSearch 一致。
    
    assert.match(result.content, /\+ logger\.info\(one\)/);
    assert.ok(proposalIdFrom(result.content), "the content carries the id to apply with");
    assert.equal(readFileSync(join(fx.root, "src/app.ts"), "utf8"), source, "nothing is written yet");
  } finally {
    fx.cleanup();
  }
});

test("applying writes the staged text and consumes the proposal", async () => {
  const fx = workspace({ "src/app.ts": "console.log(one);\n" });
  try {
    const t = tools(fx.root);
    const proposal = await t.propose({
      args: { pattern: "console.log($X)", rewrite: "logger.info($X)", path: "src" },
      sessionId: t.sessionId,
      signal,
    });
    const proposalId = proposalIdFrom(proposal.content);
    assert.ok(proposalId);

    const applied = await t.apply({ args: { proposalId }, sessionId: t.sessionId });
    assert.equal(applied.ok, true);
    assert.match(applied.content, /wrote 1 file/);
    assert.equal(readFileSync(join(fx.root, "src/app.ts"), "utf8"), "logger.info(one);\n");

    const again = await t.apply({ args: { proposalId }, sessionId: t.sessionId });
    assert.equal(again.ok, false, "one proposal applies once");
    assert.match(again.content, /no such proposal/);
  } finally {
    fx.cleanup();
  }
});

test("a file edited between propose and apply aborts the whole apply", async () => {
  const fx = workspace({ "a.ts": "console.log(one);\n", "b.ts": "console.log(two);\n" });
  try {
    const t = tools(fx.root);
    const proposal = await t.propose({
      args: { pattern: "console.log($X)", rewrite: "logger.info($X)" },
      sessionId: t.sessionId,
      signal,
    });
    assert.match(proposal.content, /in 2 file\(s\)/);
    const proposalId = proposalIdFrom(proposal.content);
    assert.ok(proposalId);

    writeFileSync(join(fx.root, "b.ts"), "console.log(two);\nconsole.log(three);\n");

    const applied = await t.apply({ args: { proposalId }, sessionId: t.sessionId });
    assert.equal(applied.ok, false);
    assert.match(applied.content, /changed after the proposal/);
    assert.equal(readFileSync(join(fx.root, "a.ts"), "utf8"), "console.log(one);\n", "no file is written when one is stale");
  } finally {
    fx.cleanup();
  }
});

test("an unknown capture name stays literal so the preview shows the typo", async () => {
  const fx = workspace({ "a.ts": "console.log(one);\n" });
  try {
    const t = tools(fx.root);
    const result = await t.propose({
      args: { pattern: "console.log($X)", rewrite: "logger.info($MISSING, $X)" },
      sessionId: t.sessionId,
      signal,
    });
    assert.match(result.content, /\+ logger\.info\(\$MISSING, one\)/);
  } finally {
    fx.cleanup();
  }
});

test("another session cannot apply a proposal it did not make", async () => {
  const fx = workspace({ "a.ts": "console.log(one);\n" });
  try {
    const owner = tools(fx.root, "session-a");
    const proposal = await owner.propose({
      args: { pattern: "console.log($X)", rewrite: "logger.info($X)" },
      sessionId: "session-a",
      signal,
    });

    // Same staging area, different session: the id must still not match.
    const applied = await owner.apply({ args: { proposalId: proposalIdFrom(proposal.content) }, sessionId: "session-b" });
    assert.equal(applied.ok, false);
    assert.match(applied.content, /no such proposal/);
    assert.equal(readFileSync(join(fx.root, "a.ts"), "utf8"), "console.log(one);\n");
  } finally {
    fx.cleanup();
  }
});

test("a path outside the session roots is refused", async () => {
  const inside = workspace({ "a.ts": "console.log(one);\n" });
  const outside = workspace({ "b.ts": "console.log(two);\n" });
  try {
    const t = tools(inside.root);
    const result = await t.propose({
      args: { pattern: "console.log($X)", rewrite: "logger.info($X)", path: outside.root },
      sessionId: t.sessionId,
      signal,
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /outside this session/);
  } finally {
    inside.cleanup();
    outside.cleanup();
  }
});
