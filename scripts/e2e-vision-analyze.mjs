// End-to-end probe for the host-core `VisionAnalyze` tool: a solid-colour PNG
// written from scratch, the configured provider, and the tool called exactly the
// way the kernel calls it. Answers "Red" when the whole path works.
//
//   node scripts/e2e-vision-analyze.mjs --profile <data-dir with a provider+key>
//
// The image is generated here rather than committed: a fixture nobody can read is
// worse than twenty lines of PNG encoding, and a solid colour has one right answer.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const profileArg = args.indexOf("--profile");
if (profileArg === -1 || !args[profileArg + 1]) {
  console.error("usage: node scripts/e2e-vision-analyze.mjs --profile <data-dir>");
  process.exit(2);
}
const profile = args[profileArg + 1];
const imagePath = resolve(profile, "vision-probe-red.png");

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

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour PNG, so "what colour is this?" has one correct answer. */
function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(dirname(imagePath), { recursive: true });
const bytes = solidPng(64, 64, [220, 20, 20]);
writeFileSync(imagePath, bytes);
console.log(`image: ${imagePath} (${bytes.length} bytes)`);

const { Host, resolveHostBinary } = await import(
  pathToFileURL(`${root}/scripts/e2e/host.mjs`).href
);
const { PROTOCOL_VERSION } = await import(
  pathToFileURL(`${root}/packages/shared/dist/protocol.js`).href
);

const host = new Host(resolveHostBinary(), profile, { quiet: true });
await host.start(PROTOCOL_VERSION);
let passed = false;
try {
  // A tool call resolves its permission scope against a real session.
  const created = await host.call("session.create", {
    projectPath: resolve(profile),
    title: "vision probe",
  });
  const sessionId = created?.session?.id ?? created?.id ?? created?.sessionId;
  const result = await host.call(
    "tools.execute",
    {
      sessionId,
      toolCallId: "vision-probe-call",
      toolName: "VisionAnalyze",
      mode: "agent",
      args: {
        image_url: imagePath,
        question: "What colour is this image? Answer with one word.",
      },
    },
    // The harness default is 30s; a provider round trip needs more.
    180_000,
  );
  const answer = String(result?.content?.answer ?? "");
  console.log(`answer: ${answer} (${result?.durationMs}ms, model ${result?.content?.model})`);
  passed = /\bred\b/i.test(answer);
} catch (error) {
  console.log(`ERROR: ${String(error?.message ?? error).slice(0, 600)}`);
} finally {
  await host.stop();
}
console.log(passed ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(passed ? 0 : 1);
