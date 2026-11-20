import assert from "node:assert/strict";
import test from "node:test";

const {
  FORWARDED_PROMPT_PARAMS,
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
    "mode",
    "customSystemPrompt",
    "projectInstructions",
    "projectMemory",
    "attachmentsDir",
    "scratchDir",
  ]) {
    assert.ok(unsupported.includes(key), `${key} is reported as unsupported`);
  }
  for (const key of ["thinkingLevel", "commandShell", "attachments"]) {
    assert.equal(unsupported.includes(key), false, `${key} now has a kernel reader`);
  }
  assert.deepEqual(
    [...unsupported].sort(),
    [...new Set(unsupported)].sort(),
    "each gap is reported once",
  );
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
      "mcpServerIds",
      "mcpToolNames",
      "modelId",
      "pluginSkills",
      "projectPath",
      "sessionId",
      "skillReview",
      "stepBudget",
      "subagents",
      "systemPrompt",
      "thinkingLevel",
      "tools",
      "turnId",
      "workspaceRoot",
    ].sort(),
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
