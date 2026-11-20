#!/usr/bin/env node
/**
 * Step 1 of the in-shell verification: launch the packaged app against a throwaway
 * profile with the DevTools protocol open, then report what the chat surface looks
 * like (targets, composer, send button) so the driver can talk to it.
 *
 *   node scripts/shell-cdp-probe.mjs --profile <dir> [--port 9333]
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const profile = arg("profile", "");
const port = Number(arg("port", "9333"));
const keep = process.argv.includes("--keep");

const exe = join(root, "apps", "desktop", "release", "win-unpacked", "Pi-Workspace.exe");
if (!profile) throw new Error("--profile is required");
if (!existsSync(exe)) throw new Error(`no packaged app at ${exe}`);

const child = spawn(exe, [`--remote-debugging-port=${port}`], {
  env: { ...process.env, PI_DESKTOP_DATA_DIR: profile },
  cwd: dirname(exe),
  detached: false,
  stdio: "ignore",
});
console.log(`launched pid=${child.pid} port=${port} profile=${profile}`);

async function targets() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      if (list.length > 0) return list;
    } catch {
      /* not listening yet */
    }
    await delay(500);
  }
  throw new Error(`devtools endpoint never came up on ${port}`);
}

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
  const ready = new Promise((listener) => socket.addEventListener("open", listener));
  return {
    ready,
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId++;
      const promise = new Promise((resolveCall, rejectCall) => pending.set(id, { resolve: resolveCall, reject: rejectCall }));
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
  };
}

try {
  const list = await targets();
  console.log(`\ntargets (${list.length}):`);
  for (const target of list) console.log(`  ${target.type}  ${target.title}  ${target.url}`);

  const page = list.find((t) => t.type === "page") ?? list[0];
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");

  // The window exists before its renderer has drawn anything: wait for a body,
  // then for the chat surface, instead of reading a blank document.
  const waitForDom = async (expression, label, attempts = 60) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: false,
      });
      if (result?.result?.value) return result.result.value;
      await delay(500);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  await waitForDom("document.readyState === 'complete' && !!document.body", "document.body");
  // The splash screen is a real page; the chat surface is what the driver needs.
  await waitForDom("!!document.querySelector('textarea, [contenteditable], [role=\"textbox\"]')", "the composer", 120).catch(() => {
    console.log("(composer never appeared; dumping whatever the window shows)");
  });

  const dump = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const describe = (el) => ({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 50),
        role: el.getAttribute('role'),
        editable: el.getAttribute('contenteditable'),
        placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-label') || '',
      });
      const candidates = [...document.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]')]
        .slice(0, 12).map(describe);
      return JSON.stringify({ candidates, bodyText: (document.body && document.body.innerText || '').slice(0, 200) }, null, 1);
    })()`,
    returnByValue: true,
  });
  console.log("\ncomposer candidates:\n" + (dump.result?.value ?? JSON.stringify(dump)));
  cdp.close();
} finally {
  if (!keep) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      console.log(`\nstopped pid=${child.pid} (use --keep to leave it running)`);
    } catch {
      /* ignore */
    }
  }
}
