// Stress the host's tools: several tools at once, repeatedly, while watching the
// endpoint agent's log and the machine's process table.
//
//   node scripts/stress-tools-av.mjs [--rounds 4] [--concurrency 6] [--vision 2]
//
// What it measures, because "it did not trip the AV once" is not a claim:
//   * every call's own answer (a unique token, so a wrong-but-successful result fails)
//   * latency per tool, so a serialized queue shows up as a number
//   * peak interpreter processes actually alive during the run
//   * endpoint-agent records created while it ran, and whether any names our binaries
//   * leftovers afterwards: child processes, temp files, a still-answering host
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const rounds = arg("rounds", 4);
const concurrency = arg("concurrency", 6);
const visionCalls = arg("vision", 2);
const keep = process.argv.includes("--keep");

const KES_CHANNEL = "Kaspersky Endpoint Security";
const OUR_NAMES = /pi-desktop-host-core|nubo-proto|pi-workspace/i;

/** Latest event record id, or null when the channel is absent on this machine. */
function kesLatestId() {
  try {
    const raw = execFileSync(
      "wevtutil",
      ["qe", KES_CHANNEL, "/c:1", "/rd:true", "/f:xml"],
      { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString("latin1")
      .replace(/\0/g, "");
    const match = raw.match(/<EventRecordID>(\d+)<\/EventRecordID>/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Event ids of records created after `since`, plus how many mention our binaries. */
function kesSince(since) {
  if (since === null) return { available: false, count: 0, ids: {}, ours: 0, total: 0 };
  try {
    const raw = execFileSync(
      "wevtutil",
      ["qe", KES_CHANNEL, "/c:400", "/rd:true", "/f:xml"],
      { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString("latin1")
      .replace(/\0/g, "");
    const events = raw.split(/<Event\b/).slice(1);
    const ids = {};
    let count = 0;
    let ours = 0;
    for (const event of events) {
      const idMatch = event.match(/<EventRecordID>(\d+)<\/EventRecordID>/);
      if (!idMatch || Number(idMatch[1]) <= since) continue;
      count += 1;
      const eventId = event.match(/<EventID[^>]*>(\d+)<\/EventID>/)?.[1] ?? "?";
      ids[eventId] = (ids[eventId] ?? 0) + 1;
      if (OUR_NAMES.test(event)) ours += 1;
    }
    return { available: true, count, ids, ours, total: events.length };
  } catch {
    return { available: false, count: 0, ids: {}, ours: 0, total: 0 };
  }
}

/**
 * Interpreter processes alive right now.
 *
 * Only `python.exe`: this machine runs other `node.exe` processes (not least the
 * agent running this script), so counting them would report the machine, not the
 * load. Reported as a delta against a baseline taken before the run.
 */
function interpreterCount() {
  try {
    const out = execFileSync("tasklist", ["/fo", "csv", "/nh"], {
      encoding: "latin1",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (out.match(/"python\.exe"/gi) ?? []).length;
  } catch {
    return 0;
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-tool-stress-"));
const workspace = join(dataDir, "workspace");
mkdirSync(workspace, { recursive: true });
const marker = join(workspace, "marker.txt");
writeFileSync(marker, "needle-in-here\nsecond line\n");
let host;
let peakChildren = 0;
let baselineChildren = 0;
let sampling = true;
const sample = (async () => {
  while (sampling) {
    peakChildren = Math.max(peakChildren, interpreterCount());
    await delay(400);
  }
})();

const results = [];
async function record(tool, run) {
  const started = Date.now();
  try {
    const value = await run();
    results.push({ tool, ok: true, ms: Date.now() - started, value });
    return value;
  } catch (error) {
    results.push({ tool, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    return null;
  }
}

try {
  const kesBefore = kesLatestId();
  host = new Host(resolveHostBinary(), dataDir, { quiet: true });
  await host.start(PROTOCOL_VERSION);
  baselineChildren = interpreterCount();
  // The session needs a workspace: Read and Grep resolve their roots against it, and
  // without one they are refused rather than served.
  const created = await host.call("session.create", {
    title: "tool stress",
    projectPath: workspace,
  });
  const sessionId = created?.session?.id ?? created?.id ?? created?.sessionId;

  // VisionAnalyze resolves the provider from this profile's store, so seed the one
  // provider this machine actually has. Written through host-core's own RPCs, the
  // same path the Settings page uses.
  const apiKey = process.env.PI_STRESS_API_KEY ?? process.env.HERMES_CUSTOM_LOCAL_PROXY_API_KEY ?? "";
  const baseUrl = process.env.PI_STRESS_BASE_URL ?? "http://127.0.0.1:28787/v1";
  const model = "wk-deepseek-v4.1-flash-011";
  if (visionCalls > 0) {
    if (!apiKey) throw new Error("vision calls need PI_STRESS_API_KEY");
    const provider = await host.call("providers.create", {
      name: "local-gateway",
      baseUrl,
      defaultModelId: model,
      type: "openai_compatible",
      protocol: "openai_compatible",
      authKind: "api_key_and_base_url",
    });
    const providerId = provider?.provider?.id ?? provider?.id;
    await host.call("providers.setSecret", { id: providerId, secretValue: apiKey });
    console.log(`seeded provider ${providerId} (${model} @ ${baseUrl})`);
  }

  const execute = (code, language = "python") =>
    host.call(
      "tools.execute",
      {
        sessionId,
        toolCallId: `stress-${Math.random().toString(36).slice(2, 10)}`,
        toolName: "ExecuteCode",
        mode: "agent",
        args: { code, language },
      },
      300_000,
    );

  // The first high-risk call raises the permission card; allowing the session is what
  // makes the rest of the run possible, and proves the grant is remembered.
  const first = execute("print('warmup')");
  for (let waited = 0; waited < 60_000; waited += 100) {
    const [pending] = host.matchingNotifications("permissions.request");
    if (pending) {
      await host.call("permissions.resolve", {
        requestId: pending.params.requestId,
        decision: "allow-session",
      });
      break;
    }
    await delay(100);
  }
  await first;
  host.clearNotifications();

  const tasks = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let slot = 0; slot < concurrency; slot += 1) {
      const token = `r${round}s${slot}`;
      // Mostly code execution — that is the process the endpoint agent would judge —
      // with file tools mixed in so the queue is not one tool's private path.
      tasks.push(
        record(`ExecuteCode/py#${token}`, async () => {
          const result = await execute(`print("token-${token}")`);
          const stdout = result?.content?.stdout ?? "";
          if (!stdout.includes(`token-${token}`)) throw new Error(`wrong stdout: ${JSON.stringify(stdout).slice(0, 120)}`);
          return result?.content?.exitCode;
        }),
      );
      if (slot % 3 === 0) {
        tasks.push(
          record(`ExecuteCode/node#${token}`, async () => {
            const result = await execute(`console.log("token-${token}")`, "node");
            const stdout = result?.content?.stdout ?? "";
            if (!stdout.includes(`token-${token}`)) throw new Error(`wrong stdout: ${JSON.stringify(stdout).slice(0, 120)}`);
            return result?.content?.exitCode;
          }),
        );
      }
      if (slot % 3 === 1) {
        tasks.push(
          record(`Read#${token}`, async () => {
            const result = await host.call(
              "tools.execute",
              {
                sessionId,
                toolCallId: `stress-read-${token}`,
                toolName: "Read",
                mode: "agent",
                args: { path: marker },
              },
              60_000,
            );
            const text = JSON.stringify(result?.content ?? "");
            if (!text.includes("needle-in-here")) throw new Error("marker not in the answer");
            return "read";
          }),
        );
      }
      if (slot % 3 === 2) {
        tasks.push(
          record(`Grep#${token}`, async () => {
            const result = await host.call(
              "tools.execute",
              {
                sessionId,
                toolCallId: `stress-grep-${token}`,
                toolName: "Grep",
                mode: "agent",
                args: { pattern: "needle", path: workspace },
              },
              60_000,
            );
            const text = JSON.stringify(result?.content ?? "");
            if (!text.includes("needle-in-here")) throw new Error("grep found nothing");
            return "grep";
          }),
        );
      }
    }
    await Promise.all(tasks.splice(0));
  }

  // Vision calls are provider round trips, so only a couple, and not concurrently
  // with the pool: their latency is the gateway's, not ours.
  if (visionCalls > 0) {
    const png = join(dataDir, "probe.png");
    writeFileSync(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    for (let index = 0; index < visionCalls; index += 1) {
      await record(`VisionAnalyze#${index}`, async () => {
        const result = await host.call(
          "tools.execute",
          {
            sessionId,
            toolCallId: `stress-vision-${index}`,
            toolName: "VisionAnalyze",
            mode: "agent",
            args: { image_url: png, question: "What colour is this image? One word." },
          },
          180_000,
        );
        return String(result?.content?.answer ?? "").slice(0, 40);
      });
    }
  }

  // The host must still answer after the load, and nothing may be left running.
  const stillAlive = await host
    .call("session.list", {}, 30_000)
    .then(() => true)
    .catch(() => false);
  // Two looks: a straggler still winding down at 1.5 s is not a leak, and a process
  // from another session on this machine is not ours to count. The later sample is
  // the one judged.
  await delay(1_500);
  const shortlyAfter = interpreterCount();
  await delay(4_000);
  const leftovers = interpreterCount();
  const tmpDir = join(dataDir, "tmp");
  let tmpFiles = 0;
  try {
    tmpFiles = readdirSync(tmpDir, { recursive: true }).length;
  } catch {
    tmpFiles = 0;
  }
  const kes = kesSince(kesBefore);
  sampling = false;
  await sample;

  const failed = results.filter((entry) => !entry.ok);
  const byTool = new Map();
  for (const entry of results) {
    const key = entry.tool.split("#")[0];
    const bucket = byTool.get(key) ?? { count: 0, fail: 0, ms: [] };
    bucket.count += 1;
    if (!entry.ok) bucket.fail += 1;
    bucket.ms.push(entry.ms);
    byTool.set(key, bucket);
  }

  console.log(`\ncalls: ${results.length} (${failed.length} failed)`);
  console.log("tool                     n   fail   p50     p95     max");
  for (const [tool, bucket] of [...byTool.entries()].sort()) {
    const sorted = [...bucket.ms].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    console.log(
      `${tool.padEnd(24)} ${String(bucket.count).padStart(2)}  ${String(bucket.fail).padStart(4)}  ${String(at(0.5)).padStart(5)}ms ${String(at(0.95)).padStart(6)}ms ${String(sorted.at(-1)).padStart(6)}ms`,
    );
  }
  for (const entry of failed.slice(0, 5)) console.log(`  FAILED ${entry.tool}: ${entry.error}`);

  console.log(`\npython.exe baseline / peak / after:         ${baselineChildren} / ${peakChildren} / ${leftovers}`);
  console.log(`  attributable to the load:                 peak +${peakChildren - baselineChildren}, after +${leftovers - baselineChildren}`);
  console.log(`host still answering afterwards:            ${stillAlive}`);
  console.log(`temp files left in <dataDir>/tmp:           ${tmpFiles}`);
  if (kes.available) {
    console.log(
      `endpoint-agent records during the run:      ${kes.count}${kes.count ? ` (ids ${JSON.stringify(kes.ids)})` : ""}`,
    );
    console.log(`  ...of which mention our binaries:         ${kes.ours}`);
    if (kes.count > 0 && Object.keys(kes.ids).length > 0) {
      console.log(`  (baseline record id ${kesBefore}, scanned ${kes.total} records)`);
    }
  } else {
    console.log("endpoint-agent log: not readable on this machine");
  }

  const bad =
    failed.length > 0 ||
    !stillAlive ||
    leftovers > baselineChildren ||
    (kes.available && kes.ours > 0);
  console.log(bad ? "\nRESULT: FAIL" : "\nRESULT: PASS");
  process.exitCode = bad ? 1 : 0;
} catch (error) {
  sampling = false;
  console.error(`ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
} finally {
  try {
    await host?.stop?.();
  } catch {
    /* ignore */
  }
  if (!keep) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else console.log(`kept profile: ${dataDir}`);
}
