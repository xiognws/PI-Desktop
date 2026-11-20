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
      "content",
      "contextWindow",
      "customSystemPrompt",
      "mcpServerIds",
      "mcpToolNames",
      "mode",
      "modelId",
      "pluginSkills",
      "projectInstructions",
      "projectPath",
      "sessionId",
      "skillReview",
      "stepBudget",
      "subagents",
      "supportsVision",
      "systemPrompt",
      "thinkingLevel",
      "tools",
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
  // `parameters`, plus `mcpServerId`, which authorizes an MCP selection. `risk`
  // and `planSafeActions` are host-core's knowledge of the plugin and are not
  // part of a declaration the model sees.
  assert.deepEqual(params.tools, [
    {
      name: "plugin_demo_probe",
      description: "Probe a URL",
      parameters: { type: "object", properties: { url: { type: "string" } } },
    },
    {
      name: "mcp__filesystem__read_file",
      mcpServerId: "srv-1",
      description: "Read a file through the MCP server",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  ]);
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

test("an unsupported wire refuses the turn even with a mode and tools to declare", () => {
  // A usable mode and a full tool list must not let a turn past a provider the
  // kernel cannot speak.
  assert.throws(
    () =>
      adaptKernelPrompt({
        ...LAUNCH,
        mode: "plan",
        pluginTools: PLUGIN_TOOLS,
        provider: { ...LAUNCH.provider, apiStyle: "responses" },
      }),
    /provider\.apiStyle\(responses\)/,
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
  for (const apiStyle of ["responses", "openai_codex_responses", "pi_messages"]) {
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
