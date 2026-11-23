/**
 * Agent extension bridge for Electron main (D387/D388, ADR 0214,
 * spec 07-plugins/16 §9 to §11).
 *
 * ExtensionAPI modules are contributed by plugins (`contributes.agentExtensions`)
 * and run inside the agent sidecar while the Node runtime answers turns. This
 * bridge holds what that runtime reports back per session (registered commands,
 * load reports, diagnostics) and brokers the modal prompts between it and the
 * renderer. Discovery and enablement are the plugin system's job. Import
 * generation stays here, while dependency installation lives in the dedicated
 * npm installer so its trust boundary and lifecycle can be tested independently.
 *
 * A command has no such luxury under the Rust kernel: an extension is
 * JavaScript, the kernel has no JS runner and should not grow one, so
 * {@link AgentExtensionBridge.runCommand} runs the command here, from the same
 * trust set the sidecar load would have used. Both hosts run the same modules
 * through the same `TrustedExtensionRunner`, so a command's contract — the
 * `{ handled }` answer, what a missing command does, how a throwing handler is
 * recorded — does not depend on which runtime answers turns.
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extensionToastText } from "./extension-toast-policy";
import {
  createExtensionModelRegistry,
  findRegisteredAgentModel,
} from "./extension-model-registry";
import { extensionMessageText } from "./extension-session-host";
import { assertImportedPackagePath, discoverImportedPackageSkills } from "./imported-package-skills";
import {
  IMPORTED_PLUGIN_ID_PREFIX,
  IMPORTED_PLUGIN_MAIN,
  IMPORTED_PLUGIN_WRAPPER_SOURCE,
} from "./imported-plugin-wrapper";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import {
  discoverManualPath,
  type RegisteredTrustedExtensionAgent,
  type TrustedExtensionBridge,
  type TrustedExtensionEventName,
} from "@pi-workspace/agent-runtime";
export { defaultDependencyRunner, installExtensionDependencies } from "./npm-installer";
export type { DependencyCommandRunner, ExtensionDependencyInstallResult } from "./npm-installer";
import {
  ErrorCodes,
  TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS,
  type PluginAgentExtensionStatus,
  type TrustedExtensionCommand,
  type TrustedExtensionDiagnostic,
  type TrustedExtensionLoadReport,
  type TrustedExtensionSpec,
  type TrustedExtensionStatusEvent,
  type TrustedExtensionUiPrompt,
  type TrustedExtensionUiRequestEnvelope,
  type TrustedExtensionUiResponse,
} from "@pi-workspace/shared";

type SessionState = {
  commands: TrustedExtensionCommand[];
  diagnostics: TrustedExtensionDiagnostic[];
  reports: TrustedExtensionLoadReport[];
};

type PendingPrompt = {
  prompt: TrustedExtensionUiPrompt;
  sessionId: string;
  kind: "confirm" | "select" | "input";
  resolve: (response: TrustedExtensionUiResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type AgentExtensionBridgeOptions = {
  /** Renderer notifications. `hasRenderer` false means prompts fail closed (spec §9). */
  hasRenderer: () => boolean;
  onChanged: () => void;
  onPrompt: (prompt: TrustedExtensionUiPrompt) => void;
  onToast: (message: string, level: "info" | "warning" | "error") => void;
  onStatus: (event: TrustedExtensionStatusEvent) => void;
  promptTimeoutMs?: number;
  /** Overrides the Runner built for {@link AgentExtensionBridge.runCommand}. */
  runnerFactory?: ExtensionCommandRunnerFactory;
  /**
   * Host-owned session services for a command's turn half. Main supplies them
   * once the host and Agent Host exist ({@link AgentExtensionBridge.setSessionHost}).
   */
  sessionHost?: AgentExtensionSessionHost;
};

/**
 * One plugin agent's transport, when the host has to serve it for a runtime that
 * cannot run JavaScript (`plugin-agent-transport.ts`).
 *
 * `model` is the model the plugin declared: its callback owns request
 * serialisation, so it receives its own metadata rather than the host's.
 */
export type ExtensionAgentTransport = {
  providerId: string;
  model: Model<Api>;
  stream(context: Context, options: { signal?: AbortSignal }): AssistantMessageEventStream;
};

/**
 * The slice of `TrustedExtensionRunner` main needs while it is the only
 * JavaScript host a session has: run one command, answer one hook, run one
 * extension tool, and name the plugin agents the modules registered.
 *
 * Everything past `dispose` is optional so a test double can stand in for the
 * shipped Runner; a member that is absent means "this session has no handler
 * for it", which is exactly what an empty extension set behaves like.
 */
export type ExtensionCommandRunner = {
  load(): Promise<unknown>;
  runCommand(name: string, args: string): Promise<boolean>;
  dispose(): Promise<void>;
  /** Load reports, published beside diagnostics the way the sidecar does. */
  getLoadReports?(): TrustedExtensionLoadReport[];
  /** Tools the loaded modules registered (`TrustedExtensionRunner.getAgentTools`). */
  getAgentTools?(): AgentTool[];
  /** Plugin agents the loaded modules registered, for the registry and transport. */
  getAgents?(): RegisteredTrustedExtensionAgent[];
  /** One hook event, folded by the runner the way the Node runtime folds it. */
  emit?<R = unknown>(
    event: TrustedExtensionEventName,
    payload: Record<string, unknown>,
    fold?: (acc: R | undefined, next: R) => R,
  ): Promise<R | undefined>;
  emitBeforeAgentStart?(prompt: string, systemPrompt: string): Promise<string | undefined>;
  emitBeforeProviderRequest?(payload: unknown): Promise<unknown>;
};

/**
 * A session's own model binding, as the extension surface sees it.
 *
 * Read off the session row, so it can only ever name ids: never a provider's
 * endpoint, headers, or secret.
 */
export type ExtensionSessionBinding = {
  providerId: string;
  modelId: string;
  mode?: string;
  thinkingLevel?: string;
  title?: string;
  /** Project root, or the session's scratch directory — what `ctx.cwd` means here. */
  projectPath?: string;
};

export type ExtensionSessionConfigureInput = {
  sessionId: string;
  mode: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: string;
};

/**
 * The host-owned session services a main-run command reaches (spec §5, §8).
 *
 * Supplied by Electron main from the host RPC and the Agent Host — the same
 * services the Node sidecar's extension bridge calls — so `setSessionName`,
 * `sendUserMessage` and `setModel` mean one thing under either runtime. Absent,
 * those members refuse with a diagnostic instead of pretending to work.
 */
export type AgentExtensionSessionHost = {
  sessionBinding(sessionId: string): Promise<ExtensionSessionBinding | undefined>;
  configureModel(
    input: ExtensionSessionConfigureInput,
  ): Promise<{ ok: boolean; session: ExtensionSessionBinding | null }>;
  renameSession(input: { sessionId: string; title: string }): Promise<void>;
  queueUserMessage(input: {
    sessionId: string;
    content: string;
    idempotencyKey?: string;
  }): Promise<{ id?: string }>;
  prioritizeQueuedMessage(id: string): Promise<void>;
  /** `setModel` is idle-only, exactly as it is in the Node runtime. */
  isSessionIdle(sessionId: string): boolean;
};

/** One extension-registered agent tool, as the kernel needs to declare it. */
export type ExtensionToolSpec = {
  name: string;
  description: string;
  parameters: unknown;
};

/**
 * What one session's extensions registered, for a host that must declare their
 * tools before the model can ask for one.
 */
export type ExtensionSessionDescription = {
  /** Events with at least one handler, so the kernel can skip the rest. */
  events: string[];
  tools: ExtensionToolSpec[];
};

export type ExtensionCommandRunnerFactory = (options: {
  specs: TrustedExtensionSpec[];
  bridge: TrustedExtensionBridge;
}) => ExtensionCommandRunner | Promise<ExtensionCommandRunner>;

/**
 * The shipped Runner, loaded on first use.
 *
 * The dynamic import is the point: the loader it reaches pulls `jiti`, and main
 * must not pay for that on the startup path. Only a command with no other JS
 * host — a Rust-kernel session — ever asks for it.
 */
async function loadTrustedExtensionRunner(options: {
  specs: TrustedExtensionSpec[];
  bridge: TrustedExtensionBridge;
}): Promise<ExtensionCommandRunner> {
  const { TrustedExtensionRunner } = await import("@pi-workspace/agent-runtime");
  return new TrustedExtensionRunner(options);
}

function dismissedResponse(kind: PendingPrompt["kind"]): TrustedExtensionUiResponse {
  return kind === "confirm" ? { kind, value: false, cancelled: true } : { kind, value: undefined, cancelled: true };
}

export class AgentExtensionBridge {
  private readonly options: AgentExtensionBridgeOptions;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pending = new Map<string, PendingPrompt>();
  /** One interactive prompt per session at a time (spec §9). */
  private readonly promptQueues = new Map<string, Promise<unknown>>();
  private readonly uiRequests = new Map<string, { sessionId: string; controller: AbortController }>();
  /** One JavaScript Runner per session, but only for sessions main must run itself. */
  private readonly commandRunners = new Map<string, { key: string; ready: Promise<ExtensionCommandRunner> }>();
  /** Last name a command gave each session, until the next host read replaces it. */
  private readonly sessionNames = new Map<string, string>();
  private sessionHost?: AgentExtensionSessionHost;

  constructor(options: AgentExtensionBridgeOptions) {
    this.options = options;
    this.sessionHost = options.sessionHost;
  }

  /**
   * Wire the host-owned session services after the host exists.
   *
   * `main/index.ts` builds this bridge before host-core and the Agent Host have
   * started, so the services arrive once and are cached here. Without them a
   * command's turn half (`setModel`, `setSessionName`, `sendUserMessage`)
   * refuses with a diagnostic instead of pretending to have run.
   */
  setSessionHost(host: AgentExtensionSessionHost): void {
    this.sessionHost = host;
  }

  // --- sidecar publications ---------------------------------------------------

  publishCommands(sessionId: string, commands: TrustedExtensionCommand[]): void {
    this.session(sessionId).commands = commands;
    this.options.onChanged();
  }

  publishDiagnostics(
    sessionId: string,
    diagnostics: TrustedExtensionDiagnostic[],
    reports: TrustedExtensionLoadReport[],
  ): void {
    const state = this.session(sessionId);
    state.diagnostics = diagnostics;
    if (reports.length) state.reports = reports;
    this.options.onChanged();
  }

  /** Commands registered by any live session, deduplicated by name. */
  allCommands(): TrustedExtensionCommand[] {
    const byName = new Map<string, TrustedExtensionCommand>();
    for (const state of this.sessions.values()) {
      for (const command of state.commands) {
        if (!byName.has(command.name)) byName.set(command.name, command);
      }
    }
    return [...byName.values()];
  }

  commandsForSession(sessionId: string): TrustedExtensionCommand[] {
    return this.sessions.get(sessionId)?.commands ?? [];
  }

  // --- commands run by main ---------------------------------------------------

  /**
   * Run a trusted extension's slash command in this process.
   *
   * The caller passes the specs: main keeps the trust decision — enabled plugins
   * holding `agent.extension`, scoped to the session's project — beside the
   * plugin registry that makes it, exactly where it builds the sidecar's
   * `trustedExtensions`. This method only loads and runs what it is handed, so
   * the trust set cannot drift between the two hosts.
   *
   * Answers `{ handled: false }` for a command no loaded extension registered,
   * which the IPC layer reports as `NOT_FOUND` — the same answer the sidecar
   * runner gives. A handler that throws is a diagnostic, not a failure of the
   * call: the command ran, and the row shows what it reported.
   */
  async runCommand(input: {
    sessionId: string;
    name: string;
    args?: string;
    specs: TrustedExtensionSpec[];
  }): Promise<{ handled: boolean }> {
    const sessionId = String(input?.sessionId ?? "").trim();
    const name = String(input?.name ?? "").trim().replace(/^\//, "");
    if (!sessionId || !name) {
      throw Object.assign(new Error("session and command name required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const specs = input.specs ?? [];
    if (specs.length === 0) {
      // Nothing is trusted for this session any more: a runner from an earlier
      // trusted set must not stay loaded, or disabling a plugin would not stop
      // its commands in a session that had already run one.
      this.disposeSessionRunner(sessionId);
      return { handled: false };
    }
    const runner = await this.sessionRunner(sessionId, specs);
    return { handled: await runner.runCommand(name, String(input.args ?? "")) };
  }

  clearSession(sessionId: string): void {
    this.cancelPrompts(sessionId);
    this.disposeSessionRunner(sessionId);
    if (this.sessions.delete(sessionId)) this.options.onChanged();
  }

  // --- hooks and tools run by main --------------------------------------------

  /**
   * What this session's extensions registered.
   *
   * Loading the modules here is what fires `session_start`, at the same point in
   * the turn the Node runtime loads its Runner — before the first
   * `before_agent_start` and before any request. The answer is the two things a
   * host without a JavaScript runner cannot work out for itself: which hook
   * events have handlers, and which agent tools the modules declared.
   *
   * An empty trusted set answers empty and loads nothing: a session with no
   * extension must not pay for a loader, and nothing may be cached from a set
   * the user has since disabled.
   */
  async describe(input: {
    sessionId: string;
    specs: TrustedExtensionSpec[];
  }): Promise<ExtensionSessionDescription> {
    const sessionId = String(input?.sessionId ?? "").trim();
    const specs = input?.specs ?? [];
    if (!sessionId || specs.length === 0) return { events: [], tools: [] };
    const runner = await this.sessionRunner(sessionId, specs);
    const events = new Set<string>();
    for (const report of runner.getLoadReports?.() ?? []) {
      for (const event of report.eventNames ?? []) events.add(event);
    }
    const tools = (runner.getAgentTools?.() ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    }));
    return { events: [...events].sort(), tools };
  }

  /**
   * Run one hook event through the session's Runner.
   *
   * The folds below are the ones `packages/agent-runtime/src/runtime.ts` uses at
   * each emission site, copied rather than re-invented: a hook that chains
   * (`before_agent_start`, `before_provider_request`) sees the previous handler's
   * answer, and a hook that accumulates (`tool_call`, `tool_result`) keeps what
   * earlier handlers said. `runner.emit` already isolates a result event's payload
   * per handler and records a throwing or stalled handler as a diagnostic.
   */
  async emitHook(input: {
    sessionId: string;
    specs: TrustedExtensionSpec[];
    event: string;
    payload: Record<string, unknown>;
  }): Promise<{ result: unknown }> {
    const sessionId = String(input?.sessionId ?? "").trim();
    const specs = input?.specs ?? [];
    const payload = input?.payload ?? {};
    if (!sessionId || specs.length === 0) return { result: null };
    const runner = await this.sessionRunner(sessionId, specs);
    switch (input.event) {
      case "before_agent_start": {
        const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
        const systemPrompt = typeof payload.systemPrompt === "string" ? payload.systemPrompt : "";
        const replaced = await runner.emitBeforeAgentStart?.(prompt, systemPrompt);
        return { result: typeof replaced === "string" ? { systemPrompt: replaced } : null };
      }
      case "before_provider_request": {
        const replaced = await runner.emitBeforeProviderRequest?.(payload.payload);
        return { result: replaced === undefined ? null : replaced };
      }
      case "before_provider_headers": {
        // Handlers edit the headers object in place, as they do in the pi CLI.
        const headers: Record<string, string> = {};
        const source = payload.headers;
        if (source && typeof source === "object" && !Array.isArray(source)) {
          for (const [name, value] of Object.entries(source)) {
            if (typeof value === "string") headers[name] = value;
          }
        }
        await runner.emit?.("before_provider_headers", { type: "before_provider_headers", headers });
        return { result: { headers } };
      }
      case "context": {
        const result = await runner.emit?.<{ messages?: unknown }>(
          "context",
          payload,
          (_acc, next) => next,
        );
        return { result: result && typeof result === "object" ? result : null };
      }
      case "tool_call": {
        const result = await runner.emit?.<{ block?: boolean; reason?: string }>(
          "tool_call",
          payload,
          (acc, next) => (acc?.block ? acc : next),
        );
        return { result: result ?? null };
      }
      case "tool_result": {
        const result = await runner.emit?.<Record<string, unknown>>(
          "tool_result",
          payload,
          (acc, next) => ({ ...(acc ?? {}), ...next }),
        );
        return { result: result ?? null };
      }
      default: {
        await runner.emit?.(input.event as TrustedExtensionEventName, payload);
        return { result: null };
      }
    }
  }

  /**
   * Run one extension-registered agent tool.
   *
   * The declaration reached the kernel from {@link describe}; the call comes back
   * here because the module that implements it runs in this process. A model that
   * calls a name no loaded module registered gets an error result rather than a
   * silent success — the kernel would otherwise record "ok" for work nobody did.
   */
  async executeExtensionTool(input: {
    sessionId: string;
    specs: TrustedExtensionSpec[];
    toolName: string;
    toolCallId: string;
    args: unknown;
  }): Promise<{ ok: boolean; content: unknown; isError?: boolean; errorCode?: string }> {
    const sessionId = String(input?.sessionId ?? "").trim();
    const specs = input?.specs ?? [];
    const toolName = String(input?.toolName ?? "").trim();
    if (!sessionId || !toolName) {
      return { ok: false, isError: true, errorCode: ErrorCodes.INVALID_ARGUMENT, content: "session and tool name required" };
    }
    if (specs.length === 0) {
      return {
        ok: false,
        isError: true,
        errorCode: ErrorCodes.NOT_FOUND,
        content: `extension tool "${toolName}" is not registered in this session`,
      };
    }
    const runner = await this.sessionRunner(sessionId, specs);
    const tool = (runner.getAgentTools?.() ?? []).find((candidate) => candidate.name === toolName);
    if (!tool) return unknownExtensionTool(toolName);
    try {
      // Four arguments is the whole callback the Runner's own `execute` closure
      // takes: it supplies the extension context itself, so passing one here
      // would be a second, competing context.
      const result = await tool.execute(
        String(input.toolCallId ?? ""),
        input.args ?? {},
        undefined,
        undefined,
      );
      return { ok: true, content: extensionToolText(result?.content) };
    } catch (error) {
      // A throwing handler is a tool error the model reads, not a failed call:
      // the same answer `TrustedExtensionRunner` gives a command handler.
      return {
        ok: false,
        isError: true,
        errorCode: ErrorCodes.TOOL_FAILED ?? "TOOL_FAILED",
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The transport one registered plugin agent serves for this session.
   *
   * A runtime without a JavaScript runner cannot call a plugin's `stream`/
   * `complete` itself, so main hands it over (`plugin-agent-transport.ts`). The
   * Runner is looked up per call — the same one commands, hooks and tools use —
   * so a reload, an enable or a scope change reaches the next turn.
   */
  async agentTransport(input: {
    sessionId: string;
    specs: TrustedExtensionSpec[];
    agentKey: string;
    modelId: string;
  }): Promise<ExtensionAgentTransport | undefined> {
    const sessionId = String(input?.sessionId ?? "").trim();
    const specs = input?.specs ?? [];
    const agentKey = String(input?.agentKey ?? "").trim();
    if (!sessionId || !agentKey || specs.length === 0) return undefined;
    const runner = await this.sessionRunner(sessionId, specs);
    const agent = (runner.getAgents?.() ?? []).find((entry) => entry.key === agentKey);
    const model = agent?.models.find((entry) => !input.modelId || entry.id === input.modelId);
    if (!agent || !model) return undefined;
    return {
      providerId: agent.providerId,
      model,
      stream: (context, options) => agent.stream(model, context, options),
    };
  }

  /**
   * What the plugin row shows for one plugin's modules (spec §11): the most
   * recent session that reported on any of them wins; `enabled` until then.
   */
  statusForPlugin(extensionIds: readonly string[]): PluginAgentExtensionStatus {
    const ids = new Set(extensionIds);
    const status: PluginAgentExtensionStatus = {
      state: "enabled",
      toolNames: [],
      commandNames: [],
      agentNames: [],
      diagnostics: [],
    };
    for (const session of this.sessions.values()) {
      const reports = session.reports.filter((r) => ids.has(r.extensionId));
      if (!reports.length) continue;
      status.state = reports.some((r) => r.state === "error") ? "error" : "loaded";
      status.toolNames = reports.flatMap((r) => r.toolNames);
      status.commandNames = reports.flatMap((r) => r.commandNames);
      status.agentNames = reports.flatMap((r) => r.agentNames);
      status.diagnostics = session.diagnostics.filter((d) => ids.has(d.extensionId));
    }
    return status;
  }

  // --- UI bridge ------------------------------------------------------------------

  async requestUi(envelope: TrustedExtensionUiRequestEnvelope): Promise<TrustedExtensionUiResponse> {
    const { request } = envelope;
    switch (request.kind) {
      case "cancel": {
        const key = JSON.stringify([envelope.sessionId, envelope.extensionId, request.requestId]);
        this.uiRequests.get(key)?.controller.abort();
        return { kind: "cancel" };
      }
      case "notify": {
        const toast = extensionToastText(envelope.extensionLabel, request.message);
        if (toast) this.options.onToast(toast, request.level);
        return { kind: "notify" };
      }
      case "setStatus":
        this.options.onStatus({
          sessionId: envelope.sessionId,
          extensionId: envelope.extensionId,
          key: request.key,
          text: request.text,
        });
        return { kind: "setStatus" };
      case "setWorkingMessage":
        this.options.onStatus({
          sessionId: envelope.sessionId,
          extensionId: envelope.extensionId,
          key: "working",
          text: request.text,
        });
        return { kind: "setWorkingMessage" };
      case "confirm":
      case "select":
      case "input":
        break;
    }
    if (!this.options.hasRenderer()) {
      throw Object.assign(new Error("interactive extension prompts need the desktop window"), {
        errorCode: ErrorCodes.UNSUPPORTED,
      });
    }
    const key = JSON.stringify([envelope.sessionId, envelope.extensionId, envelope.requestId ?? randomUUID()]);
    if (this.uiRequests.has(key)) throw new Error("Duplicate extension UI request");
    const controller = new AbortController();
    this.uiRequests.set(key, { sessionId: envelope.sessionId, controller });
    const previous = this.promptQueues.get(envelope.sessionId) ?? Promise.resolve();
    const run = previous.then(() => controller.signal.aborted
      ? dismissedResponse(request.kind)
      : this.showPrompt(envelope, request, controller.signal));
    const tail = run.catch(() => undefined);
    this.promptQueues.set(envelope.sessionId, tail);
    let retire!: () => void;
    const cancelled = new Promise<TrustedExtensionUiResponse>((resolve) => {
      retire = () => resolve(dismissedResponse(request.kind));
      controller.signal.addEventListener("abort", retire, { once: true });
      if (controller.signal.aborted) retire();
    });
    try { return await Promise.race([run, cancelled]); }
    finally {
      controller.signal.removeEventListener("abort", retire);
      this.uiRequests.delete(key);
      void tail.then(() => {
        if (this.promptQueues.get(envelope.sessionId) === tail) this.promptQueues.delete(envelope.sessionId);
      });
    }
  }

  respond(promptId: string, value: string | boolean | undefined): boolean {
    const pending = this.pending.get(promptId);
    if (!pending) return false;
    this.settle(promptId, this.responseFor(pending.kind, value));
    return true;
  }

  /** Aborting a turn dismisses that session's open prompts (spec §9). */
  cancelPrompts(sessionId: string): void {
    for (const entry of this.uiRequests.values()) {
      if (entry.sessionId === sessionId) entry.controller.abort();
    }
    for (const [promptId, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle(promptId, dismissedResponse(pending.kind));
    }
  }

  pendingPromptCount(): number {
    return this.pending.size;
  }

  // --- internals -------------------------------------------------------------------

  private showPrompt(
    envelope: TrustedExtensionUiRequestEnvelope,
    request: TrustedExtensionUiPrompt["request"],
    signal: AbortSignal,
  ): Promise<TrustedExtensionUiResponse> {
    return new Promise((resolvePrompt) => {
      const promptId = randomUUID();
      const prompt = { promptId, sessionId: envelope.sessionId, extensionId: envelope.extensionId,
        extensionLabel: envelope.extensionLabel, request };
      const abort = () => this.settle(promptId, dismissedResponse(request.kind));
      const timer = setTimeout(
        () => this.settle(promptId, dismissedResponse(request.kind)),
        this.options.promptTimeoutMs ?? TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS,
      );
      this.pending.set(promptId, {
        prompt,
        sessionId: envelope.sessionId,
        kind: request.kind,
        resolve: (response) => { signal.removeEventListener("abort", abort); resolvePrompt(response); },
        timer,
      });
      signal.addEventListener("abort", abort, { once: true });
      this.options.onPrompt(prompt);
      if (signal.aborted) abort();
    });
  }

  private settle(promptId: string, response: TrustedExtensionUiResponse): void {
    const pending = this.pending.get(promptId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(promptId);
    this.options.onPrompt({ ...pending.prompt, cancelled: true });
    pending.resolve(response);
  }

  private responseFor(
    kind: PendingPrompt["kind"],
    value: string | boolean | undefined,
  ): TrustedExtensionUiResponse {
    if (kind === "confirm") return { kind, value: value === true };
    return { kind, value: typeof value === "string" ? value : undefined };
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { commands: [], diagnostics: [], reports: [] };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * The Runner for one session, rebuilt when the trusted set changes — the same
   * rule the sidecar applies, where the set is part of the runtime match.
   *
   * One Runner per session serves commands, hooks and extension tools. Sharing it
   * is not an optimisation: module-level state is shared between Runners in one
   * pi process, so a second instance would give an extension two copies of
   * itself and fire `session_start` twice.
   */
  private sessionRunner(sessionId: string, specs: TrustedExtensionSpec[]): Promise<ExtensionCommandRunner> {
    const key = specs.map((spec) => `${spec.id}\0${spec.entry}`).sort().join("\n");
    const cached = this.commandRunners.get(sessionId);
    if (cached?.key === key) return cached.ready;
    if (cached) void cached.ready.then((runner) => runner.dispose()).catch(() => undefined);
    const factory = this.options.runnerFactory ?? loadTrustedExtensionRunner;
    const built: { current?: ExtensionCommandRunner } = {};
    const host = this.sessionHost;
    const ready = (async () => {
      // The session's own binding, read once per Runner: `ctx.cwd`, `ctx.model`
      // and the model registry all need it, and a host round trip per member
      // would be three reads of the same row.
      const binding = host ? await host.sessionBinding(sessionId).catch(() => undefined) : undefined;
      const runner = await factory({ specs, bridge: this.commandBridge(sessionId, built, binding) });
      built.current = runner;
      await runner.load();
      return runner;
    })();
    // A load failure must not poison the cache: the next command retries it.
    ready.catch(() => {
      if (this.commandRunners.get(sessionId)?.ready === ready) this.commandRunners.delete(sessionId);
    });
    this.commandRunners.set(sessionId, { key, ready });
    return ready;
  }

  private disposeSessionRunner(sessionId: string): void {
    const cached = this.commandRunners.get(sessionId);
    if (!cached) return;
    this.commandRunners.delete(sessionId);
    void cached.ready.then((runner) => runner.dispose()).catch(() => undefined);
  }

  /**
   * What a command sees while main runs it (spec 16 §8).
   *
   * The UI half goes through this bridge, so a command asks the same window the
   * sidecar would. The turn half is answered by the host services main supplies
   * ({@link AgentExtensionSessionHost}): rename, queue and model binding are the
   * same `session.*` flows the Node runtime's own bridge calls, not a second
   * implementation of what they mean. Without those services a member refuses
   * loudly — the Runner records the throw as a diagnostic on the plugin row,
   * which is what a session with no runtime to reach should look like.
   */
  private commandBridge(
    sessionId: string,
    built: { current?: ExtensionCommandRunner },
    binding: ExtensionSessionBinding | undefined,
  ): TrustedExtensionBridge {
    const host = this.sessionHost;
    return {
      sessionId,
      cwd: binding?.projectPath ?? process.cwd(),
      // The binding's ids, not a provider row: the registry is the only place a
      // model is described, and it is a redacted projection (spec §5).
      getModel: () =>
        binding ? { provider: binding.providerId, id: binding.modelId } : undefined,
      setModel: async (model) => {
        if (!host) return false;
        if (!host.isSessionIdle(sessionId)) return false;
        const target = findRegisteredAgentModel(built.current?.getAgents?.() ?? [], model);
        if (!target) return false;
        try {
          const result = await host.configureModel({
            sessionId,
            mode: binding?.mode ?? "agent",
            providerId: target.providerId,
            modelId: target.modelId,
            ...(binding?.thinkingLevel ? { thinkingLevel: binding.thinkingLevel } : {}),
          });
          return result.ok;
        } catch {
          return false;
        }
      },
      modelRegistry: createExtensionModelRegistry({
        agents: () => built.current?.getAgents?.() ?? [],
        binding,
      }),
      getThinkingLevel: () => binding?.thinkingLevel ?? "off",
      setThinkingLevel: () => {},
      isIdle: () => (host ? host.isSessionIdle(sessionId) : true),
      abort: () => {},
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      getSessionName: () => this.sessionNames.get(sessionId) ?? binding?.title,
      setSessionName: async (name) => {
        if (!host) throw new Error("ctx.setSessionName needs the host session services");
        const title = String(name);
        await host.renameSession({ sessionId, title });
        this.sessionNames.set(sessionId, title);
        void built.current?.emit?.("session_info_changed", {
          type: "session_info_changed",
          name: title,
        });
      },
      sendUserMessage: async (content, options) => {
        if (!host) throw new Error("ctx.sendUserMessage needs the host session services");
        // Host-owned queue (D386): the Agent Host drains it at the next turn
        // boundary, or right away when the session is idle. `steer` moves it to
        // the head — the same two calls the Node bridge makes.
        const pushed = await host.queueUserMessage({
          sessionId,
          content: extensionMessageText(content),
          idempotencyKey: randomUUID(),
        });
        if (options?.deliverAs === "steer" && pushed?.id) {
          await host.prioritizeQueuedMessage(pushed.id).catch(() => undefined);
        }
      },
      waitForIdle: async () => {},
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      requestUi: (spec, request, signal) =>
        this.requestExtensionUi(sessionId, spec, request, signal),
      publishCommands: (commands) => this.publishCommands(sessionId, commands),
      publishDiagnostics: (diagnostics) =>
        this.publishDiagnostics(sessionId, diagnostics, built.current?.getLoadReports?.() ?? []),
    };
  }

  /**
   * One UI request from a main-run command, cancelled with the handler that
   * asked for it (spec §9): the signal is the handler's, not the session's.
   */
  private requestExtensionUi(
    sessionId: string,
    spec: TrustedExtensionSpec,
    request: TrustedExtensionUiRequestEnvelope["request"],
    signal?: AbortSignal,
  ): Promise<TrustedExtensionUiResponse> {
    const requestId = randomUUID();
    const envelope: TrustedExtensionUiRequestEnvelope = {
      requestId,
      sessionId,
      extensionId: spec.id,
      extensionLabel: spec.label,
      request,
    };
    const pending = this.requestUi(envelope);
    if (!signal) return pending;
    const cancel = () => {
      void this.requestUi({ ...envelope, request: { kind: "cancel", requestId } });
    };
    signal.addEventListener("abort", cancel, { once: true });
    return pending.finally(() => signal.removeEventListener("abort", cancel));
  }
}



/** One extension tool's declared content as the single text the kernel stores. */
function extensionToolText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? "" : JSON.stringify(content);
  }
  const text = content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
  // A result made only of non-text blocks still has to say something: the kernel's
  // tool row is text, and an empty one would look like a tool that did nothing.
  return text.length > 0 ? text : JSON.stringify(content);
}

function unknownExtensionTool(toolName: string): {
  ok: boolean;
  content: unknown;
  isError?: boolean;
  errorCode?: string;
} {
  return {
    ok: false,
    isError: true,
    errorCode: ErrorCodes.NOT_FOUND,
    content: `extension tool "${toolName}" is not registered in this session`,
  };
}

const NPM_LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

const IMPORT_SENSITIVE_FILE_NAMES = new Set([
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
]);
const IMPORT_SENSITIVE_DIRECTORY_NAMES = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
]);

function isSensitiveImportedPath(relativePath: string): boolean {
  const parts = relativePath.split(sep).filter(Boolean);
  if (parts.some((part) => IMPORT_SENSITIVE_DIRECTORY_NAMES.has(part.toLowerCase()))) return true;
  const name = parts.at(-1)?.toLowerCase() ?? "";
  return (
    IMPORT_SENSITIVE_FILE_NAMES.has(name) ||
    name.startsWith(".env") ||
    name.startsWith("id_rsa") ||
    /\.(pem|p12|pfx|keystore)$/.test(name)
  );
}

function importedPathError(message: string): Error & { errorCode?: string } {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function slugFor(path: string): string {
  const stem = basename(path, extname(path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "extension";
}

/**
 * Build a plugin directory from a pi extension file or directory (spec §3):
 * copies the source under `src/`, writes a manifest that declares the entry
 * files as `contributes.agentExtensions`, and a CommonJS no-op `main.cjs`. A directory
 * that ships a `package.json` also gets it (plus its lockfile) at the plugin
 * root so {@link installExtensionDependencies} can resolve its dependencies
 * there; `node_modules` itself is never copied — it is reinstalled.
 */
export function generateImportedExtensionPlugin(
  source: string,
  importRoot: string,
): { path: string; id: string; entries: string[] } {
  const resolved = existsSync(source) ? realpathSync(source) : resolve(source);
  const isDirectory = existsSync(resolved) && statSync(resolved).isDirectory();
  const { skills, skillsOnly } = isDirectory
    ? discoverImportedPackageSkills(resolved)
    : { skills: [], skillsOnly: false };
  // A skill-only package may contain helper scripts; do not promote a root
  // index.js or other incidental script to executable agent extensions.
  const specs = skillsOnly ? [] : discoverManualPath(resolved);
  if (specs.length === 0 && skills.length === 0) {
    throw importedPathError("no extension entry found at that path");
  }
  for (const spec of specs) {
    assertImportedPackagePath(isDirectory ? resolved : dirname(resolved), spec.entry);
    if (isSensitiveImportedPath(relative(isDirectory ? resolved : dirname(resolved), spec.entry))) {
      throw importedPathError("imported packages cannot contain credential files");
    }
  }
  const slug = slugFor(resolved);
  mkdirSync(importRoot, { recursive: true });
  if (lstatSync(importRoot).isSymbolicLink()) {
    throw importedPathError("import destination root cannot be a symbolic link");
  }
  let dir: string;
  let suffix = 2;
  while (true) {
    const candidate = join(importRoot, suffix === 2 ? slug : `${slug}-${suffix}`);
    const destinationRelative = relative(resolved, resolve(candidate));
    if (isDirectory && !isAbsolute(destinationRelative) && !destinationRelative.split(sep).includes("..")) {
      throw importedPathError("import destination cannot be inside the selected package");
    }
    try {
      // Atomic creation prevents a pre-existing or racing symlink from being followed.
      mkdirSync(candidate);
      dir = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        suffix += 1;
        continue;
      }
      throw error;
    }
  }
  const id = `${IMPORTED_PLUGIN_ID_PREFIX}${basename(dir)}`;
  const srcDir = join(dir, "src");
  try {
    mkdirSync(srcDir);
    if (isDirectory) {
      cpSync(resolved, srcDir, {
        recursive: true,
        filter: (path) => {
          const relativePath = relative(resolved, path);
          // Exclude dependencies within the selection, not its npm installation ancestors.
          if (relativePath.split(sep).includes("node_modules")) return false;
          if (relativePath && isSensitiveImportedPath(relativePath)) return false;
          if (lstatSync(path).isSymbolicLink()) {
            throw importedPathError("imported packages cannot contain a symbolic link");
          }
          return true;
        },
      });
    } else {
      cpSync(resolved, join(srcDir, basename(resolved)));
    }
    const entries = specs.map((spec) =>
      isDirectory
        ? `src/${relative(resolved, spec.entry).split("\\").join("/")}`
        : `src/${basename(resolved)}`,
    );
    const manifest = {
      schemaVersion: 1,
      id,
      name: slug,
      version: "0.0.0",
      description: `Imported pi extension from ${resolved}`,
      main: IMPORTED_PLUGIN_MAIN,
      permissions: [...(entries.length ? ["agent.extension"] : []), ...(skills.length ? ["agent.prompt.inject"] : [])],
      contributes: {
        ...(entries.length ? { agentExtensions: entries } : {}),
        ...(skills.length ? { skills: skills.map((path) => ({
          path: `src/${path}`,
          // Distinct directories often use the same SKILL.md basename.
          id: `skill-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
        })) } : {}),
      },
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    writeFileSync(
      join(dir, IMPORTED_PLUGIN_MAIN),
      IMPORTED_PLUGIN_WRAPPER_SOURCE,
      "utf8",
    );
    if (isDirectory) {
      const rootPackageJson = join(resolved, "package.json");
      if (existsSync(rootPackageJson)) {
        // A `workspaces` field would send npm into the copied sources under
        // src/; strip it so the install sees only the declared dependencies.
        try {
          const pkg = JSON.parse(readFileSync(rootPackageJson, "utf8")) as Record<string, unknown>;
          if (pkg && typeof pkg === "object" && "workspaces" in pkg) {
            delete pkg.workspaces;
            writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
          } else {
            copyFileSync(rootPackageJson, join(dir, "package.json"));
          }
        } catch {
          // Not valid JSON: copy verbatim; the install step reports the failure.
          copyFileSync(rootPackageJson, join(dir, "package.json"));
        }
        for (const file of NPM_LOCKFILE_NAMES) {
          if (existsSync(join(resolved, file))) copyFileSync(join(resolved, file), join(dir, file));
        }
      }
    }
    return { path: dir, id, entries };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
