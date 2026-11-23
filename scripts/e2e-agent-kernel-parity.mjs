#!/usr/bin/env node
/**
 * Headless parity checks for the Rust kernel, beyond the wiring covered by
 * `scripts/e2e-agent-kernel.mjs`.
 *
 * The three gaps this file pins are all "the parameter reached the kernel and
 * had an effect", which no unit test can show on its own:
 *
 *   1. `mode: "plan"` on `agent.prompt` actually selects the plan tool set — the
 *      kernel declares no Write/Edit for that turn (and does declare them for an
 *      agent turn, so the read-out is proven not to be trivially empty).
 *   2. The launch-payload adapter turns `pluginTools` into `params.tools`, and
 *      forwards `mode`.
 *   3. `agent.executeApprovedPlan` is answered by the kernel instead of failing
 *      as an unknown method.
 *
 * Everything runs against the real host-core and the real kernel binary using the
 * kernel's own scripted provider: no network, no cost, no Electron.
 *
 *   node scripts/e2e-agent-kernel-parity.mjs
 *   node scripts/e2e-agent-kernel-parity.mjs --keep
 *
 * Binaries are overridable with PI_DESKTOP_AGENT_BIN / PI_DESKTOP_HOST_BIN so a
 * run never has to touch a tree another build is writing to.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { adaptKernelEvent } from "../apps/desktop/electron/main/kernel/kernel-adapter.ts";
import { adaptKernelPrompt } from "../apps/desktop/electron/main/kernel/kernel-prompt.ts";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const keep = process.argv.includes("--keep");
const tmpBase =
  process.env.PI_KERNEL_E2E_TMP?.trim() ||
  (existsSync("E:/99_Hermes/tmp") ? "E:/99_Hermes/tmp" : tmpdir());
const dataDir = mkdtempSync(join(tmpBase, "pi-kernel-parity-"));
const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push(`${name}${detail ? ` (${detail})` : ""}`);
}

const short = (value, limit = 600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

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
  if (!found) {
    throw new Error(
      `no kernel binary found (looked for ${names.join(", ")} under target/debug and target/release); ` +
        "set PI_DESKTOP_AGENT_BIN",
    );
  }
  return found;
}

/** host-core as the sidecar's reverse-proxy link (same shape as the wiring e2e). */
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

function startKernel(binary) {
  const events = [];
  const sidecar = new AgentSidecar({
    launch: {
      command: binary,
      args: ["serve"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PI_DESKTOP_DATA_DIR: dataDir },
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
  return { sidecar, events };
}

const waitFor = async (predicate, { timeoutMs = 20_000, label = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** An RPC failure as plain data, so a failing check prints the wire truth. */
async function rpcOutcome(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        code: error?.code,
        errorCode: error?.errorCode,
        data: error?.data,
      },
    };
  }
}

/**
 * The tool names the kernel would declare for a mode.
 *
 * `agent.tokenReport` answers with the declarations a request in that mode would
 * carry, so it is the witness for what the model actually sees. `agent.execPolicy`
 * is kept as a second, wider witness: it reports the live registry, which also
 * holds the tools that are available but deferred, so the registry is a superset
 * of the declarations and must never be the thing a declaration assertion reads.
 */
async function declaredToolNames(sidecar, sessionId, mode) {
  const policy = await rpcOutcome(sidecar.call("agent.execPolicy", {}));
  const report = await rpcOutcome(
    sidecar.call("agent.tokenReport", {
      sessionId,
      mode,
      provider: { kind: "scripted", script: [{ text: "unused" }] },
    }),
  );
  const policyNames = policy.ok
    ? (policy.value?.tools ?? []).map((row) => row?.name).filter(Boolean)
    : [];
  const reportNames = report.ok
    ? (report.value?.tools ?? []).map((row) => row?.name).filter(Boolean)
    : [];
  return {
    names: reportNames,
    registryNames: policyNames,
    detail: `agent.tokenReport=${report.ok ? short(reportNames) : short(report.error)}` +
      ` agent.execPolicy(registry)=${policy.ok ? short(policyNames) : short(policy.error)}`,
  };
}

const WRITE_TOOLS = ["Write", "Edit"];
const READ_TOOLS = ["Read", "Grep"];

let host;
let kernel;
try {
  console.log(`host-core : ${resolveHostBinary()}`);
  console.log(`kernel    : ${kernelBinary()}`);
  console.log(`profile   : ${dataDir}`);

  // ---- (b) the launch-payload adapter ------------------------------------
  // Pure module-level check: the same function main calls, no process involved.
  const adapterInput = {
    sessionId: "session-parity-adapter",
    content: "plan the change",
    mode: "plan",
    pluginTools: [
      { name: "plugin_x_y", description: "d", parameters: { type: "object" } },
    ],
    provider: {
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-key",
      modelId: "test-model",
      apiStyle: "openai-completions",
    },
  };
  let adapted;
  let adapterError;
  try {
    adapted = adaptKernelPrompt(adapterInput);
  } catch (error) {
    adapterError = error;
  }
  const adapterEvidence = adapterError
    ? `adaptKernelPrompt threw: ${adapterError.message}`
    : `params=${short(adapted?.params)} unsupported=${short(adapted?.unsupported)}`;
  check(
    "adapter forwards mode:plan to params.mode",
    adapted?.params?.mode === "plan",
    `params.mode=${short(adapted?.params?.mode ?? null)} ${adapterEvidence}`,
  );
  console.log(`adapter   : ${adapterEvidence}`);
  const adapterToolNames = (adapted?.params?.tools ?? [])
    .map((tool) => tool?.name ?? tool?.function?.name)
    .filter(Boolean);
  check(
    "adapter turns pluginTools into params.tools",
    adapterToolNames.includes("plugin_x_y"),
    `params.tools=[${adapterToolNames.join(", ")}] ${adapterEvidence}`,
  );

  // ---- kernel: plan mode must not declare the write tools ---------------
  host = new Host(resolveHostBinary(), dataDir, { quiet: false });
  await host.start(PROTOCOL_VERSION);
  const session = await host.call("session.create", { title: "kernel parity" });
  const sessionId = session?.session?.id ?? session?.session?.sessionId ?? session?.id;
  check("host-core creates a session", Boolean(sessionId), short(session));
  if (!sessionId) throw new Error("session.create returned no id");

  kernel = startKernel(kernelBinary());
  kernel.sidecar.setHost(hostLink(host));
  await kernel.sidecar.call("sidecar.configure", { dataDir });

  const planTurnId = "turn-parity-plan";
  const planAccepted = await rpcOutcome(
    kernel.sidecar.call("agent.prompt", {
      sessionId,
      turnId: planTurnId,
      content: "inspect the workspace and propose a plan",
      userMessageId: "user-parity-plan",
      mode: "plan",
      provider: { kind: "scripted", script: [{ text: "plan-proposal-from-kernel" }] },
    }),
  );
  check(
    "kernel accepts a plan-mode prompt",
    planAccepted.ok && planAccepted.value?.accepted === true,
    short(planAccepted.ok ? planAccepted.value : planAccepted.error),
  );
  if (planAccepted.ok && planAccepted.value?.accepted === true) {
    await waitFor(
      () => kernel.events.some((event) => event.event.type === "agent_end"),
      { label: "plan agent_end" },
    );
    const planTools = await declaredToolNames(kernel.sidecar, sessionId, "plan");
    console.log(`plan turn : [${planTools.names.join(", ")}]`);
    check(
      "plan mode declares no Write/Edit",
      planTools.names.length > 0 && !WRITE_TOOLS.some((name) => planTools.names.includes(name)),
      `declared=[${planTools.names.join(", ")}] ${planTools.detail}`,
    );
    check(
      "plan mode still declares the read tools",
      READ_TOOLS.every((name) => planTools.names.includes(name)),
      `declared=[${planTools.names.join(", ")}] missing=[${READ_TOOLS.filter((name) => !planTools.names.includes(name)).join(", ")}] ${planTools.detail}`,
    );

    // Agent mode in the same process: the same read-out must now show writes.
    // Without this, "no Write in plan mode" could pass because the read-out is
    // broken rather than because the mode withheld anything.
    const agentTurnId = "turn-parity-agent";
    const agentAccepted = await rpcOutcome(
      kernel.sidecar.call("agent.prompt", {
        sessionId,
        turnId: agentTurnId,
        content: "implement the plan",
        userMessageId: "user-parity-agent",
        provider: { kind: "scripted", script: [{ text: "agent-answer" }] },
      }),
    );
    check(
      "kernel accepts the agent-mode control prompt",
      agentAccepted.ok && agentAccepted.value?.accepted === true,
      short(agentAccepted.ok ? agentAccepted.value : agentAccepted.error),
    );
    if (agentAccepted.ok && agentAccepted.value?.accepted === true) {
      await waitFor(
        () => kernel.events.filter((event) => event.event.type === "agent_end").length >= 2,
        { label: "agent agent_end" },
      );
      const agentTools = await declaredToolNames(kernel.sidecar, sessionId, "agent");
      console.log(`agent turn: [${agentTools.names.join(", ")}]`);
      check(
        "the same read-out shows Write/Edit in agent mode",
        WRITE_TOOLS.every((name) => agentTools.names.includes(name)),
        `declared=[${agentTools.names.join(", ")}] ${agentTools.detail}`,
      );
    }
  }

  // ---- (c) agent.executeApprovedPlan must be answered, not unknown ------
  const execution = {
    id: "execution-parity-1",
    proposalId: "proposal-parity-1",
    sessionId,
    kind: "plan",
    plan: "# Plan\n\n1. Read the file.\n",
    title: "parity plan",
    question: "Approve this plan?",
    artifact: {
      relativePath: ".pi/plans/parity-plan.md",
      sha256: "0".repeat(64),
      sizeBytes: 26,
    },
    targetPermissionMode: "ask",
    state: "running",
  };
  const executionTurnId = "turn-parity-execution";
  const executed = await rpcOutcome(
    kernel.sidecar.call("agent.executeApprovedPlan", {
      sessionId,
      mode: "agent",
      turnId: executionTurnId,
      execution,
      provider: { kind: "scripted", script: [{ text: "executed-approved-plan" }] },
    }),
  );
  const executedError = executed.ok ? null : executed.error;
  const unknownMethod =
    !executed.ok &&
    (executedError.code === -32601 ||
      /UNSUPPORTED/i.test(String(executedError.errorCode ?? "")) ||
      /method not (found|supported)/i.test(String(executedError.message ?? "")));
  check(
    "agent.executeApprovedPlan is answered, not an unknown method",
    !unknownMethod,
    executed.ok
      ? `accepted=${short(executed.value?.accepted ?? null)} response=${short(executed.value)}`
      : `error.code=${short(executedError.code)} error.errorCode=${short(executedError.errorCode)} message=${short(executedError.message)} data=${short(executedError.data)}`,
  );
  if (!executed.ok && !unknownMethod) {
    console.log(`\nagent.executeApprovedPlan rejected the payload: ${short(executedError, 1200)}`);
  }
  if (executed.ok) {
    console.log(`\nagent.executeApprovedPlan answered: ${short(executed.value, 1200)}`);
  }

  console.log("\nchecks:");
  for (const entry of checks) {
    console.log(`  ${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.ok ? "" : `  ${entry.detail ?? ""}`}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(`\nERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  try {
    kernel?.sidecar?.dispose?.();
  } catch {
    /* the process is going away either way */
  }
  try {
    await host?.stop?.();
  } catch {
    /* ignore */
  }
  if (!keep) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else console.log(`kept profile: ${dataDir}`);
}

if (failures.length > 0) {
  console.error(`\nRESULT: FAIL (${failures.length} of ${checks.length}): ${failures.join(" | ")}`);
  process.exitCode = 1;
} else {
  console.log(`\nRESULT: PASS (${checks.length} checks)`);
}
