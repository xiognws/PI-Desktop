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
 *   sessionId, content, turnId, mode, modeTurn
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
  // The staged mode run this turn works on (ADR mode-definitions), validated by
  // main against the run's snapshot. The kernel parses it exactly as the Node
  // sidecar does (`parseModeTurn` in `packages/agent-runtime/src/modes/mode-params.ts`:
  // the same six keys, the same bounds) and keeps the run turn, so
  // `agent.modeTurnNotice` can answer whether a pause/release applied to it.
  // Dropped, every notice reached a kernel that had never heard of the run and
  // main's pause path silently did nothing.
  "modeTurn",
  // The user's compaction settings. The kernel reads them where it decides to
  // compact (`compactionSettings.enabled`), the same single field the Node
  // runtime reads (`compactionEnabled` in `packages/agent-runtime/src/runtime.ts`:
  // the token thresholds in this shape are deliberately ignored there, because
  // they are derived from the model's window instead).
  "compactionSettings",
  // The delegation model catalog: the keys main authorized for `Task.model` and
  // the credential-bearing binding behind each. The kernel lists the keys on the
  // `Task` declaration, refuses a key outside them, and runs that delegate on the
  // binding's own provider and model. Dropped, a user's cheaper delegation model
  // never took effect and every delegate ran on the session model.
  "subagentProviders",
  "subagentModelKeys",
  // Trusted extensions enabled for this session's project, as main decided them.
  // The kernel has no JavaScript runner, so it cannot load one; what it needs is
  // the signal that there is anything to ask the host about. Without the list it
  // asked `extensions.session.describe` on every prompt — a round trip per turn
  // for every session that has no extension at all, and a 60 s stall whenever the
  // host did not answer it (which every fake host in the kernel's own tests does).
  "trustedExtensions",
] as const;

/**
 * Launch parameters this app still sends, by name, with no kernel reader.
 *
 * `mode`, `pluginTools` and `modeTurn` left this list: the kernel parses the
 * first into the turn's mode, takes the second as `tools` declarations, and the
 * third as the staged run the turn works on. `compactionSettings`,
 * `subagentProviders` and `subagentModelKeys` left it too — the kernel now reads
 * each at the point where it changes behaviour. What is left is a real parity
 * gap, reported per turn so it stays measurable.
 */
export const KNOWN_UNSUPPORTED_PROMPT_PARAMS = [
  "fastMode",
  "attachmentsDir",
  "scratchDir",
  "visualizationsDir",
  "projectMemory",
  "permissionMode",
  "streamRules",
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
 * Wires the kernel selects by `apiStyle` rather than by its own `kind` spelling —
 * each has an envelope and event vocabulary of its own.
 */
const KERNEL_WIRES_SELECTED_BY_API_STYLE: ReadonlySet<string> = new Set([
  "responses",
  "google_generative_ai",
]);

/**
 * This app's provider row as the kernel's provider spec.
 *
 * The kernel speaks four wires and refuses the rest loudly (a codex-responses or
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

  // The kernel speaks four wires: Chat Completions and Anthropic Messages are
  // selected by `kind`; Responses and Gemini are selected by `apiStyle`, because
  // they have their own envelope and event vocabulary. Everything else —
  // codex-responses, pi-messages, opencode — is refused by name rather than
  // flattened onto Chat Completions, which would send a valid credential to an
  // endpoint of a different shape and surface as an unexplained 400.
  //
  // `chat_completions` is the app's own default wire (`API_STYLES` in
  // `@pi-workspace/shared`), and `openai-completions` is the pi-runtime spelling
  // for it; both name the wire the kernel implements as `openai`. Reading only the
  // second spelling rejected every provider a user had not re-styled by hand —
  // with `KERNEL_PROMPT_INVALID`, before the turn could start.
  const apiStyle = str(raw.apiStyle);
  // `kind` wins over `apiStyle` inside the kernel, so a style-selected wire
  // carries none: sending both would select Chat Completions while the row asked
  // for something else.
  const styleSelectedWire =
    apiStyle !== undefined && KERNEL_WIRES_SELECTED_BY_API_STYLE.has(apiStyle);
  const kind = styleSelectedWire
    ? undefined
    : apiStyle === "anthropic_messages"
      ? "anthropic"
      : apiStyle === undefined ||
          apiStyle === "chat_completions" ||
          apiStyle === "openai-completions"
        ? "openai"
        : undefined;
  if (!kind && !styleSelectedWire) return { unsupported: `provider.apiStyle(${apiStyle})` };

  const authless = str(raw.authKind) === "none";
  const apiKey = str(raw.apiKey) ?? (authless ? "" : undefined);
  if (apiKey === undefined) return { unsupported: "provider.apiKey" };

  const modelConfig = isWire(raw.modelConfig) ? raw.modelConfig : undefined;
  const defaultMaxTokens =
    typeof modelConfig?.maxOutputTokens === "number" ? modelConfig.maxOutputTokens : undefined;

  return {
    provider: {
      ...(kind ? { kind } : {}),
      ...(styleSelectedWire ? { apiStyle } : {}),
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
 * `tool_spec_from_value` keeps `name`, `description`, `parameters`,
 * `planSafeActions`, and `McpToolIdentity::from_value` needs `mcpServerId` to
 * authorize a `mcpServerIds` / `mcpToolNames` selection.
 *
 * `planSafeActions` is carried even though the model never reads it: the kernel
 * quotes it back on every `tools.execute`, and host-core denies a `plugin_*` call
 * in a contract mode (Plan, Goal) unless the declaration lists the actions it may
 * still perform (`permissions.rs`). Dropped, every plugin tool is refused in Plan
 * mode with a reason that points at the plugin rather than at this adapter.
 * `risk` still stays out — it reaches host-core through the plugin registry, which
 * owns it, not through a per-turn declaration.
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
    // Non-empty or absent, never an empty list: host-core reads an empty list the
    // same way it reads a missing one, and the kernel drops the key either way.
    const planSafeActions = Array.isArray(entry.planSafeActions)
      ? entry.planSafeActions.filter((action): action is string => typeof action === "string")
      : [];
    declarations.push({
      name,
      description: str(entry.description) ?? "",
      // The kernel defaults a missing schema to `{type: "object"}`; an entry with
      // no parameters keeps that default instead of inventing a shape.
      parameters: isWire(entry.parameters) ? entry.parameters : { type: "object" },
      ...(mcpServerId ? { mcpServerId } : {}),
      ...(planSafeActions.length > 0 ? { planSafeActions } : {}),
    });
  }
  return declarations.length > 0 ? declarations : undefined;
}

/**
 * The delegation model catalog as the kernel reads it.
 *
 * `subagentModelKeys` names the models the user authorized for delegation and
 * `subagentProviders` carries this app's provider row behind each key. The kernel
 * builds one provider per entry and sends that delegate's request to it, along
 * with the binding's own `modelId`, so only keys whose entry it can actually
 * speak are forwarded: an entry on a wire the kernel refuses (Responses,
 * pi-messages) is dropped here rather than advertised and then failing the
 * delegate mid-turn. A key with no entry behind it is dropped for the same
 * reason — the kernel would have nothing to send to.
 *
 * Returns `undefined` when nothing survived, which leaves both keys off the wire:
 * the kernel then reports no catalog and every delegate runs on the session model,
 * exactly the behaviour before these parameters had a reader.
 */
function delegationModels(raw: Wire): { providers: Wire; keys: string[] } | undefined {
  const entries = isWire(raw.subagentProviders) ? raw.subagentProviders : undefined;
  const declared = Array.isArray(raw.subagentModelKeys)
    ? raw.subagentModelKeys.filter((key): key is string => typeof key === "string")
    : [];
  if (!entries || declared.length === 0) return undefined;

  const providers: Wire = {};
  const keys: string[] = [];
  for (const key of new Set(declared)) {
    const entry = entries[key];
    if (!isWire(entry)) continue;
    const adapted = adaptKernelProvider(entry);
    if (!adapted.provider) continue;
    // The model this key stands for. Without it the kernel has a provider and no
    // model to ask for, which is not an override.
    const modelId = str(entry.modelId);
    if (!modelId) continue;
    keys.push(key);
    providers[key] = {
      ...adapted.provider,
      modelId,
      // The delegate's own window, so its context budget is derived from the
      // model it actually runs on rather than from the parent's.
      ...(isWire(entry.modelConfig) ? { modelConfig: entry.modelConfig } : {}),
    };
  }
  return keys.length > 0 ? { providers, keys } : undefined;
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

  // The delegation catalog goes on the wire under the launch path's own names, but
  // each entry is the kernel's provider spec: it builds a provider per key. Placed
  // after the forwarding loop, which would otherwise pass the app's raw provider
  // rows through — and a catalog nothing usable survives in is withheld entirely
  // rather than sent as an empty container.
  const delegation = delegationModels(raw);

  for (const key of FORWARDED_PROMPT_PARAMS) {
    if (key in params || raw[key] === undefined) continue;
    params[key] = raw[key];
  }

  delete params.subagentProviders;
  delete params.subagentModelKeys;
  if (delegation) {
    params.subagentProviders = delegation.providers;
    params.subagentModelKeys = delegation.keys;
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
