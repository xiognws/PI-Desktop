/**
 * Translate one prompt from this app's launch parameters into the kernel's
 * `agent.prompt` parameters.
 *
 * The Node sidecar was handed everything and decided for itself what mattered.
 * The Rust kernel reads a smaller, explicitly named parameter set, so this module
 * is the mapping table between the two. It never guesses: every key it does not
 * forward is listed in `unsupported` so a gap shows up as data — a report, a log
 * line — instead of a silently narrower turn.
 *
 * Kernel side (verified against `crates/agent-core/src/sidecar.rs` + `src/prompt`):
 *   sessionId, content, turnId
 *   modelId | provider.modelId
 *   provider {kind|apiStyle, baseUrl, apiKey, name, headers, authKind, defaultMaxTokens}
 *   systemPrompt, tools, pluginSkills, subagents, skillReview
 *   mcpServerIds, mcpToolNames, contextWindow, stepBudget
 *   workspaceRoot, projectPath
 */

type Wire = Record<string, unknown>;

const isWire = (value: unknown): value is Wire =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/**
 * Parameter names this adapter forwards, and the only ones it will forward.
 *
 * Keeping the list explicit is the point: a new field on the launch path has to
 * be added here (with a kernel-side reader or a mapping rule) before it reaches
 * the model, and the test that pins the list fails until it is.
 */
export const FORWARDED_PROMPT_PARAMS = [
  "sessionId",
  "content",
  "turnId",
  "modelId",
  "systemPrompt",
  "tools",
  "pluginSkills",
  "subagents",
  "skillReview",
  "mcpServerIds",
  "mcpToolNames",
  "contextWindow",
  "stepBudget",
  "workspaceRoot",
  "projectPath",
  // The kernel reads both of these on `agent.prompt` (prompt value first, then
  // the configured value) — reasoning level and the command shell identity the
  // Bash tool hands to `tools.execute`.
  "thinkingLevel",
  "commandShell",
] as const;

/** Launch parameters this app still sends that the kernel has no reader for. */
export const KNOWN_UNSUPPORTED_PROMPT_PARAMS = [
  "mode",
  "modeTurn",
  "fastMode",
  "attachments",
  "attachmentsDir",
  "scratchDir",
  "visualizationsDir",
  "compactionSettings",
  "customSystemPrompt",
  "projectInstructions",
  "projectMemory",
  "pluginTools",
  "permissionMode",
  "streamRules",
  "subagentProviders",
  "subagentModelKeys",
  "trustedExtensions",
  "remoteWorkspace",
  "infiniteProviderRetry",
  "sessionMessage",
  "packages",
  "jevApiKey",
] as const;

/**
 * This app's provider row as the kernel's provider spec.
 *
 * The kernel speaks two wires and refuses the rest loudly (a Responses-shaped or
 * pi-messages credential sent to a Chat Completions endpoint fails as an
 * unexplained 400). Endpoints the kernel cannot speak are reported instead of
 * being flattened onto OpenAI completions.
 */
export function adaptKernelProvider(raw: unknown): {
  provider?: Wire;
  unsupported?: string;
} {
  if (!isWire(raw)) return { unsupported: "provider" };
  const baseUrl = str(raw.baseUrl);
  if (!baseUrl) return { unsupported: "provider.baseUrl" };

  // The kernel speaks exactly two wires. Everything else — Responses,
  // codex-responses, pi-messages — is refused by name rather than flattened onto
  // Chat Completions, which would send a valid credential to an endpoint of a
  // different shape and surface as an unexplained 400.
  const apiStyle = str(raw.apiStyle);
  const kind =
    apiStyle === "anthropic_messages"
      ? "anthropic"
      : apiStyle === undefined || apiStyle === "openai-completions"
        ? "openai"
        : undefined;
  if (!kind) return { unsupported: `provider.apiStyle(${apiStyle})` };

  const authless = str(raw.authKind) === "none";
  const apiKey = str(raw.apiKey) ?? (authless ? "" : undefined);
  if (apiKey === undefined) return { unsupported: "provider.apiKey" };

  const modelConfig = isWire(raw.modelConfig) ? raw.modelConfig : undefined;
  const defaultMaxTokens =
    typeof modelConfig?.maxOutputTokens === "number" ? modelConfig.maxOutputTokens : undefined;

  return {
    provider: {
      kind,
      baseUrl,
      ...(apiKey === "" ? {} : { apiKey }),
      ...(str(raw.name) ? { name: str(raw.name) } : {}),
      ...(authless ? { authKind: "none" } : {}),
      ...(isWire(raw.headers) ? { headers: raw.headers } : {}),
      ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
    },
  };
}

function contextWindowOf(provider: unknown): number | undefined {
  if (!isWire(provider)) return undefined;
  const modelConfig = isWire(provider.modelConfig) ? provider.modelConfig : undefined;
  const value = modelConfig?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * One launch-payload prompt as kernel parameters.
 *
 * `params.unsupported` lists what was dropped, so the caller can log it once per
 * turn and the parity gap stays measurable. A prompt without content, or whose
 * provider the kernel cannot speak, throws: a turn that would run without the
 * user's text or without a usable endpoint must not start.
 */
export function adaptKernelPrompt(raw: unknown): {
  params: Wire;
  unsupported: string[];
} {
  if (!isWire(raw)) throw new Error("prompt parameters must be an object");
  const sessionId = str(raw.sessionId);
  if (!sessionId) throw new Error("prompt is missing sessionId");
  const content = str(raw.content) ?? str(raw.text) ?? str(raw.prompt);
  if (content === undefined) throw new Error("prompt is missing content");

  const unsupported: string[] = [];
  const providerInput = isWire(raw.provider) ? raw.provider : undefined;
  const provider = adaptKernelProvider(providerInput);
  if (provider.unsupported) {
    // No usable endpoint means no turn; failing here is better than a provider
    // 400 several seconds later.
    throw new Error(`prompt provider is not usable by the kernel: ${provider.unsupported}`);
  }

  const params: Wire = { sessionId, content };
  const turnId = str(raw.turnId);
  if (turnId) params.turnId = turnId;

  const modelId = str(raw.modelId) ?? str(providerInput?.modelId);
  if (modelId) params.modelId = modelId;

  for (const key of FORWARDED_PROMPT_PARAMS) {
    if (key in params || raw[key] === undefined) continue;
    params[key] = raw[key];
  }

  // Context window: this app keeps it on the provider row's model config; the
  // kernel reads it as a flat number.
  const contextWindow = contextWindowOf(providerInput);
  if (contextWindow !== undefined && params.contextWindow === undefined) {
    params.contextWindow = contextWindow;
  }
  if (provider.provider) params.provider = provider.provider;

  const known = new Set<string>([...FORWARDED_PROMPT_PARAMS, "provider", "text", "prompt"]);
  for (const key of Object.keys(raw)) {
    if (known.has(key)) continue;
    if (key in params) continue;
    unsupported.push(key);
  }

  return { params, unsupported };
}
