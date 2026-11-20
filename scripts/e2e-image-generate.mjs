// End-to-end proof that `image_generate` draws a picture and lands it on disk.
//
//   PI_STRESS_API_KEY=<key> node scripts/e2e-image-generate.mjs [--keep]
//
// The provider row is seeded through host-core's own RPCs into a throwaway data
// directory; the generated file has to exist, be a real PNG, and come back as a path
// the model can then read. The gateway's own URLs are short-lived signed links, so a
// tool that returned them instead of downloading would pass a weaker check and fail
// in practice.
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const apiKey = process.env.PI_STRESS_API_KEY ?? process.env.HERMES_CUSTOM_LOCAL_PROXY_API_KEY ?? "";
const baseUrl = process.env.PI_STRESS_BASE_URL ?? "http://127.0.0.1:28787/v1";
const model = "wk-deepseek-v4.1-flash-011";
if (!apiKey) {
  console.error("PI_STRESS_API_KEY is required");
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-image-e2e-"));
const workspace = join(dataDir, "workspace");
mkdirSync(workspace, { recursive: true });

let host;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
};

try {
  host = new Host(resolveHostBinary(), dataDir, { quiet: true });
  await host.start(PROTOCOL_VERSION);
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

  const created = await host.call("session.create", {
    title: "image e2e",
    projectPath: workspace,
  });
  const sessionId = created?.session?.id ?? created?.id ?? created?.sessionId;

  const started = Date.now();
  const running = host.call(
    "tools.execute",
    {
      sessionId,
      toolCallId: "image-generate-call",
      // The snake_case spelling is the one the host draws for; the PascalCase name is
      // still claimed by the desktop runner's gate, so it must not reach this path.
      toolName: "image_generate",
      mode: "agent",
      args: { prompt: "a single red circle on a white background", n: 1 },
    },
    240_000,
  );

  // Whatever the risk class, the card has to be answered before anything runs.
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

  const result = await running;
  const elapsed = Date.now() - started;
  const paths = result?.content?.paths ?? [];
  check("the tool returned a local path", paths.length === 1, JSON.stringify(result?.content ?? {}).slice(0, 300));

  if (paths.length === 1) {
    const file = String(paths[0]);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0;
    }
    const insideWorkspace = resolve(file).startsWith(resolve(workspace));
    check("the file exists on disk", size > 1000, `${file} (${size} bytes)`);
    check("it landed inside the workspace", insideWorkspace, file);
    console.log(`\nfile: ${file}`);
    console.log(`size: ${size} bytes, elapsed: ${elapsed}ms, model: ${result?.content?.model ?? "?"}`);
  }
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
