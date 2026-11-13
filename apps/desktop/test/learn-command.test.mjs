/**
 * `/learn`: one submission, one skill.
 *
 * The composer owns the command — it rewords `/learn <material>` into a prompt
 * the agent can already carry out — so what needs locking down is the prompt
 * (source, standards, no invention) and the places the command touches: the
 * slash decision, the menu row, the accepted completion, and the nine catalogs.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SKILL_AUTHORING_GUIDE, SKILL_WRITING_RULES } from "@pi-workspace/shared";
import { catalogs } from "@pi-workspace/i18n";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const load = (relative) => import(pathToFileURL(join(here, relative)).href);

const {
  LEARN_COMMAND_NAME,
  buildLearnPrompt,
  learnPromptFor,
  learnCompletionRow,
  insertLearnRow,
  applyLearnCompletion,
} = await load("../src/features/chat/composer/learn-command.ts");
const { parseSlashSubmission, resolveSlashDispatch } = await load(
  "../src/features/chat/composer/slash-dispatch.ts",
);
const { resolveComposerCommand } = await load(
  "../src/hooks/use-composer-autocomplete.ts",
);
const { api } = await load("../src/lib/api.ts");
const { useAppStore } = await load("../src/stores/app-store.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/** A command the merged source does not own: the only shape `/learn` arrives as. */
const unknown = () => ({ status: "unknown" });

const t = (key) =>
  ({
    "chat.learnCommandTitle": "TITLE",
    "chat.learnCommandDesc": "DESC",
    "chat.learnCommandHint": "HINT",
  })[key] ?? key;

/** A host menu row, shaped like the ones `useComposerAutocomplete` returns. */
const row = (name, kind) => ({
  kind: "command",
  command: { name, kind, title: name },
  match: { score: 0, ranges: [] },
});

test("`/learn` with no target means this conversation", () => {
  const prompt = buildLearnPrompt("");
  assert.match(prompt, /No source was named, so the material is the conversation so far/);
  assert.ok(prompt.includes("this conversation"), "the conversation must be named as the source");
  assert.equal(buildLearnPrompt("   "), prompt, "whitespace is the same as no target");
  assert.equal(buildLearnPrompt("\n\t "), prompt);
});

test("a target rides into the prompt as given", () => {
  const prompt = buildLearnPrompt("  docs/spec/06-delivery  ");
  assert.ok(prompt.includes("docs/spec/06-delivery"), "the target is quoted in the prompt");
  assert.ok(prompt.includes("THE MATERIAL:\ndocs/spec/06-delivery\n"), "trimmed, on its own line");
  assert.doesNotMatch(prompt, /No source was named/, "a named source is not the conversation");
  assert.match(prompt, /Honor all of it, and read every source named/);
});

test("the authoring bar is the shared guide, not a second copy", () => {
  const prompt = buildLearnPrompt("anything");
  assert.ok(prompt.includes(SKILL_AUTHORING_GUIDE), "SKILL_AUTHORING_GUIDE is quoted verbatim");
  assert.ok(prompt.includes(SKILL_WRITING_RULES), "SKILL_WRITING_RULES is quoted verbatim");
  assert.match(SKILL_AUTHORING_GUIDE, /<=60 characters/, "the guide still carries the 60-character rule");
});

test("the prompt forbids invention and demands verbatim copying", () => {
  const prompt = buildLearnPrompt("some/api.md");
  assert.match(prompt, /MUST be copied VERBATIM from the material/);
  assert.match(prompt, /If you did not see it there, do not write it/);
  assert.match(prompt, /Never invent a flag, a command, an endpoint, a config key or an option/);
});

test("the prompt skips what is not reusable and names the result", () => {
  const prompt = buildLearnPrompt("");
  assert.match(prompt, /Leave out anything that is not reusable/);
  assert.match(prompt, /ticket numbers/, "one-off values are called out");
  assert.match(prompt, /When you are done, name the skill you wrote/);
  assert.match(prompt, /`skill_manage` action `create`/);
  assert.match(prompt, /`skill_manage` action `patch`/, "an existing class is patched, not duplicated");
});

test("a slash submission becomes the learn prompt only when nothing owns the name", () => {
  const bare = resolveSlashDispatch(parseSlashSubmission("/learn"), unknown());
  assert.equal(bare.action, "learn");
  assert.equal(bare.prompt, buildLearnPrompt(""));

  const targeted = resolveSlashDispatch(parseSlashSubmission("/learn docs/"), unknown());
  assert.equal(targeted.action, "learn");
  assert.equal(targeted.prompt, buildLearnPrompt("docs/"));

  assert.equal(LEARN_COMMAND_NAME, "learn");
});

test("a user's own command named `learn` keeps its behaviour", () => {
  const template = resolveSlashDispatch(parseSlashSubmission("/learn the api"), {
    status: "resolved",
    command: { name: "learn", kind: "template", title: "Learn" },
  });
  assert.equal(template.action, "prompt", "a prompt template still travels as text");

  const builtin = resolveSlashDispatch(parseSlashSubmission("/learn now"), {
    status: "resolved",
    command: { name: "learn", kind: "builtin", title: "Learn", id: "builtin.learn" },
  });
  assert.equal(builtin.action, "dispatch", "a real command still dispatches");

  const unavailable = resolveSlashDispatch(parseSlashSubmission("/learn"), {
    status: "unavailable",
    error: new Error("composer/commands unavailable"),
  });
  assert.equal(unavailable.action, "blocked", "an unreadable source still fails closed");
});

test("a lookalike name is not `/learn`", () => {
  assert.equal(learnPromptFor("learned", "x"), null);
  assert.equal(resolveSlashDispatch(parseSlashSubmission("/learned x"), unknown()).action, "prompt");
  assert.equal(resolveSlashDispatch(parseSlashSubmission("/learn-tools x"), unknown()).action, "prompt");
});

test("the real resolver hands `/learn` to the composer, not to the model", async () => {
  // The host list has no `learn`, so this is the status the send path sees.
  useAppStore.setState({ workspace: { path: "/pi-learn-command" } });
  const original = api.composerCommands;
  api.composerCommands = async () => ({
    commands: [
      { name: "compact", kind: "builtin", title: "Compact", id: "builtin.agent.compact" },
    ],
  });
  try {
    const resolution = await resolveComposerCommand(LEARN_COMMAND_NAME);
    assert.equal(resolution.status, "unknown", "the host does not own the name");

    const dispatch = resolveSlashDispatch(
      parseSlashSubmission("/learn docs/"),
      resolution,
    );
    assert.equal(dispatch.action, "learn");
    assert.equal(dispatch.prompt, buildLearnPrompt("docs/"));
  } finally {
    api.composerCommands = original;
  }
});

test("the menu row answers to the slash name and carries localized copy", () => {
  const match = learnCompletionRow("lea", t);
  assert.equal(match.kind, "command");
  assert.equal(match.command.name, "learn");
  assert.equal(match.command.kind, "builtin");
  assert.equal(match.command.title, "TITLE");
  assert.equal(match.command.description, "DESC");
  assert.equal(match.command.argumentHint, "HINT");
  assert.ok(match.match.ranges.length > 0, "the typed letters are highlighted");

  const bare = learnCompletionRow("", t);
  assert.equal(bare.command.name, "learn", "a bare `/` lists it");

  assert.equal(learnCompletionRow("zzz", t), null);
});

test("the row lands inside the builtin group", () => {
  const learn = learnCompletionRow("", t);
  const names = (result) => result.items.map((item) => item.command.name);

  assert.deepEqual(names(insertLearnRow([], learn)), ["learn"]);
  assert.equal(insertLearnRow([], learn).index, 0);

  const template = row("plan", "template");
  const compact = row("compact", "builtin");
  const skill = row("skill:review", "skill");

  assert.deepEqual(names(insertLearnRow([template], learn)), ["plan", "learn"]);
  assert.deepEqual(names(insertLearnRow([template, compact, skill], learn)), [
    "plan",
    "compact",
    "learn",
    "skill:review",
  ]);
  assert.equal(insertLearnRow([template, compact, skill], learn).index, 2);
  assert.deepEqual(names(insertLearnRow([skill], learn)), ["learn", "skill:review"]);
  assert.equal(insertLearnRow([skill], learn).index, 0);
});

test("accepting the row leaves the caret where the target goes", () => {
  assert.deepEqual(applyLearnCompletion("/lea", 4), { value: "/learn ", cursor: 7 });
  assert.deepEqual(applyLearnCompletion("/", 1), { value: "/learn ", cursor: 7 });
  assert.deepEqual(applyLearnCompletion("hi /le", 6), { value: "hi /learn ", cursor: 10 });
  assert.equal(applyLearnCompletion("hello", 5), null, "no slash token, nothing to complete");
});

test("every shipped locale translates the command", () => {
  const ids = Object.keys(catalogs).sort();
  assert.equal(ids.length, 9, ids.join(","));
  const english = catalogs.en.chat;
  for (const id of ids) {
    for (const key of ["learnCommandTitle", "learnCommandDesc", "learnCommandHint"]) {
      const value = catalogs[id].chat[key];
      assert.equal(typeof value, "string", `${id} ${key}`);
      assert.ok(value.trim(), `${id} ${key} must not be blank`);
      if (id !== "en") {
        assert.notEqual(value, english[key], `${id} ${key} must not fall back to English`);
      }
    }
  }
});

test("the command carries no hardcoded English in the UI", async () => {
  const source = await read("../src/features/chat/composer/learn-command.ts");
  assert.doesNotMatch(source, /title: "/, "the menu title comes from the catalog");
  assert.doesNotMatch(source, /description: "/, "the menu description comes from the catalog");
  assert.match(source, /t\("chat\.learnCommandTitle"\)/);
});

test("the composer and the submit path are wired to it", async () => {
  const [submit, completions] = await Promise.all([
    read("../src/features/chat/composer/hooks/useComposerSubmit.ts"),
    read("../src/features/chat/composer/hooks/useComposerCompletions.ts"),
  ]);
  assert.match(
    submit,
    /if \(dispatch\.action === "learn"\) promptText = dispatch\.prompt;/,
    "the learn prompt replaces the typed line",
  );
  assert.match(
    submit,
    /sendPrompt\(\s*promptText,/,
    "the send path carries that prompt, not the raw text",
  );
  assert.match(submit, /steerPrompt\(promptText, submittedDraft\)/);
  assert.match(completions, /learnCompletionRow\(learnQuery, \(key\) => t\(key\)\)/);
  assert.match(completions, /insertLearnRow\(hostItems, learnRow\)/);
  assert.match(
    completions,
    /const hostIndex = learnIndex >= 0 && index > learnIndex \? index - 1 : index;/,
    "the inserted row must not shift the host accept path",
  );
});
