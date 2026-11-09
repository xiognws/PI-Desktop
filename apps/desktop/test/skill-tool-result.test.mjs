import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatSkillToolContent, listSkillReferences } from "../electron/main/skill-document.ts";

test("Skill tool content identifies the document and its reference directory", () => {
  const content = formatSkillToolContent({
    id: "redmine",
    name: "Redmine",
    location: "/Users/example/.agents/skills/redmine/SKILL.md",
    body: "Read `SECRET.md` from this skill directory.",
  });

  assert.match(content, /Location: \/Users\/example\/\.agents\/skills\/redmine\/SKILL\.md/);
  assert.match(content, /References are relative to \/Users\/example\/\.agents\/skills\/redmine\./);
  assert.ok(content.endsWith("Read `SECRET.md` from this skill directory."));
});

test("a skill with no references directory lists nothing and still returns its body", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-refs-none-"));
  const location = join(dir, "SKILL.md");
  writeFileSync(location, "# Skill\n");

  assert.deepEqual(listSkillReferences(location), []);
  const content = formatSkillToolContent({ id: "a", name: "A", location, body: "Body." });
  assert.equal(content.includes("Reference files in this skill"), false);
});

test("the loaded document names every references/ file, so no filename has to be guessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-refs-some-"));
  const location = join(dir, "SKILL.md");
  writeFileSync(location, "# Skill\n");
  mkdirSync(join(dir, "references"));
  writeFileSync(join(dir, "references", "verticals.md"), "## z\n");
  writeFileSync(join(dir, "references", "api-quirks.md"), "## a\n");
  // Not a reference: the host only ever writes markdown into this directory.
  writeFileSync(join(dir, "references", "notes.txt"), "ignore me\n");

  assert.deepEqual(listSkillReferences(location), [
    "references/api-quirks.md",
    "references/verticals.md",
  ]);
  const content = formatSkillToolContent(
    { id: "a", name: "A", location, body: "Body." },
    listSkillReferences(location),
  );
  assert.match(content, /- references\/api-quirks\.md/);
  assert.match(content, /- references\/verticals\.md/);
  assert.equal(content.includes("notes.txt"), false);
  // The document itself stays last: the model reads it as the instruction body.
  assert.ok(content.endsWith("\nBody."));
});

test("an unreadable location is treated as no references rather than failing the load", () => {
  assert.deepEqual(listSkillReferences(join(tmpdir(), "does-not-exist", "SKILL.md")), []);
});
