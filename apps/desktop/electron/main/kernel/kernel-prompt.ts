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
 *   sessionId, content, turnId, mode
 *   modelId | provider.modelId
 *   provider {kind|apiStyle, baseUrl, apiKey, name, headers, authKind, defaultMaxTokens}
 *   systemPrompt, tools, pluginSkills, subagents, skillReview
 *   mcpServerIds, mcpToolNames, contextWindow, stepBudget
 *   workspaceRoot, projectPath
 *
 * One launch parameter does not keep its name: `pluginTools` reaches the kernel
 * as `tools`, because the kernel reads a single declaration array for both plugin
 * agent tools and the user's MCP tools. See `RENAMED_PROMPT_PARAMS`.
 */

type Wire = Record<string, unknown>;

const isWire = (value: unknown): value is Wire =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/**
 * Parameter names this adapter forwards verbatim, and the only ones it will.
 *
 * Keeping the list explicit is the point: a new field on the launch path has to
 * be added here (with a kernel-side reader or a mapping rule) before it reaches
 * the model, and the test that pins the list fails until it is. Keys the kernel
 * reads under another name belong in `RENAMED_PROMPT_PARAMS` instead.
 */
export const FORWARDED_PROMPT_PARAMS = [
  "sessionId",
  "content",
  "turnId",
  // `mode` decides the shape of the turn: the kernel parses it into Plan / Agent
  // / Goal (an unknown name becomes a read-only mode), composes that mode's rules
  // into the system prompt, withholds Write/Edit from its own declarations when
  // the mode cannot write, and stamps the same name on every `tools.execute` the
  // turn makes. Dropped, a Plan session ran as Agent with the write tools still
  // declared.
  "mode",
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
  // Attachment payloads: an image becomes a `ContentPart::Image` the provider can
  // send, and the reference kinds become text blocks, so nothing the user attached
  // is dropped.
  "attachments",
  // Whether the model can see, derived from the provider's model config: the kernel
  // inlines an attached image only when told, otherwise it names it in text.
  "supportsVision",
  // Resolved prompt inputs. The host reads the files and applies the byte caps, so
  // the kernel receives the finished text and must not re-read the workspace.
  "customSystemPrompt",
  "projectInstructions",
] as const;

/**
 * Launch parameters this app still sends, by name, with no kernel reader.
 *
 * `mode` and `pluginTools` left this list: the kernel parses the first into the
 * turn's mode and takes the second as `tools` declarations. What is left is a
 * real parity gap, reported per turn so it stays measurable.
 */
export const KNOWN_UNSUPPORTED_PROMPT_PARAMS = [
  "modeTurn",
  "fastMode",
  "attachmentsDir",
  "scratchDir",
  "visualizationsDir",
  "compactionSettings",
  "projectMemory",
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
 * Launch parameters the kernel reads under a different name.
 *
 * A renamed key is forwarded — just not verbatim — so it belongs in neither list
 * above: listing it as forwarded would put this app's name on the kernel's wire,
 * and listing it as dropped would be a lie. The value is mapped by
 * `adaptKernelPrompt`, and the mapping is the only place the name changes.
 */
export const RENAMED_PROMPT_PARAMS: Readonly<Record<string, string>> = {
  pluginTools: "tools",
};

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

function visionOf(provider: unknown): boolean | undefined {
  if (!isWire(provider)) return undefined;
  const modelConfig = isWire(provider.modelConfig) ? provider.modelConfig : undefined;
  const value = modelConfig?.supportsVision;
  return typeof value === "boolean" ? value : undefined;
}

function contextWindowOf(provider: unknown): number | undefined {
  if (!isWire(provider)) return undefined;
  const modelConfig = isWire(provider.modelConfig) ? provider.modelConfig : undefined;
  const value = modelConfig?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `pluginTools` entries as the kernel's `tools` declarations.
 *
 * The launch list mixes plugin agent tools with the user's MCP tools, and the
 * kernel reads both from one array: `install_tools` in
 * `crates/agent-core/src/sidecar.rs` installs every entry as a host-executed
 * tool. Only the fields its reader consumes are carried over —
 * `tool_spec_from_value` keeps `name`, `description` and `parameters`, and
 * `McpToolIdentity::from_value` needs `mcpServerId` to authorize an
 * `mcpServerIds` / `mcpToolNames` selection. `risk` and `planSafeActions`
 * describe the plugin to host-core, not the model, and a kernel declaration has
 * nowhere to put them: forwarding them would look like support that does not
 * exist, so they stay out.
 */
function declarationsFromPluginTools(raw: unknown): Wire[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const declarations: Wire[] = [];
  for (const entry of raw) {
    if (!isWire(entry)) continue;
    const name = str(entry.name);
    // A declaration the model cannot name is not a tool, and the kernel refuses
    // the whole prompt over it — with a message about the declaration, not about
    // the plugin that produced it.
    if (!name) continue;
    const mcpServerId = str(entry.mcpServerId);
    declarations.push({
      name,
      description: str(entry.description) ?? "",
      // The kernel defaults a missing schema to `{type: "object"}`; an entry with
      // no parameters keeps that default instead of inventing a shape.
      parameters: isWire(entry.parameters) ? entry.parameters : { type: "object" },
      ...(mcpServerId ? { mcpServerId } : {}),
    });
  }
  return declarations.length > 0 ? declarations : undefined;
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

  // `pluginTools` is the one renamed parameter: the launch path names the list
  // after where the tools come from, the kernel after what it does with them. A
  // turn with no declaration at all still installs the kernel's built-in set, so
  // an empty list is nothing to send.
  const pluginTools = declarationsFromPluginTools(raw.pluginTools);
  if (pluginTools) {
    const declared: unknown[] = Array.isArray(params.tools) ? params.tools : [];
    // One declaration per name. The kernel's registry is keyed by name, so a
    // duplicate installs last-wins in silence; a host declaration that is already
    // there keeps its place, which is the same precedence the kernel applies
    // between a host declaration and its own built-in of that name.
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const entry of [...declared, ...pluginTools]) {
      const name = isWire(entry) ? str(entry.name) : undefined;
      if (name === undefined) {
        // Not ours to interpret: anything unnamed goes through untouched and the
        // kernel rejects it by name, which is the error that says what is wrong.
        merged.push(entry);
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      merged.push(entry);
    }
    params.tools = merged;
  }

  // Context window: this app keeps it on the provider row's model config; the
  // kernel reads it as a flat number.
  const contextWindow = contextWindowOf(providerInput);
  if (contextWindow !== undefined && params.contextWindow === undefined) {
    params.contextWindow = contextWindow;
  }
  // Whether the model can see. The kernel inlines an attached image only when it is
  // told the model accepts one; without this the picture is named in text instead of
  // being sent, which is what a vision model's user would notice first.
  const supportsVision = visionOf(providerInput);
  if (supportsVision !== undefined && params.supportsVision === undefined) {
    params.supportsVision = supportsVision;
  }
  if (provider.provider) params.provider = provider.provider;

  const known = new Set<string>([
    ...FORWARDED_PROMPT_PARAMS,
    ...Object.keys(RENAMED_PROMPT_PARAMS),
    "provider",
    "text",
    "prompt",
  ]);
  for (const key of Object.keys(raw)) {
    if (known.has(key)) continue;
    if (key in params) continue;
    unsupported.push(key);
  }

  return { params, unsupported };
}
