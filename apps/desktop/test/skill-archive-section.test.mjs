import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readMainModuleSync, readSharedTypesSourceSync } from "./helpers/source-contracts.mjs";
import { archivedSkillRows } from "../src/lib/skill-archive.ts";

/*
 * Archiving moves a document into `<skills root>/.archive/`, which takes it out
 * of every scan — so the settings page could not offer a way back until the
 * archive had a read of its own. Two halves are worth pinning without an
 * Electron window: the rows the section draws (and the keys they carry), and
 * the wiring that makes a click reach `skills.restore` and reload both lists.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(here, path), "utf8");
const page = read("../src/components/settings/AgentSkillsPage.tsx");
const api = read("../src/lib/api.ts");
const ipc = readMainModuleSync("ipc/skills-ipc.ts");
const protocol = read("../../../packages/shared/src/protocol.ts");
const capabilities = readSharedTypesSourceSync();

const archived = (id) => ({ id, name: id, enabled: false, source: "imported", path: `/x/.archive/${id}.md` });

test("the section draws one row per document and keys it apart from the live list", () => {
  const rows = archivedSkillRows([archived("idle-one")], [archived("idle-one"), archived("idle-two")]);

  assert.deepEqual(
    rows.map((row) => [row.level, row.skill.id]),
    [
      ["global", "idle-one"],
      ["project", "idle-one"],
      ["project", "idle-two"],
    ],
    "global rows come first and every row keeps the library it came from",
  );
  assert.deepEqual(
    rows.map((row) => row.key),
    ["archive:global:idle-one", "archive:project:idle-one", "archive:project:idle-two"],
  );
  // A skill can be live again under an id an older copy still holds in the
  // archive; sharing the live row's `level:id` key would freeze the wrong row.
  assert.ok(rows.every((row) => row.key !== `${row.level}:${row.skill.id}`));
});

test("an unread archive is an empty section, not a failed page", () => {
  assert.deepEqual(archivedSkillRows(undefined, undefined), []);
  assert.deepEqual(archivedSkillRows([archived("only-global")], undefined).map((row) => row.skill.id), [
    "only-global",
  ]);
});

test("the page renders the archive and restores one row into both lists", () => {
  assert.match(page, /<SettingsCard\s+title=\{t\("settings\.skillArchivedTitle"\)\}/);
  assert.match(page, /archivedRows\.length === 0 \? \(\s*<CapabilityEmpty/);
  assert.match(page, /message=\{t\("settings\.skillArchivedEmpty"\)\}/);
  assert.match(page, /\{archivedRows\.map\(renderArchivedRow\)\}/);
  assert.match(page, /t\("settings\.skillArchivedRestore"\)/);
  assert.match(page, /api\.listArchivedUserSkills\(\{ level: "global" \}\)/);

  const restore = page.slice(page.indexOf("const restoreArchived"));
  assert.match(restore, /api\.restoreUserSkill\(row\.skill\.id, capabilityQuery\(row\.level, selectedProjectPath\)\)/);
  // The restore moves a document back into the catalog, so the archive and the
  // catalog are both stale after it — and a restored skill is no longer idle,
  // which is what the maintenance report says.
  assert.match(restore, /await load\(\)/);
  assert.match(restore, /await refreshCuration\(\)/);
  assert.match(restore, /showToast\(t\("settings\.skillArchivedRestored", \{ name \}\)/);
});

test("main forwards both host calls and the renderer reloads on the skill event", () => {
  assert.match(ipc, /handle\(IPC\.invoke\.skillArchived/);
  assert.match(ipc, /host\.call\("skills\.archived", payload\)/);
  assert.match(ipc, /handle\(\s*IPC\.invoke\.skillRestore/);
  assert.match(ipc, /host\.call<\{ skill: UserSkillRecord \}>\("skills\.restore"/);
  assert.match(ipc, /invalid skill restore request/);
  // The event is what tells the page the two lists it draws have changed.
  const restore = ipc.slice(ipc.indexOf("IPC.invoke.skillRestore"));
  assert.match(restore.slice(0, 900), /sendToRenderer\(IPC\.event\.pluginChanged, \{ reason: "skill" \}\)/);
});

test("the channels and the archive query are part of the shared contract", () => {
  assert.match(protocol, /skillArchived: "pi-desktop\/skill\/archived"/);
  assert.match(protocol, /skillRestore: "pi-desktop\/skill\/restore"/);
  assert.match(capabilities, /export type SkillArchiveQuery = \{\s*level\?: AgentCapabilityLevel;\s*projectPath\?: string;\s*\}/);
  assert.match(api, /listArchivedUserSkills: \(query\?: SkillArchiveQuery\)/);
  assert.match(api, /invoke<\{ skills: UserSkillRecord\[\] \}>\(IPC\.invoke\.skillArchived, query \?\? \{\}\)/);
  assert.match(api, /restoreUserSkill: \(id: string, query\?: AgentCapabilityQuery\)/);
});
