import assert from "node:assert/strict";
import test from "node:test";

const {
  FORWARDED_PROMPT_PARAMS,
  KNOWN_UNSUPPORTED_PROMPT_PARAMS,
  RENAMED_PROMPT_PARAMS,
  adaptKernelPrompt,
  adaptKernelProvider,
} = await import("../electron/main/kernel/kernel-prompt.ts");

/*
 * The prompt adapter is the difference between "the kernel answers" and "the
 * kernel answers about a different question": the launch payload carries the
 * user's text, the endpoint, the model window and the declarations. These cases
 * pin both halves — what reaches the kernel, and what is reported as missing
 * instead of being dropped in silence.
 */

/** `launch.sidecarParams.modeTurn`: the staged run this turn claimed (mode-runs.ts). */
const MODE_TURN = {
  runId: "run-1",
  stageId: "implement",
  origin: "user",
  enteredStage: true,
  input: "把 README 里的旧文案改掉",
  artifactPaths: { goal: ".pi/runs/run-1/goal.md" },
};

/** A launch payload shaped like `launch.sidecarParams` + the prompt fields. */
const LAUNCH = {
  sessionId: "session-1",
  turnId: "turn-1",
  content: "把 README 里的旧文案改掉",
  mode: "agent",
  thinkingLevel: "medium",
  commandShell: "git-bash",
  scratchDir: "D:/data/scratch/session-1",
  attachmentsDir: "D:/data/attachments",
  attachments: [],
  customSystemPrompt: "be terse",
  projectInstructions: { files: [] },
  projectMemory: [],
  projectPath: "D:/work/project",
  workspaceRoot: "D:/work/project",
  mcpServerIds: ["srv-1"],
  mcpToolNames: [],
  modeTurn: MODE_TURN,
  skillReview: { enabled: true },
  subagents: [{ name: "reviewer" }],
  tools: [{ name: "Read", description: "read a file", parameters: {} }],
  provider: {
    id: "provider-1",
    name: "DeepSeek",
    vendorKey: "deepseek",
    baseUrl: "https://api.example.com/v1",
    modelId: "deepseek-chat",
    apiKey: "sk-test",
    apiStyle: "openai-completions",
    authKind: "api_key",
    headers: { "x-tenant": "acme" },
    modelConfig: { contextWindow: 128000, maxOutputTokens: 8192 },
  },
};

/** `launch.sidecarParams.pluginTools`: plugin agent tools plus the user's MCP tools. */
const PLUGIN_TOOLS = [
  {
    name: "plugin_demo_probe",
    description: "Probe a URL",
    parameters: { type: "object", properties: { url: { type: "string" } } },
    risk: "low",
    planSafeActions: ["inspect"],
  },
  {
    name: "mcp__filesystem__read_file",
    mcpServerId: "srv-1",
    description: "Read a file through the MCP server",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

test("a launch payload reaches the kernel with its endpoint, model and identity", () => {
  const { params } = adaptKernelPrompt(LAUNCH);
  assert.equal(params.sessionId, "session-1");
  assert.equal(params.turnId, "turn-1");
  assert.equal(params.content, LAUNCH.content);
  assert.equal(params.modelId, "deepseek-chat", "model comes from the provider row");
  assert.equal(params.contextWindow, 128000, "the window is flattened from modelConfig");
  assert.deepEqual(params.provider, {
    kind: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    name: "DeepSeek",
    headers: { "x-tenant": "acme" },
    defaultMaxTokens: 8192,
  });
  for (const key of ["projectPath", "workspaceRoot", "mcpServerIds", "mcpToolNames", "skillReview", "subagents", "tools"]) {
    assert.deepEqual(params[key], LAUNCH[key], `${key} passes through`);
  }
});

test("launch parameters the kernel cannot read are reported, not dropped", () => {
  const { unsupported } = adaptKernelPrompt(LAUNCH);
  for (const key of [
    "projectMemory",
    "attachmentsDir",
    "scratchDir",
  ]) {
    assert.ok(unsupported.includes(key), `${key} is reported as unsupported`);
  }
  for (const key of [
    "mode",
    "thinkingLevel",
    "commandShell",
    "attachments",
    "customSystemPrompt",
    "projectInstructions",
  ]) {
    assert.equal(unsupported.includes(key), false, `${key} now has a kernel reader`);
  }
  assert.deepEqual(
    [...unsupported].sort(),
    [...new Set(unsupported)].sort(),
    "each gap is reported once",
  );
});

test("the model's vision capability reaches the kernel", () => {
  // Without this the kernel names an attached image in text instead of sending it,
  // which is exactly what a vision model's user would notice first.
  const seen = adaptKernelPrompt({
    ...LAUNCH,
    provider: {
      ...LAUNCH.provider,
      modelConfig: { contextWindow: 128000, supportsVision: true },
    },
  });
  assert.equal(seen.params.supportsVision, true);

  // Undeclared stays undeclared: the kernel then keeps the image as a reference
  // rather than sending a payload an endpoint might reject.
  const silent = adaptKernelPrompt({
    ...LAUNCH,
    provider: { ...LAUNCH.provider, modelConfig: { contextWindow: 128000 } },
  });
  assert.equal(silent.params.supportsVision, undefined);
});

test("every forwarded key is one the kernel actually reads", () => {
  // Pinned deliberately: adding a field to the launch path means adding it here
  // and giving the kernel a reader, in the same change.
  assert.deepEqual(
    [...FORWARDED_PROMPT_PARAMS].sort(),
    [
      "attachments",
      "commandShell",
      "compactionSettings",
      "content",
      "contextWindow",
      "customSystemPrompt",
      "delegationDefaultModel",
      "escalation",
      "mcpServerIds",
      "mcpToolNames",
      "mode",
      "modeTurn",
      "modelId",
      "pluginSkills",
      "projectInstructions",
      "projectPath",
      "sessionId",
      "skillReview",
      "smartTurn",
      "stepBudget",
      "subagentModelKeys",
      "subagentProviders",
      "subagents",
      "supportsVision",
      "systemPrompt",
      "thinkingLevel",
      "tools",
      "trustedExtensions",
      "turnId",
      "workspaceRoot",
    ].sort(),
  );
});

test("the session mode reaches the kernel instead of being reported as a gap", () => {
  // The kernel parses `mode` into its mode rules, withholds Write/Edit from its
  // own declarations when the mode cannot write, and stamps the name on every
  // `tools.execute`. Dropped, a Plan session ran as Agent with the write tools
  // still declared.
  for (const mode of ["agent", "plan", "goal"]) {
    const { params, unsupported } = adaptKernelPrompt({ ...LAUNCH, mode });
    assert.equal(params.mode, mode, `${mode} reaches the kernel under its own name`);
    assert.equal(unsupported.includes("mode"), false, `${mode} is not reported as a gap`);
  }
});

test("plugin tools and MCP tools reach the kernel as `tools` declarations", () => {
  const { params, unsupported } = adaptKernelPrompt({
    ...LAUNCH,
    tools: undefined,
    pluginTools: PLUGIN_TOOLS,
  });
  assert.equal("pluginTools" in params, false, "the kernel's name is `tools`");
  assert.equal(unsupported.includes("pluginTools"), false);
  // Exactly what the kernel's reader consumes: `name`, `description`,
  // `parameters`, `planSafeActions`, plus `mcpServerId`, which authorizes an MCP
  // selection. `risk` reaches host-core through the plugin registry that owns it,
  // so it is not part of a per-turn declaration.
  assert.deepEqual(params.tools, [
    {
      name: "plugin_demo_probe",
      description: "Probe a URL",
      parameters: { type: "object", properties: { url: { type: "string" } } },
      // Quoted back on every `tools.execute`: host-core denies a `plugin_*` call
      // in a contract mode unless the declaration lists what it may still do.
      planSafeActions: ["inspect"],
    },
    {
      name: "mcp__filesystem__read_file",
      mcpServerId: "srv-1",
      description: "Read a file through the MCP server",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  ]);
  assert.equal("risk" in params.tools[0], false, "risk belongs to the plugin registry");
});

test("a tool without plan-safe actions sends no key rather than an empty one", () => {
  // host-core reads an empty list the same way it reads a missing one, and the
  // kernel drops the key either way — sending `[]` would only describe a
  // capability that does not exist.
  const { params } = adaptKernelPrompt({
    ...LAUNCH,
    pluginTools: [
      { name: "plugin_demo_run", description: "Run", parameters: { type: "object" }, planSafeActions: [] },
      { name: "plugin_demo_bad", description: "Bad", parameters: { type: "object" }, planSafeActions: ["ok", 7] },
    ],
  });
  // LAUNCH declares `Read` first, so the plugin tools follow it.
  const byName = (name) => params.tools.find((tool) => tool.name === name);
  assert.equal("planSafeActions" in byName("plugin_demo_run"), false);
  assert.deepEqual(byName("plugin_demo_bad").planSafeActions, ["ok"], "non-string entries are dropped");
});

test("declarations keep one entry per name, host declarations first", () => {
  // The kernel's registry is keyed by name, so a duplicate installs last-wins
  // without a word. The adapter sends one entry per name instead.
  const { params } = adaptKernelPrompt({
    ...LAUNCH,
    tools: [{ name: "plugin_demo_probe", description: "host version", parameters: { type: "object" } }],
    pluginTools: PLUGIN_TOOLS,
  });
  assert.deepEqual(
    params.tools.map((tool) => tool.name),
    ["plugin_demo_probe", "mcp__filesystem__read_file"],
  );
  assert.equal(params.tools[0].description, "host version", "the host's declaration wins");

  // Nothing declared means nothing to replace: the kernel installs its built-ins.
  const nothing = adaptKernelPrompt({ ...LAUNCH, tools: undefined, pluginTools: [] });
  assert.equal("tools" in nothing.params, false);
  assert.equal(nothing.unsupported.includes("pluginTools"), false);
});

test("the parameter lists never overlap", () => {
  const forwarded = new Set(FORWARDED_PROMPT_PARAMS);
  for (const key of KNOWN_UNSUPPORTED_PROMPT_PARAMS) {
    assert.equal(forwarded.has(key), false, `${key} is both forwarded and reported as a gap`);
  }
  assert.equal(
    KNOWN_UNSUPPORTED_PROMPT_PARAMS.length,
    new Set(KNOWN_UNSUPPORTED_PROMPT_PARAMS).size,
    "a gap is listed once",
  );
  for (const [from, to] of Object.entries(RENAMED_PROMPT_PARAMS)) {
    assert.equal(forwarded.has(from), false, `${from} is mapped, not passed through`);
    assert.equal(
      KNOWN_UNSUPPORTED_PROMPT_PARAMS.includes(from),
      false,
      `${from} is renamed, not dropped`,
    );
    assert.equal(
      forwarded.has(to),
      true,
      `${to} is the kernel's side of the mapping and must be a name it reads`,
    );
  }
});

test("the staged run's context reaches the kernel instead of being dropped", () => {
  // Main claims the run turn before the prompt (mode-runs.ts) and the kernel
  // parses `modeTurn` exactly as the Node sidecar does. Without it every
  // `agent.modeTurnNotice` describes a run the kernel has never heard of, so a
  // pause is answered `{ applied: false }` for a turn that is still working.
  const { params, unsupported } = adaptKernelPrompt(LAUNCH);
  assert.deepEqual(params.modeTurn, MODE_TURN, "the claim crosses the wire unchanged");
  assert.equal(unsupported.includes("modeTurn"), false, "the kernel reads it now");
  for (const key of ["runId", "stageId", "origin", "enteredStage", "input", "artifactPaths"]) {
    assert.ok(key in params.modeTurn, `${key} survives the adapter`);
  }
});

test("a turn with no run claims none", () => {
  // An ordinary turn must not carry an empty claim: the kernel would have to
  // guess whether the turn belongs to a run.
  const { params, unsupported } = adaptKernelPrompt({ ...LAUNCH, modeTurn: undefined });
  assert.equal("modeTurn" in params, false);
  assert.equal(unsupported.includes("modeTurn"), false);
});

test("an unsupported wire refuses the turn even with a mode and tools to declare", () => {
  // A usable mode and a full tool list must not let a turn past a provider the
  // kernel cannot speak.
  assert.throws(
    () =>
      adaptKernelPrompt({
        ...LAUNCH,
        mode: "plan",
        pluginTools: PLUGIN_TOOLS,
        provider: { ...LAUNCH.provider, apiStyle: "pi_messages" },
      }),
    /provider\.apiStyle\(pi_messages\)/,
  );
});

test("an Anthropic-shaped endpoint keeps its wire", () => {
  const { provider } = adaptKernelProvider({
    ...LAUNCH.provider,
    apiStyle: "anthropic_messages",
  });
  assert.equal(provider.kind, "anthropic");
});

test("a wire the kernel does not speak is refused by name", () => {
  // `responses` left this list when the kernel learned to speak it; what remains is
  // genuinely unsupported.
  for (const apiStyle of ["openai_codex_responses", "pi_messages"]) {
    assert.throws(
      () => adaptKernelPrompt({ ...LAUNCH, provider: { ...LAUNCH.provider, apiStyle } }),
      new RegExp(`provider\\.apiStyle\\(${apiStyle}\\)`),
      `${apiStyle} must not be flattened onto Chat Completions`,
    );
  }
});

test("a provider that authenticates elsewhere needs no key", () => {
  const { provider } = adaptKernelProvider({
    ...LAUNCH.provider,
    apiKey: undefined,
    authKind: "none",
  });
  assert.equal(provider.authKind, "none");
  assert.equal("apiKey" in provider, false);
});

test("a keyless provider that does need auth is refused", () => {
  assert.throws(
    () => adaptKernelPrompt({ ...LAUNCH, provider: { ...LAUNCH.provider, apiKey: undefined } }),
    /provider\.apiKey/,
  );
  assert.throws(() => adaptKernelPrompt({ ...LAUNCH, provider: undefined }), /provider/);
});

test("a prompt without text never starts a turn", () => {
  assert.throws(() => adaptKernelPrompt({ ...LAUNCH, content: undefined }), /missing content/);
  assert.throws(() => adaptKernelPrompt({ ...LAUNCH, sessionId: "" }), /missing sessionId/);
});

test("the older text alias still reaches the model", () => {
  const { params } = adaptKernelPrompt({ ...LAUNCH, content: undefined, text: "hello" });
  assert.equal(params.content, "hello");
});

test("the user's compaction settings reach the kernel under their own name", () => {
  // The kernel reads `compactionSettings.enabled` where it decides to compact —
  // the same single field the Node runtime reads. Dropped, a user who turned
  // automatic compaction off still had the kernel summarizing their context.
  const settings = { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 };
  const { params, unsupported } = adaptKernelPrompt({ ...LAUNCH, compactionSettings: settings });
  assert.deepEqual(params.compactionSettings, settings, "the launch path's own shape crosses the wire");
  assert.equal(unsupported.includes("compactionSettings"), false, "it has a reader now");

  // Absent stays absent: the kernel then keeps its own default (compaction on),
  // rather than being handed an empty object that means nothing.
  const none = adaptKernelPrompt(LAUNCH);
  assert.equal("compactionSettings" in none.params, false);
  assert.equal(none.unsupported.includes("compactionSettings"), false);
});

/** `launch.sidecarParams.subagentProviders` / `.subagentModelKeys`. */
const SUBAGENT_MODELS = {
  subagentProviders: {
    "cheap/model-x": {
      id: "row-cheap",
      name: "Cheap",
      baseUrl: "https://cheap.example/v1",
      apiStyle: "openai-completions",
      authKind: "api_key",
      apiKey: "test-key-cheap",
      modelId: "cheap-model",
      modelConfig: { contextWindow: 32_000, maxOutputTokens: 4_096 },
    },
    // Authorized, but on a wire the kernel refuses: advertising it would fail the
    // delegate mid-turn instead of before it starts. `responses` used to stand here;
    // the kernel speaks it now, so the fixture moved to a wire it still does not.
    "pi-messages/key": {
      id: "row-pi-messages",
      name: "Pi messages",
      baseUrl: "https://pi-messages.example/v1",
      apiStyle: "pi_messages",
      authKind: "api_key",
      apiKey: "test-key-responses",
      modelId: "responses-model",
    },
    // A binding nobody opted into: not an authorization.
    "unauthorized/key": {
      id: "row-other",
      name: "Other",
      baseUrl: "https://other.example/v1",
      apiStyle: "openai-completions",
      authKind: "api_key",
      apiKey: "test-key-other",
      modelId: "not-allowed",
    },
  },
  // `unauthorized/key` has a binding but no opt-in, and `no-binding/key` an opt-in
  // with no binding: neither is a usable override.
  subagentModelKeys: ["cheap/model-x", "pi-messages/key", "no-binding/key"],
};

test("the delegation catalog reaches the kernel as a provider per key", () => {
  // `Task.model` takes one of these keys; the kernel sends that delegate's
  // request to the binding's own endpoint and model. Dropped, a user's cheaper
  // delegation model never took effect and every delegate ran on the session
  // model.
  const { params, unsupported } = adaptKernelPrompt({ ...LAUNCH, ...SUBAGENT_MODELS });
  assert.deepEqual(
    params.subagentModelKeys,
    ["cheap/model-x"],
    "only an authorized key with a binding the kernel can speak is offered",
  );
  assert.deepEqual(params.subagentProviders, {
    "cheap/model-x": {
      kind: "openai",
      baseUrl: "https://cheap.example/v1",
      apiKey: "test-key-cheap",
      name: "Cheap",
      defaultMaxTokens: 4_096,
      modelId: "cheap-model",
      // The delegate's own window, so its budget comes from the model it runs on.
      modelConfig: { contextWindow: 32_000, maxOutputTokens: 4_096 },
    },
  });
  assert.equal(unsupported.includes("subagentProviders"), false, "it has a reader now");
  assert.equal(unsupported.includes("subagentModelKeys"), false, "so does the key list");
});

test("a catalog with nothing usable sends neither key", () => {
  // The kernel reads an absent catalog as "no overrides": every delegate runs on
  // the session model, which is the behaviour before these parameters had a
  // reader. Sending empty containers would claim the user configured something.
  const { params } = adaptKernelPrompt({
    ...LAUNCH,
    subagentProviders: { "ghost/key": { ...SUBAGENT_MODELS.subagentProviders["cheap/model-x"], apiStyle: "pi_messages" } },
    subagentModelKeys: ["ghost/key"],
    subagents: [{ name: "reviewer" }],
  });
  assert.equal("subagentProviders" in params, false);
  assert.equal("subagentModelKeys" in params, false);
});

test("a delegation key list without bindings is not an override", () => {
  const { params } = adaptKernelPrompt({ ...LAUNCH, subagentProviders: {}, subagentModelKeys: ["cheap/model-x"] });
  assert.equal("subagentProviders" in params, false);
  assert.equal("subagentModelKeys" in params, false);
});
