/**
 * Windows 上的短暂文件锁不能变成主进程崩溃。
 *
 * 现场：一次真实退出里，`app/runtime.log` 连续出现
 * `EPERM: operation not permitted, rename 'session-message-outbox.json.tmp' ->
 * 'session-message-outbox.json'`，随后进程消失，`run-marker.json` 残留。
 * 原因是持久化 outbox 的原子替换只调一次 `rename`，而 Windows 在目标文件仍被
 * 别的句柄（扫描器、杀毒、残留实例）占用时会短暂拒绝。
 *
 * 这里锁两个不变量：短暂被占用时最终写成功且内容正确；一直失败时降级为 warn，
 * 既不抛出也不损坏已提交的文件。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const moduleUrl = new URL("../electron/main/persistence-outbox.ts", import.meta.url).href;
/**
 * Run a scenario in a child so fs fault injection stays isolated.
 *
 * Reports what actually happened instead of asserting inside the child: the
 * point is the outbox's own behavior (does it throw? what did it log?), not a
 * test assertion competing with the fault.
 */
function runScenario(dir, body) {
  const script = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const originalRename = fs.rename;
    const dir = ${JSON.stringify(dir)};
    const target = ${JSON.stringify(join(dir, "session-message-outbox.json"))};
    ${body}
    syncBuiltinESMExports();
    const { PersistenceOutbox } = await import(${JSON.stringify(moduleUrl)});
    const logs = [];
    const outbox = new PersistenceOutbox(dir, (level, message, data) => {
      logs.push({ level, message, data });
    });
    let error = null;
    try {
      await outbox.enqueue(
        { key: "message:s:m", sessionId: "s", message: { id: "m" } },
        () => null,
      );
    } catch (caught) {
      error = String(caught);
    }
    const blocked = logs.filter((row) => row.message.includes("blocked by the filesystem"));
    console.log(JSON.stringify({
      error,
      blockedCount: blocked.length,
      blockedLevel: blocked[0]?.level ?? null,
    }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("短暂被占用（前两次 EPERM）后写入成功且不报警", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = runScenario(
    dir,
    `
    let attempts = 0;
    fs.rename = async (from, to) => {
      if (to === target && attempts++ < 2) {
        throw Object.assign(new Error("fixture lock"), { code: "EPERM" });
      }
      return originalRename(from, to);
    };
    `,
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout.trim()), {
    error: null,
    blockedCount: 0,
    blockedLevel: null,
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")).map(
      (row) => row.message.id,
    ),
    ["m"],
    "the queued append must reach the file once the lock clears",
  );
});

test("一直失败时降级为 warn，不抛出且不损坏已提交文件", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const committed = JSON.stringify([
    { key: "old", sessionId: "s", message: { id: "old" } },
  ]) + "\n";
  await writeFile(join(dir, "session-message-outbox.json"), committed);
  const child = runScenario(
    dir,
    `
    fs.rename = async (from, to) => {
      if (to === target) throw Object.assign(new Error("fixture lock"), { code: "EACCES" });
      return originalRename(from, to);
    };
    `,
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout.trim());
  // The persist is reported, never thrown: one held handle must not become an
  // uncaught rejection that takes the app down.
  assert.equal(report.error, null);
  assert.equal(report.blockedCount, 1);
  assert.equal(report.blockedLevel, "warn");
  assert.equal(
    await readFile(join(dir, "session-message-outbox.json"), "utf8"),
    committed,
    "the committed file must keep its bytes",
  );
});

test("改名被拒但目标内容已一致时视为成功，不报警", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "session-message-outbox.json");
  // 模拟"上一次已经落盘"：先写入与本次完全相同的内容，再让 rename 一直失败。
  await writeFile(
    target,
    JSON.stringify([
      { key: "message:s:m", sessionId: "s", message: { id: "m" } },
    ]) + "\n",
  );
  const child = runScenario(
    dir,
    `
    fs.rename = async (from, to) => {
      if (to === target) throw Object.assign(new Error("fixture scanner"), { code: "EBUSY" });
      return originalRename(from, to);
    };
    `,
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout.trim());
  // 内容已经一致就不该再和扫描器抢同一个文件：直接算成功。
  assert.equal(report.error, null);
  assert.equal(report.blockedCount, 0);
  assert.equal(report.blockedLevel, null);
});
