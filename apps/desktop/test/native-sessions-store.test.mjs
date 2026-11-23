import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/*
 * The four `native.session.*` surfaces are answered in main from the legacy pi
 * JSONL store (`electron/main/native-sessions.ts`) instead of being reported as
 * an unsupported kernel surface. These cases pin the contract the Node sidecar
 * used to provide: which files are sessions, what one row says, what an
 * unopenable file reports, and what a fork produces.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { NativeSessionStore } = await import("../electron/main/native-sessions.ts");

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A store plus the directories it reads; every test builds its own. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-native-main-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const sessionRoot = join(agentDir, "sessions");
  const project = join(root, "project");
  const group = join(sessionRoot, "--project--");
  mkdirSync(group, { recursive: true });
  mkdirSync(project);
  return {
    root,
    agentDir,
    sessionRoot,
    project,
    group,
    store: new NativeSessionStore({ agentDir, sessionRoot }),
  };
}

function jsonl(entries, { newline = true } = {}) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}${newline ? "\n" : ""}`;
}

const userMessage = (id, parentId, text, timestamp = "2026-09-14T00:00:01.000Z") => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
});

const assistantMessage = (id, parentId, text, timestamp = "2026-09-14T00:00:06.000Z") => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: 2,
  },
});

/**
 * The reference fixture (`native-pi-session.test.ts`): a tree with a side branch
 * and a future entry type, so branch selection and unknown-entry tolerance are
 * exercised by the same bytes.
 */
function treeSession(project, id = "native-id") {
  return jsonl([
    { type: "session", version: 3, id, timestamp: "2026-09-14T00:00:00.000Z", cwd: project },
    userMessage("u1", null, "hello"),
    { type: "model_change", id: "m1", parentId: "u1", timestamp: "2026-09-14T00:00:02.000Z", provider: "test-provider", modelId: "test-model" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-09-14T00:00:03.000Z", thinkingLevel: "high" },
    { type: "custom_message", id: "cm1", parentId: "t1", timestamp: "2026-09-14T00:00:05.000Z", customType: "fixture", content: "context", display: false },
    assistantMessage("a1", "cm1", "answer"),
    { type: "compaction", id: "cp1", parentId: "a1", timestamp: "2026-09-14T00:00:07.000Z", summary: "summary", firstKeptEntryId: "a1", tokensBefore: 10 },
    assistantMessage("branch", "u1", "active branch", "2026-09-14T00:00:08.000Z"),
    { type: "future_entry", id: "future", parentId: "branch", timestamp: "2026-09-14T00:00:09.000Z", opaque: { untouched: true } },
  ]);
}

test("list returns a row per stored session with the sidecar's projection", async () => {
  const f = fixture();
  const file = join(f.group, "fixture.jsonl");
  writeFileSync(file, treeSession(f.project));

  const sessions = await f.store.list();
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.match(session.id, /^native-pi:[A-Za-z0-9_-]{24}$/);
  assert.equal(session.source, "pi-native");
  assert.equal(session.title, "hello");
  // The leaf is the future entry, so the active branch is u1 → branch: the
  // side branch's answer and its compaction are not on it.
  assert.equal(session.messageCount, 2);
  assert.equal(session.projectPath, f.project);
  assert.equal(session.providerId, "test-provider");
  assert.equal(session.modelId, "test-model");
  assert.equal(session.thinkingLevel, "off");
  assert.equal(session.mode, "agent");
  assert.equal(session.permissionMode, "inherit");
  assert.equal(session.readOnlyReason, undefined);
  assert.deepEqual(session.capabilities, { canPrompt: true, canStop: false, canRefresh: true });
  assert.equal(session.createdAt, "2026-09-14T00:00:00.000Z");
  assert.equal(session.updatedAt, "2026-09-14T00:00:09.000Z");

  // The id is content-addressed and stable across scans; a second list must not
  // re-key the session the renderer already has open.
  const again = await f.store.list();
  assert.equal(again[0].id, session.id);
});

test("get opens one session and pages its messages", async () => {
  const f = fixture();
  writeFileSync(join(f.group, "fixture.jsonl"), treeSession(f.project));
  const [session] = await f.store.list();

  const detail = await f.store.get(session.id);
  assert.equal(detail.id, session.id);
  assert.deepEqual(detail.messages.map((message) => message.content), ["hello", "active branch"]);
  assert.equal(detail.messages[0].role, "user");
  assert.equal(detail.messages[1].role, "assistant");
  assert.equal(detail.messageStart, 0);
  assert.equal(detail.hasMoreBefore, false);

  const tail = await f.store.get(session.id, { messageLimit: 1 });
  assert.deepEqual(tail.messages.map((message) => message.content), ["active branch"]);
  assert.equal(tail.hasMoreBefore, true);

  const around = await f.store.get(session.id, { messageAround: "branch", messageLimit: 1 });
  assert.deepEqual(around.messages.map((message) => message.content), ["active branch"]);
});

test("an unknown or foreign id fails the way the sidecar failed", async () => {
  const f = fixture();
  writeFileSync(join(f.group, "fixture.jsonl"), treeSession(f.project));
  await f.store.list();

  await assert.rejects(f.store.get("native-pi:does-not-exist"), (error) => {
    assert.equal(error.errorCode, "NOT_FOUND");
    assert.match(error.message, /Native Pi session not found; refresh sessions and try again/);
    return true;
  });
  await assert.rejects(f.store.get("session-from-host-core"), /not a native Pi session/);
  await assert.rejects(f.store.fork({ id: "native-pi:does-not-exist" }), (error) => {
    assert.equal(error.errorCode, "NOT_FOUND");
    return true;
  });
});

test("a damaged file is listed read-only and still opens", async () => {
  const f = fixture();
  const broken = join(f.group, "broken.jsonl");
  writeFileSync(
    broken,
    [
      JSON.stringify({ type: "session", version: 3, id: "broken-id", timestamp: "2026-09-14T00:00:00.000Z", cwd: f.project }),
      '{"type":"message","id":"u1",', // truncated line: not valid JSONL
      JSON.stringify(userMessage("u1b", null, "still readable")),
    ].join("\n") + "\n",
  );
  // An old header version is readable data but never written back.
  writeFileSync(
    join(f.group, "legacy.jsonl"),
    jsonl([
      { type: "session", version: 2, id: "legacy-id", timestamp: "2026-09-14T00:00:00.000Z", cwd: f.project },
      userMessage("u2", null, "old format"),
    ]),
  );
  // A cwd that no longer exists is not a session you can continue.
  writeFileSync(
    join(f.group, "moved.jsonl"),
    jsonl([
      { type: "session", version: 3, id: "moved-id", timestamp: "2026-09-14T00:00:00.000Z", cwd: join(f.root, "gone") },
      userMessage("u3", null, "moved project"),
    ]),
  );

  const sessions = await f.store.list();
  const reasons = new Map(sessions.map((session) => [session.title, session.readOnlyReason]));
  assert.deepEqual(reasons, new Map([
    ["still readable", "invalid-session"],
    ["old format", "legacy-format"],
    ["moved project", "missing-cwd"],
  ]));
  for (const session of sessions) {
    assert.equal(session.capabilities.canPrompt, false, `${session.title} cannot be continued`);
  }
  await assert.rejects(
    f.store.fork({ id: sessions.find((session) => session.title === "old format").id }),
    { errorCode: "NATIVE_PI_LEGACY_FORMAT" },
  );
  // Opening it still yields what the readable lines hold, with the same reason.
  const brokenSession = sessions.find((session) => session.title === "still readable");
  const detail = await f.store.get(brokenSession.id);
  assert.equal(detail.readOnlyReason, "invalid-session");
  assert.deepEqual(detail.messages.map((message) => message.content), ["still readable"]);
});

test("search finds a session by message text and by path", async () => {
  const f = fixture();
  writeFileSync(join(f.group, "fixture.jsonl"), treeSession(f.project));
  await f.store.list();

  const hit = await f.store.search("active branch");
  assert.equal(hit.hits.length, 1);
  assert.equal(hit.hits[0].messageCount, 1);
  assert.equal(hit.hits[0].matches[0].snippet, "active branch");
  assert.equal(hit.hits[0].metadataMatch, false);
  assert.equal(hit.nextOffset, null);

  const byPath = await f.store.search("project");
  assert.equal(byPath.hits.length, 1);
  assert.equal(byPath.hits[0].metadataMatch, true);

  assert.deepEqual(await f.store.search("   "), { hits: [], nextOffset: null });
  await assert.rejects(f.store.search("x".repeat(501)), /query exceeds 500 characters/);
});

test("fork publishes a new child file with a new id and equivalent content", async () => {
  const f = fixture();
  const parentFile = join(f.group, "fixture.jsonl");
  const parentText = treeSession(f.project);
  writeFileSync(parentFile, parentText);
  const [parent] = await f.store.list();

  const child = await f.store.fork({ id: parent.id, title: "forked title" });

  assert.notEqual(child.id, parent.id);
  assert.match(child.id, /^native-pi:/);
  assert.equal(child.title, "forked title");
  assert.equal(child.source, "pi-native");
  // The child carries the same transcript the parent branch shows.
  assert.deepEqual(
    child.messages.map((message) => message.content),
    (await f.store.get(parent.id)).messages.map((message) => message.content),
  );
  assert.equal(child.messageCount, parent.messageCount);

  // Exactly one new file, beside its parent, with its own header id and the
  // parent recorded as `parentSession`; the parent bytes are untouched.
  const published = readdirSync(f.group).filter((name) => name.endsWith(".jsonl") && name !== "fixture.jsonl");
  assert.equal(published.length, 1);
  assert.equal(readFileSync(parentFile, "utf8"), parentText);
  const entries = readFileSync(join(f.group, published[0]), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries[0].type, "session");
  assert.equal(entries[0].version, 3);
  assert.notEqual(entries[0].id, "native-id");
  assert.equal(entries[0].parentSession, parentFile);
  assert.equal(entries[0].cwd, f.project);
  assert.equal(entries.at(-1).type, "session_info");
  assert.equal(entries.at(-1).name, "forked title");

  // The fork is a first-class session: the next list sees two, and the child's
  // own branch still holds the parent's messages.
  const sessions = await f.store.list();
  assert.equal(sessions.length, 2);
  const listed = sessions.find((session) => session.id === child.id);
  assert.equal(listed.title, "forked title");
  const reopened = await f.store.get(child.id);
  assert.equal(reopened.messages.length, child.messages.length);
});

test("fork from a message keeps only the path to that message", async () => {
  const f = fixture();
  writeFileSync(join(f.group, "fixture.jsonl"), treeSession(f.project));
  const [parent] = await f.store.list();

  // `u1` is the first user message; forking there keeps it and nothing after.
  const child = await f.store.fork({ id: parent.id, throughMessageId: "u1" });
  assert.deepEqual(child.messages.map((message) => message.content), ["hello"]);
  assert.equal(child.id.startsWith("native-pi:"), true);

  // A message on a different branch is not an anchor.
  await assert.rejects(f.store.fork({ id: parent.id, throughMessageId: "a1" }), {
    errorCode: "INVALID_ARGUMENT",
  });
});

test("a project sessionDir is discovered without inventing a directory", async () => {
  const f = fixture();
  const customDir = join(f.project, ".pi", "sessions");
  mkdirSync(customDir, { recursive: true });
  writeFileSync(join(f.project, ".pi", "settings.json"), `${JSON.stringify({ sessionDir: ".pi/sessions" })}\n`);
  writeFileSync(
    join(customDir, "local.jsonl"),
    jsonl([
      { type: "session", version: 3, id: "local-id", timestamp: "2026-09-14T00:00:00.000Z", cwd: f.project },
      userMessage("u4", null, "project local session"),
    ]),
  );
  writeFileSync(join(f.group, "fixture.jsonl"), treeSession(f.project));

  const withoutProject = await f.store.list();
  assert.deepEqual(withoutProject.map((session) => session.title), ["hello"]);

  const sessions = await f.store.list({ projectPaths: [f.project] });
  assert.deepEqual(sessions.map((session) => session.title).sort(), ["hello", "project local session"]);
  const local = sessions.find((session) => session.title === "project local session");
  assert.equal(local.projectPath, f.project);
  const detail = await f.store.get(local.id);
  assert.deepEqual(detail.messages.map((message) => message.content), ["project local session"]);
});

test("the sidecar-shaped client answers the four method names", async () => {
  const f = fixture();
  writeFileSync(join(f.group, "fixture.jsonl"), treeSession(f.project));
  const { nativeSessionClient } = await import("../electron/main/native-sessions.ts");
  const client = nativeSessionClient(f.store);

  const listed = await client.call("native.session.list", { projectPaths: [f.project] });
  assert.equal(listed.sessions.length, 1);
  const id = listed.sessions[0].id;
  const got = await client.call("native.session.get", { id, messageLimit: 1 });
  assert.equal(got.session.id, id);
  const searched = await client.call("native.session.search", { query: "hello" });
  assert.equal(searched.hits.length, 1);
  const forked = await client.call("native.session.fork", { id, title: "client fork" });
  assert.equal(forked.session.title, "client fork");
  await assert.rejects(client.call("native.session.status", { id }), { errorCode: "UNSUPPORTED" });
});
