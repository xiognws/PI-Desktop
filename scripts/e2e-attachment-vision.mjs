// End-to-end proof that an attached image reaches a real model.
//
// The chain under test is the one the desktop uses: a prompt whose `attachments`
// name a file on disk, a provider that can see, and the kernel turning the file
// into an image part. A solid red PNG must come back as "red" — anything else means
// the picture was dropped somewhere between the prompt and the wire.
//
//   PI_STRESS_API_KEY=<key> node scripts/e2e-attachment-vision.mjs
//
// The provider is passed explicitly, so this needs no seeded profile; host-core gets
// a throwaway data directory and the key never touches disk.
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { adaptKernelEvent } from "../apps/desktop/electron/main/kernel/kernel-adapter.ts";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const apiKey = process.env.PI_STRESS_API_KEY?.trim();
const baseUrl = process.env.PI_STRESS_BASE_URL?.trim() ?? "http://127.0.0.1:28787/v1";
const modelId = process.env.PI_STRESS_MODEL?.trim() ?? "wk-deepseek-v4.1-flash-011";
const keep = process.argv.includes("--keep");

if (!apiKey) {
  console.error("PI_STRESS_API_KEY is required");
  process.exit(2);
}

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour PNG, so "what colour is this?" has one right answer. */
function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function kernelBinary() {
  const configured = process.env.PI_DESKTOP_AGENT_BIN?.trim();
  const names = process.platform === "win32" ? ["nubo-proto.exe"] : ["nubo-proto"];
  const candidates = [
    ...(configured ? [configured] : []),
    ...names.flatMap((name) => [
      join(root, "target", "debug", name),
      join(root, "target", "release", name),
    ]),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("no kernel binary; run `cargo build -p agent-core --bin nubo-proto`");
  return found;
}

function hostLink(host) {
  return {
    call: (method, params) => host.call(method, params),
    onNotification: () => () => {},
    onExit: (handler) => {
      let done = false;
      void host.exitPromise.then((info) => {
        if (done) return;
        done = true;
        handler(info);
      });
      return () => {
        done = true;
      };
    },
  };
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-attachment-e2e-"));
const imagePath = join(dataDir, "probe.png");
mkdirSync(dataDir, { recursive: true });
writeFileSync(imagePath, solidPng(64, [220, 20, 20]));
console.log(`image: ${imagePath} (${solidPng(64, [220, 20, 20]).length} bytes)`);

let host;
let sidecar;
const events = [];
let failures = 0;

try {
  host = new Host(resolveHostBinary(), dataDir, { quiet: true });
  await host.start(PROTOCOL_VERSION);
  const session = await host.call("session.create", { title: "attachment e2e" });
  const sessionId = session?.session?.id ?? session?.id ?? session?.sessionId;

  sidecar = new AgentSidecar({
    launch: {
      command: kernelBinary(),
      args: ["serve"],
      env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir },
    },
    onStderr: (text) => {
      if (process.env.DEBUG_KERNEL) process.stderr.write(text);
    },
  });
  sidecar.onNotification((method, params) => {
    if (method !== "agent.event") return;
    const envelope = adaptKernelEvent(params);
    if (envelope) events.push(envelope);
  });
  sidecar.setHost(hostLink(host));
  await sidecar.call("sidecar.configure", { dataDir });

  const accepted = await sidecar.call("agent.prompt", {
    sessionId,
    turnId: "turn-attachment-1",
    userMessageId: "user-attachment-1",
    mode: "agent",
    workspaceRoot: dataDir,
    modelId,
    // The desktop derives this from the model catalog; without it the kernel keeps
    // the picture as a text reference instead of sending it.
    supportsVision: true,
    content: "What colour is the attached image? Answer with one word.",
    attachments: [{ kind: "image", name: "probe.png", mimeType: "image/png", path: imagePath }],
    provider: { kind: "openai", baseUrl, apiKey },
  });
  if (accepted?.accepted !== true) {
    console.log(`FAIL  the kernel refused the prompt: ${JSON.stringify(accepted)}`);
    failures += 1;
  }

  const deadline = Date.now() + 120_000;
  let answer = "";
  while (Date.now() < deadline) {
    const end = events.find((event) => event.event.type === "agent_end");
    if (end) {
      // The answer rides on the last assistant message, not on agent_end itself.
      const last = events
        .filter(
          (event) =>
            event.event.type === "message_end" && event.event.message?.role === "assistant",
        )
        .pop();
      answer = String(last?.event.message?.content ?? "");
      break;
    }
    const failed = events.find((event) => event.event.type === "error");
    if (failed) {
      console.log(`FAIL  the turn errored: ${JSON.stringify(failed.event)}`);
      failures += 1;
      break;
    }
    await delay(500);
  }

  console.log(`events: ${[...new Set(events.map((e) => e.event.type))].join(", ") || "none"}`);
  console.log(`answer: ${answer || "(none)"}`);
  // The answer comes back in whichever language the model picks, so both spellings
  // count; a wrong-colour answer still fails, which is the point of the check.
  const mentionsRed = /red|红/i.test(answer);
  console.log(`check: ${mentionsRed ? "PASS" : "FAIL"}  the model saw the attached image`);
  if (!mentionsRed) failures += 1;
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  failures += 1;
} finally {
  try {
    sidecar?.dispose?.();
  } catch {
    /* going away anyway */
  }
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
