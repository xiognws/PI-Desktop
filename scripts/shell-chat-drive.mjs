#!/usr/bin/env node
/**
 * Drive real conversations inside the packaged app through the DevTools protocol.
 *
 * This is the last of the three verification surfaces: the headless harness proves
 * kernel + host-core; this proves the whole product — Electron main, renderer,
 * kernel, host-core, provider — holding real turns and running real tools, while
 * Kaspersky's behaviour engine is watching.
 *
 *   node scripts/shell-chat-drive.mjs --profile <dir> --turns 3 \
 *        --prompt "用 Bash 执行 echo shell-hello，然后只回复 DONE"
 *
 * The app is started against the given (throwaway) profile and stopped by PID when
 * the run ends.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const profile = arg("profile", "");
const port = Number(arg("port", "9334"));
const turns = Number(arg("turns", "3"));
const prompt = arg("prompt", "用 Bash 执行 echo shell-hello，然后只回复 DONE。只做这一步。");
const exe = join(root, "apps", "desktop", "release", "win-unpacked", "Pi-Workspace.exe");
if (!profile) throw new Error("--profile is required");
if (!existsSync(exe)) throw new Error(`no packaged app at ${exe}`);

const kes = () => {
  const xml =
    spawnSync("wevtutil", ["qe", "Kaspersky Endpoint Security", "/c:200", "/rd:true", "/f:xml"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout ?? "";
  const records = [];
  for (const block of xml.match(/(<Event\b[\s\S]*?<\/Event>)/g) ?? []) {
    const id = /<EventRecordID>(\d+)</.exec(block);
    if (!id) continue;
    const eventId = /<EventID[^>]*>(\d+)</.exec(block);
    records.push({
      record: Number(id[1]),
      eventId: eventId?.[1] ?? "?",
      text: block.replace(/<[^>]+>/g, " "),
    });
  }
  return records;
};

const suspect = /pi-workspace|pi-desktop|host-core|nubo-proto/i;
const baseline = Math.max(0, ...kes().map((r) => r.record));
console.log(`KES baseline: ${baseline}`);

const child = spawn(exe, [`--remote-debugging-port=${port}`], {
  env: { ...process.env, PI_DESKTOP_DATA_DIR: profile },
  cwd: dirname(exe),
  stdio: "ignore",
});
console.log(`launched pid=${child.pid} port=${port}`);
console.log(`profile: ${profile}`);

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  return {
    ready: new Promise((listener) => socket.addEventListener("open", listener)),
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId++;
      const result = new Promise((ok, fail) => pending.set(id, { resolve: ok, reject: fail }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "evaluate failed");
  return result.result?.value;
}

async function waitFor(cdp, expression, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(cdp, expression)) return true;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let cdp;
let exitCode = 0;
try {
  let target = null;
  for (let attempt = 0; attempt < 120 && !target; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      target = list.find((t) => t.type === "page" && !t.url.includes("plugin-launcher")) ?? null;
    } catch {
      /* not up yet */
    }
    if (!target) await delay(500);
  }
  if (!target) throw new Error("no renderer target");

  cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  const bootStart = Date.now();
  try {
    await waitFor(cdp, "!!document.querySelector('[contenteditable=\"true\"], textarea')", "the composer", 240);
  } catch (error) {
    const body = await evaluate(cdp, "(document.body && document.body.innerText || '').slice(0, 400)");
    console.error(`renderer after ${Math.round((Date.now() - bootStart) / 1000)}s: ${JSON.stringify(body)}`);
    throw error;
  }
  console.log(`composer ready after ${Math.round((Date.now() - bootStart) / 1000)}s\n`);

  for (let turn = 1; turn <= turns; turn += 1) {
    const before = await evaluate(cdp, "document.body.innerText.length");
    // The composer is a contenteditable div, so typing goes through real input
    // events rather than a value setter: `Input.insertText` then Enter is what a
    // keyboard does, and the app's own key handling opens the send path.
    const focused = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('[contenteditable="true"], textarea');
        if (!el) return 'no-composer';
        el.focus();
        return 'focused';
      })()`,
    );
    if (focused !== "focused") throw new Error(`could not focus the composer: ${focused}`);
    await cdp.send("Input.insertText", { text: prompt });
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        key: "Enter",
        code: "Enter",
        text: type === "keyDown" ? "\r" : undefined,
      });
    }
    const sent = "sent";
    if (sent !== "sent") throw new Error(`could not type into the composer: ${sent}`);

    // Streaming ends when the transcript stops growing and no stop control remains.
    let stable = 0;
    let last = before;
    let approvals = 0;
    const deadline = Date.now() + Number(arg("turn-wait-ms", "90000"));
    while (Date.now() < deadline) {
      await delay(1500);
      // A tool call waits for a person on the approval card; the driver is the
      // person, so it clicks the same button a user would.
      const allowed = await evaluate(
        cdp,
        `(() => {
          const button = [...document.querySelectorAll('button')]
            .find((b) => /允许本次对话|允许一次/.test(b.innerText || ''));
          if (!button) return false;
          button.click();
          return true;
        })()`,
      );
      if (allowed) {
        approvals += 1;
        console.log(`  approved a tool permission (total ${approvals})`);
      }
      const now = await evaluate(cdp, "document.body.innerText.length");
      const streaming = await evaluate(
        cdp,
        `!!document.querySelector('[aria-label*="停止"],[aria-label*="stop"],[data-streaming="true"]')`,
      );
      stable = now === last ? stable + 1 : 0;
      last = now;
      if (!streaming && stable >= 2) break;
    }
    const tail = await evaluate(cdp, "document.body.innerText.slice(-320)");
    console.log(`turn ${turn}: bodyText ${before} → ${last} chars`);
    console.log(`  tail: ${String(tail).replace(/\s+/g, " ").slice(-220)}`);
  }
} catch (error) {
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  try {
    cdp?.close();
  } catch {
    /* ignore */
  }
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await delay(1500);
  const fresh = kes().filter((r) => r.record > baseline);
  const hits = fresh.filter((r) => suspect.test(r.text));
  console.log(`\nKES new records: ${fresh.length}`);
  for (const record of fresh) {
    console.log(`  record ${record.record} event ${record.eventId}${suspect.test(record.text) ? "  <-- names our build" : ""}`);
  }
  console.log(`KES records naming our executables: ${hits.length}`);
  console.log(`\nRESULT: ${hits.length === 0 ? "PASS" : "FAIL"} (turns=${turns}, kesHits=${hits.length})`);
  if (hits.length > 0) exitCode = 1;
  process.exitCode = exitCode;
}
