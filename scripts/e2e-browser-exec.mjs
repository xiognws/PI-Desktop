// End-to-end proof that `browser_exec` returns a page *after* JavaScript ran.
//
//   node scripts/e2e-browser-exec.mjs [--temp] [--keep]
//
// The fixture is a local file that injects a node from JavaScript: a tool that
// returned the raw HTML would pass a "did it fetch" check and fail this one. The
// browser profile is reused across runs by default, because a cold profile costs
// about 100 s and a warm one about 30 s — measuring a feature that documents its own
// slowness should not spend three minutes doing it.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const useTemp = process.argv.includes("--temp");
const keep = process.argv.includes("--keep");
const dataDir = useTemp
  ? mkdtempSync(join(tmpdir(), "pi-browser-e2e-"))
  : join(tmpdir(), "pi-browser-e2e-persistent");
mkdirSync(dataDir, { recursive: true });
const workspace = join(dataDir, "workspace");
mkdirSync(workspace, { recursive: true });

const fixture = join(workspace, "rendered.html");
writeFileSync(
  fixture,
  `<!doctype html><html><body><h1>static-heading</h1>
   <script>
     document.body.insertAdjacentHTML("beforeend", "<p id='injected'>added-by-javascript</p>");
     document.title = "title-set-by-js";
   </script></body></html>`,
);

let host;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
};

const run = async (sessionId, args) => {
  const started = Date.now();
  const promise = host.call(
    "tools.execute",
    {
      sessionId,
      toolCallId: `browser-${args.mode}-${started}`,
      toolName: "BrowserExec",
      mode: "agent",
      args,
    },
    300_000,
  );
  for (let waited = 0; waited < 60_000; waited += 100) {
    const [pending] = host.matchingNotifications("permissions.request");
    if (pending) {
      await host.call("permissions.resolve", {
        requestId: pending.params.requestId,
        decision: "allow-session",
      });
      host.clearNotifications();
      break;
    }
    await delay(100);
  }
  const result = await promise;
  return { content: result?.content ?? {}, elapsed: Date.now() - started };
};

try {
  host = new Host(resolveHostBinary(), dataDir, { quiet: true });
  await host.start(PROTOCOL_VERSION);
  const created = await host.call("session.create", { title: "browser e2e", projectPath: workspace });
  const sessionId = created?.session?.id ?? created?.id ?? created?.sessionId;
  const url = pathToFileURL(fixture).href;

  const dom = await run(sessionId, { url, mode: "dom" });
  const domText = String(dom.content.content ?? "");
  check(
    "the DOM came back with the node JavaScript added",
    domText.includes("added-by-javascript"),
    domText.slice(0, 200),
  );
  check("the static markup is there too", domText.includes("static-heading"));
  console.log(`  dom: ${dom.elapsed}ms, ${dom.content.bytes ?? "?"} bytes, truncated=${dom.content.truncated}`);

  const text = await run(sessionId, { url, mode: "text" });
  const textOut = String(text.content.content ?? "");
  check(
    "text mode strips the script tag but keeps the rendered text",
    textOut.includes("added-by-javascript") && !textOut.includes("insertAdjacentHTML"),
    textOut.slice(0, 200),
  );
  console.log(`  text: ${text.elapsed}ms, ${textOut.length} chars`);

  const shot = await run(sessionId, { url, mode: "screenshot" });
  const shotPath = String(shot.content.screenshotPath ?? "");
  const size = shotPath && existsSync(shotPath) ? statSync(shotPath).size : 0;
  check("the screenshot landed on disk", size > 1000, `${shotPath} (${size} bytes)`);
  check(
    "it landed inside the workspace",
    shotPath ? resolve(shotPath).startsWith(resolve(workspace)) : false,
    shotPath,
  );
  console.log(`  screenshot: ${shot.elapsed}ms, ${size} bytes → ${shotPath}`);

  // A second dump proves the profile is reused rather than recreated: the first run
  // in a fresh profile pays for the whole browser start.
  const again = await run(sessionId, { url, mode: "dom" });
  console.log(`  second dump: ${again.elapsed}ms (profile reuse)`);
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  failures += 1;
} finally {
  try {
    await host?.stop?.();
  } catch {
    /* ignore */
  }
  if (useTemp && !keep) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else console.log(`profile kept: ${dataDir}`);
}

console.log(failures === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
