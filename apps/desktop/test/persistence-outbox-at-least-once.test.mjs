import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";

/*
 * At-least-once, with a stable key.
 *
 * A crash between "the host accepted the append" and "the outbox cleared its file"
 * cannot be avoided without a transaction spanning two processes, so the honest
 * contract is at-least-once delivery: the entry will be sent again after a restart.
 * What must therefore hold is that the *identity* survives the crash - the same `key`
 * arrives the second time, which is the only thing a host can dedupe on.
 *
 * This is the case the interrupted-write test does not reach: there the payload never
 * lands, so nothing was delivered. Here the append is delivered first and the process
 * dies while clearing, which is exactly when a duplicate would appear.
 */
test("a crash after delivery replays the same key, and then stops", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-at-least-once-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outboxPath = join(dir, "session-message-outbox.json");
  const entry = { key: "message:s:m1", sessionId: "s", message: { id: "m1" } };
  const moduleUrl = new URL("../electron/main/persistence-outbox.ts", import.meta.url).href;

  // The child delivers the entry, then dies while writing the cleared file. Doing it
  // in a child is what makes it a real crash rather than a rejected promise.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const originalWrite = fs.writeFile;
      let delivered = false;
      fs.writeFile = async (target, data, ...rest) => {
        // The outbox clears by writing an empty array; if the host has already
        // accepted the append, this is the moment a real crash would hurt.
        // The clear is written to the temp file and then renamed onto the target, so
        // the empty array shows up at the temp path rather than the final one.
        if (delivered && String(data).trim() === "[]") {
          await originalWrite(target, "", ...rest);
          process.exit(88);
        }
        return originalWrite(target, data, ...rest);
      };
      syncBuiltinESMExports();
      const { PersistenceOutbox } = await import(${JSON.stringify(moduleUrl)});
      const outbox = new PersistenceOutbox(${JSON.stringify(dir)}, () => {});
      await outbox.enqueue(${JSON.stringify(entry)}, () => ({
        isAvailable: () => true,
        call: async () => { delivered = true; },
      }));
      // Give the background drain a turn; the crash happens inside it.
      await new Promise((done) => setTimeout(done, 200));
      process.exit(0);
    `,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(child.status, 88, `expected the fault injection to fire: ${child.stderr || child.stdout}`);

  // The file still holds the entry: the crash happened before it was cleared.
  const survived = JSON.parse(await readFile(outboxPath, "utf8"));
  assert.equal(survived.length, 1, "the undelivered-clear entry is still on disk");
  assert.equal(survived[0].key, entry.key);

  // Restart: the same key is offered again, so a host can dedupe on it.
  const replayed = [];
  const recovered = new PersistenceOutbox(dir, () => {});
  await recovered.flush(() => ({
    isAvailable: () => true,
    call: async (method, params) => replayed.push({ method, params }),
  }));
  assert.equal(replayed.length, 1, "the entry is replayed exactly once after the restart");
  assert.equal(replayed[0].method, "session.appendMessage");
  // The outbox key stays local; what crosses to the host is the message, and the host
  // is idempotent per message id (`append_message` is asserted to be, in
  // plugin_sessions.rs). So the requirement here is that the *same id* is offered the
  // second time - that is what makes the duplicate harmless instead of a second row.
  assert.equal(
    replayed[0].params.message.id,
    entry.message.id,
    "the replayed append still carries the original message id",
  );
  assert.equal(replayed[0].params.sessionId, entry.sessionId);
  assert.deepEqual(replayed[0].params.message, entry.message);

  // And then it is gone: a second start must not deliver it a third time.
  assert.deepEqual(JSON.parse(await readFile(outboxPath, "utf8")), []);
  const again = [];
  await new PersistenceOutbox(dir, () => {}).flush(() => ({
    isAvailable: () => true,
    call: async (_method, params) => again.push(params.message),
  }));
  assert.deepEqual(again, [], "a cleared outbox delivers nothing on the next start");
});
