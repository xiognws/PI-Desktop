#!/usr/bin/env node
/**
 * Seed a throwaway desktop profile with one provider, so the packaged app can hold
 * a real conversation without touching any existing profile.
 *
 *   node scripts/seed-kernel-test-profile.mjs --profile <dir> --base-url ... --model ... 
 *
 * The provider row is written by host-core itself (`providers.create` +
 * `providers.setSecret`), which is the same path the Settings page uses — a
 * hand-written sqlite row would not be trustworthy.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const profile = arg("profile", "");
const baseUrl = arg("base-url", "http://127.0.0.1:28787/v1");
const model = arg("model", "wk-deepseek-v4.1-flash-011");
const apiKey = process.env.PI_STRESS_API_KEY ?? process.env.HERMES_CUSTOM_LOCAL_PROXY_API_KEY ?? "";

if (!profile) throw new Error("--profile is required");
if (!apiKey) throw new Error("no API key: set PI_STRESS_API_KEY");
mkdirSync(profile, { recursive: true });

const unpacked = join(root, "apps", "desktop", "release", "win-unpacked");
const packagedHost = join(
  unpacked,
  "resources",
  "bin",
  process.platform === "win32" ? "pi-desktop-host-core.exe" : "pi-desktop-host-core",
);
const hostBinary = existsSync(packagedHost) ? packagedHost : resolveHostBinary();

const host = new Host(hostBinary, profile, { quiet: false });
try {
  await host.start(PROTOCOL_VERSION);
  const existing = await host.call("providers.list");
  const providers = existing?.providers ?? existing?.rows ?? [];
  if (providers.length > 0) {
    console.log(`profile already has ${providers.length} provider(s); nothing to seed`);
  } else {
    const created = await host.call("providers.create", {
      name: "local-gateway",
      baseUrl,
      defaultModelId: model,
      type: "openai_compatible",
      protocol: "openai_compatible",
      authKind: "api_key_and_base_url",
    });
    const id = created?.provider?.id ?? created?.id;
    if (!id) throw new Error(`providers.create returned no id: ${JSON.stringify(created)}`);
    await host.call("providers.setSecret", { id, secretValue: apiKey });
    console.log(`seeded provider ${id} (${model} @ ${baseUrl})`);
  }
  const list = await host.call("providers.list");
  const rows = list?.providers ?? list?.rows ?? [];
  console.log(`providers in profile: ${rows.length} → ${rows.map((r) => `${r.name ?? r.id}`).join(", ")}`);
} finally {
  await host.stop?.();
}
