import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [page, api, ipc, protocol, hostRpc, curator, en, zh] = await Promise.all([
  read("../src/components/settings/AgentSkillsPage.tsx"),
  read("../src/lib/api.ts"),
  read("../electron/main/ipc/skills-ipc.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../crates/host-core/src/rpc/mod.rs"),
  read("../../../crates/host-core/src/user_skills/curator.rs"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("curation travels the existing renderer → IPC → host path, one hop each", () => {
  assert.match(protocol, /skillCurate: "pi-desktop\/skill\/curate"/);
  assert.match(protocol, /skillArchive: "pi-desktop\/skill\/archive"/);
  assert.match(protocol, /skillArchived: "pi-desktop\/skill\/archived"/);
  assert.match(protocol, /skillRestore: "pi-desktop\/skill\/restore"/);

  assert.match(api, /curateUserSkills: \(policy\?: Partial<SkillCuratorPolicy>\) =>/);
  assert.match(api, /invoke<\{ candidates: SkillCuratorCandidate\[\]; policy: SkillCuratorPolicy \}>/);
  assert.match(api, /archiveUserSkill: \(id: string, reason\?: string\) =>/);
  assert.match(api, /listArchivedUserSkills: \(\) =>/);
  assert.match(api, /restoreUserSkill: \(entryId: string\) =>/);

  assert.match(ipc, /host\.call\("skills\.curate", payload \?\? \{\}\)/);
  assert.match(ipc, /host\.call\("skills\.archive", payload\)/);
  assert.match(ipc, /host\.call\("skills\.archived", \{\}\)/);
  assert.match(ipc, /host\.call\("skills\.restore", payload\)/);
  // Archiving and restoring both change the catalog, so both announce it.
  const archiveAt = ipc.indexOf('"skills.archive"');
  const restoreAt = ipc.indexOf('"skills.restore"');
  assert.ok(archiveAt > 0 && restoreAt > 0);
  assert.match(
    ipc.slice(archiveAt, restoreAt),
    /sendToRenderer\(IPC\.event\.pluginChanged/,
    "an archived skill must refresh the catalog",
  );
  assert.match(
    ipc.slice(restoreAt, restoreAt + 400),
    /sendToRenderer\(IPC\.event\.pluginChanged/,
    "a restored skill must refresh the catalog",
  );
});

test("the host decides, the renderer never guesses", () => {
  // One plan function, no clock of its own: a proposal is a pure function of
  // the catalog, the activity ledger and the policy.
  assert.match(curator, /pub fn plan\(/);
  assert.doesNotMatch(
    curator.slice(curator.indexOf("pub fn plan("), curator.indexOf("#[cfg(test)]")),
    /Utc::now|std::fs|read_to_string/,
    "the planner takes `now` and its inputs; it does not read either itself",
  );
  // Archiving is proposed for a duplicate or an idle skill, and nothing else;
  // thin and pinned rows are reported without being archived.
  assert.match(curator, /CuratorFinding::Duplicate \{ \.\. \} \| CuratorFinding::Stale \{ \.\. \}/);
  assert.match(curator, /pub const DEFAULT_STALE_AFTER_DAYS: u64 = 90;/);

  // The RPC surface validates what it is handed and defaults the policy.
  assert.match(hostRpc, /"skills\.curate" =>/);
  assert.match(hostRpc, /CuratorPolicy::default\(\)/);
  assert.match(hostRpc, /"skills\.archive" =>/);
  assert.match(hostRpc, /unwrap_or\("manual"\)/);
  assert.match(hostRpc, /"skills\.archived" =>/);
  assert.match(hostRpc, /"skills\.restore" =>/);
  assert.match(hostRpc, /entryId is required/);
});

test("the settings page offers a proposal, an archive and a way back", () => {
  // The panel is opened on demand and refreshed on open: usage and age move.
  assert.match(page, /const \[curatorOpen, setCuratorOpen\] = useState\(false\)/);
  assert.match(page, /if \(next\) void loadCuration\(\)/);
  assert.match(page, /await Promise\.all\(\[\s*api\.curateUserSkills\(\),\s*api\.listArchivedUserSkills\(\),?\s*\]\)/s);

  // Only rows the host marked `archive` get a button; the reason travels with it.
  assert.match(page, /candidate\.suggestion === "archive"/);
  assert.match(page, /await api\.archiveUserSkill\(candidate\.id, archiveReason\(candidate\)\)/);
  assert.match(page, /await api\.restoreUserSkill\(entry\.entryId\)/);
  // A restored entry stays listed, so the history is auditable.
  assert.match(page, /entry\.restoredAt\s*\?/);

  // Every reason has copy, and the copy is localized rather than English-only.
  for (const key of [
    "skillCuratorOpen",
    "skillCuratorTitle",
    "skillCuratorHint",
    "skillCuratorScanning",
    "skillCuratorEmpty",
    "skillCuratorArchive",
    "skillCuratorArchived",
    "skillCuratorRestore",
    "skillCuratorReasonDuplicate",
    "skillCuratorReasonStale",
    "skillCuratorReasonThin",
    "skillCuratorReasonPinned",
    "skillCuratorArchiveDone",
    "skillCuratorRestoreDone",
  ]) {
    assert.match(en, new RegExp(`\\b${key}:`), `en missing ${key}`);
    assert.match(zh, new RegExp(`\\b${key}:`), `zh-CN missing ${key}`);
  }
  assert.match(zh, /skillCuratorOpen: "整理技能"/);
});
