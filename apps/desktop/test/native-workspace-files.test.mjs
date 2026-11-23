import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/*
 * A `native-pi:` session owns no host-core row: its project is the `cwd` its own
 * JSONL file records, and that store is now read in Electron main
 * (`electron/main/native-sessions.ts`) instead of through the sidecar. These
 * cases pin that a native file view still never falls back to the selected
 * Desktop workspace, and that a session it cannot open fails closed.
 */

// The store resolves its root from PI_HOME, the root the app publishes at boot,
// so a fixture tree here is what `nativeSessionStore()` reads.
const home = mkdtempSync(join(tmpdir(), "pi-desktop-native-files-"));
process.env.PI_HOME = home;
const project = join(home, "project");
mkdirSync(project);
test.after(() => rmSync(home, { recursive: true, force: true }));

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { remoteWorkspaceForFiles } = await import("../electron/main/remote/workspace-file-scope.ts");
const { nativeSessionStore } = await import("../electron/main/native-sessions.ts");

const store = nativeSessionStore();
const sessionsRoot = join(home, "pi", "agent", "sessions", "--project--");
mkdirSync(sessionsRoot, { recursive: true });

function writeSession(fileName, id, text) {
  writeFileSync(
    join(sessionsRoot, fileName),
    `${[
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-14T00:00:00.000Z", cwd: project }),
      JSON.stringify({
        type: "message",
        id: `${id}-user`,
        parentId: null,
        timestamp: "2026-09-14T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
      }),
    ].join("\n")}\n`,
  );
}

writeSession("fixture.jsonl", "native-id", "hello");
writeSession("removed.jsonl", "removed-id", "removed later");
const listed = await store.list();
const nativeSession = listed.find((session) => session.title === "hello");
const removedSession = listed.find((session) => session.title === "removed later");
assert.match(nativeSession.id, /^native-pi:/);
assert.match(removedSession.id, /^native-pi:/);

test("native file views read the legacy store, not the selected Desktop workspace", async () => {
  const host = { call: () => assert.fail("native identity reached Desktop storage") };
  const sidecar = { call: () => assert.fail("a native file view must not need the sidecar") };
  // A local project is not a remote workspace binding, so the answer is null —
  // reached without a single `host.call`.
  assert.equal(await remoteWorkspaceForFiles(() => host, nativeSession.id, () => sidecar), null);
});

test("a missing native session fails closed without a Desktop workspace fallback", async () => {
  const host = { call: () => assert.fail("native identity reached Desktop storage") };
  await assert.rejects(
    remoteWorkspaceForFiles(() => host, "native-pi:missing", () => null),
    { errorCode: "NOT_FOUND" },
  );
  const sidecar = { call: async () => ({ session: null }) };
  await assert.rejects(
    remoteWorkspaceForFiles(() => host, "native-pi:missing", () => sidecar),
    { errorCode: "NOT_FOUND" },
  );
});

test("a session file that disappeared after listing fails closed", async () => {
  const host = { call: () => assert.fail("native identity reached Desktop storage") };
  unlinkSync(join(sessionsRoot, "removed.jsonl"));
  await assert.rejects(
    remoteWorkspaceForFiles(() => host, removedSession.id, () => null),
    { errorCode: "NOT_FOUND" },
  );
  // The surviving session is untouched by its neighbour's deletion.
  assert.equal(await remoteWorkspaceForFiles(() => host, nativeSession.id, () => null), null);
});
