import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

/**
 * A vendor account (OAuth) has no stored api key, and the Node runtime resolves a
 * short-lived token per request. The kernel cannot, so the launch has to carry one —
 * without it every kernel turn was refused with KERNEL_PROMPT_INVALID.
 *
 * This pins both halves: a kernel launch carries the resolved token (and the headers
 * that come with it), and a Node launch does not, because that runtime refreshes for
 * itself and a token minted at launch would be stale by the end of a long turn.
 */
test("a vendor account's token travels with a kernel launch, and only with one", async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.vendor-oauth-kernel-test-"));
  const priorHome = process.env.HOME;
  const priorSwitch = process.env.PI_AGENT_CORE;
  process.env.HOME = temp;
  try {
    const bundle = join(temp, "session-launch.mjs");
    await build({
      entryPoints: [join(root, "apps/desktop/electron/main/runtime/session-launch.ts")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    const { createSessionLaunchRuntime } = await import(pathToFileURL(bundle).href);

    const provider = {
      id: "vendor-account",
      name: "Vendor account",
      authKind: "oauth",
      apiStyle: "anthropic_messages",
      baseUrl: "https://api.vendor.test",
      enabled: true,
      defaultModelId: "vendor-model",
      models: [{ id: "vendor-model" }],
    };
    const host = {
      isAvailable: () => true,
      async call(method) {
        if (method === "commandShells.list") {
          const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
          return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        }
        if (method === "providers.list") return { providers: [provider] };
        // A vendor account must never be asked for a stored secret.
        if (method === "providers.getSecret") throw new Error("vendor account has no stored secret");
        if (method === "skills.disabledBuiltins") return { disabled: [] };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "agents.active") return { subagents: [] };
        if (method === "agents.disabledBuiltins") return { disabled: [] };
        throw new Error("Unexpected fixture Host method: " + method);
      },
    };
    let resolveAuthCalls = 0;
    const launchRuntime = createSessionLaunchRuntime({
      runtimeState: { host, sidecar: { setVendorAuthBindings() {} }, agentHostBridge: null },
      logger: { app() {} },
      userMcp: { setRecords() {}, async toolsForProject() { return []; } },
      plugins: { getTools: () => [], getSkills: () => [], listLoaded: () => [], getAgentExtensions: () => [] },
      sessionProjects: new Map(),
      dataDir: temp,
      vendorOAuth: {
        async bindingFor() {
          return { baseUrl: "https://api.vendor.test", apiStyle: "anthropic_messages" };
        },
        async resolveAuth() {
          resolveAuthCalls += 1;
          return { apiKey: "short-lived-token", headers: { "vendor-account-id": "acct_1" } };
        },
      },
      modelsDevCatalog: { async ensureLoaded() {}, configureAccount() {}, findModel() { return undefined; } },
      getWorkspacePath: () => null,
      pluginActiveInProject: () => true,
      bindingForModel: (_provider, modelId) => ({
        id: modelId,
        contextWindow: 200_000,
        maxTokens: 8_192,
        thinkingLevels: [],
        defaultThinkingLevel: null,
      }),
      effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
      normalizeThinkingLevel: () => "off",
    });

    const launch = async () => {
      const { sidecarParams } = await launchRuntime.resolveAgentRuntimeLaunch(
        "session-fixture",
        { providerId: provider.id, modelId: "vendor-model" },
        { defaultProviderId: provider.id, defaultModelId: "vendor-model", defaultMode: "agent" },
      );
      return sidecarParams.provider;
    };

    delete process.env.PI_AGENT_CORE;
    const kernel = await launch();
    assert.equal(kernel.apiKey, "short-lived-token");
    assert.equal(kernel.headers["vendor-account-id"], "acct_1");
    assert.equal(resolveAuthCalls, 1);

    process.env.PI_AGENT_CORE = "node";
    const node = await launch();
    assert.equal(node.apiKey, "");
    assert.equal(node.headers, undefined);
    // The Node runtime resolves per request; a second resolve here would be wasted.
    assert.equal(resolveAuthCalls, 1);
  } finally {
    process.env.HOME = priorHome;
    if (priorSwitch === undefined) delete process.env.PI_AGENT_CORE;
    else process.env.PI_AGENT_CORE = priorSwitch;
    await rm(temp, { recursive: true, force: true });
  }
});
