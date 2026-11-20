// End-to-end proof that `ExecuteCode` runs a snippet and returns its output.
//
// It also exercises the approval path on purpose: the tool is high risk (it runs
// whatever a model writes), so an unapproved call has to reach the permission card
// rather than run silently. This script answers that card the way the renderer does
// and then checks the program's own output came back.
//
//   node scripts/e2e-execute-code.mjs [--keep]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const dataDir = mkdtempSync(join(tmpdir(), "pi-execute-code-e2e-"));
let host;
let failures = 0;

function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
}

try {
  host = new Host(resolveHostBinary(), dataDir, { quiet: true });
  await host.start(PROTOCOL_VERSION);
  const created = await host.call("session.create", { title: "execute-code e2e" });
  const sessionId = created?.session?.id ?? created?.id ?? created?.sessionId;

  const running = host.call(
    "tools.execute",
    {
      sessionId,
      toolCallId: "execute-code-call",
      toolName: "ExecuteCode",
      mode: "agent",
      args: { code: "print(2 + 2)" },
    },
    120_000,
  );

  // Answer the permission card exactly like the renderer: find the pending request
  // and allow this session.
  let approvals = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const [pending] = host.matchingNotifications(
      "permissions.request",
      (note) => note.params?.requestId !== undefined,
    );
    if (pending) {
      await host.call("permissions.resolve", {
        requestId: pending.params.requestId,
        decision: "allow-session",
      });
      approvals += 1;
      break;
    }
    await delay(100);
  }

  const result = await running;
  const stdout = String(result?.content?.stdout ?? result?.content?.output ?? "");
  const exitCode = result?.content?.exitCode ?? result?.content?.exit_code;
  check("the call asked for approval before running", approvals === 1, `approvals=${approvals}`);
  check("the snippet's output came back", stdout.includes("4"), `stdout=${JSON.stringify(stdout).slice(0, 200)}`);
  check("the process exited successfully", Number(exitCode) === 0, `exitCode=${exitCode}`);
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  failures += 1;
} finally {
  try {
    await host?.stop?.();
  } catch {
    /* ignore */
  }
  if (!keep) rmSync(dataDir, { recursive: true, force: true });
  else console.log(`kept profile: ${dataDir}`);
}

console.log(failures === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
