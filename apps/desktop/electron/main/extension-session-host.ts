/**
 * The host-owned session services a main-run extension command needs
 * (`agent-extensions.ts`, spec 07-plugins/16 §8–§10).
 *
 * A trusted extension is JavaScript, so under the Rust kernel Electron main runs
 * its commands, tools and hooks itself. A command's *turn* half — rename the
 * session, queue a user message, persist a model binding — is not main's to
 * invent: it is the same host/session flow the Node sidecar's extension bridge
 * already calls (`packages/agent-runtime/src/runtime.ts`, `createExtensionBridge`).
 * This module is that flow, once, so both runtimes answer a command the same way:
 *
 *   setSessionName  -> `session.rename`
 *   sendUserMessage -> the Host-owned queue (D386), `session.queuePush`
 *   setModel        -> `session.configure`, then `session:modelChanged`
 *
 * Nothing here reads a credential: the binding it reports is the session row's
 * own provider/model ids, which is what the extension's read-only model registry
 * is allowed to see.
 *
 * The turn half is not all of it. Three members describe the turn the kernel is
 * running — `getContextUsage`, `getSystemPrompt`, and the active tool set — and
 * that state belongs to the kernel, which composes the prompt and holds the
 * two-tier activation set. `agent.surface` reads it and `agent.setActiveTools`
 * writes the on-demand subset; neither is re-derived here, because a second
 * composition of the same prompt is a second answer that can disagree.
 */
import type {
  AgentExtensionSessionHost,
  ExtensionSessionBinding,
  ExtensionSessionConfigureInput,
} from "./agent-extensions";
import type { ExtensionToolInfo } from "@pi-workspace/agent-runtime";

/** host-core RPC as this module uses it: one method, one answer. */
export type ExtensionHostCaller = {
  call: <T>(method: string, params?: unknown) => Promise<T>;
};

/** The Host-owned queue one extension message is pushed into (D386). */
export type ExtensionAgentHostQueue = {
  push: (input: {
    sessionId: string;
    content: string;
    idempotencyKey?: string;
  }) => Promise<{ id?: string }>;
  prioritize: (id: string) => Promise<unknown>;
};

/**
 * What the agent runtime reports about one session for an extension's read
 * members.
 *
 * An absent field is something this runtime could not answer — a session no turn
 * has run for in this process, or a read that lost a race with the transcript.
 * The bridge reports it as unavailable rather than as zero, which a caller would
 * read as a measured empty context.
 */
export type ExtensionSessionSurface = {
  /** `ctx.getContextUsage()`: the transcript against the model's budget. */
  usage?: { tokens: number; contextWindow: number; percent: number | null };
  /** `ctx.getSystemPrompt()`: the prompt the last turn composed. */
  systemPrompt?: string;
  /** `ctx.getActiveTools()` / `ctx.getAllTools()`. */
  tools?: { active: string[]; catalog: ExtensionToolInfo[] };
};

/** How long `waitForIdle` waits for a session to settle before giving up. */
export const EXTENSION_IDLE_WAIT_MS = 5 * 60_000;

/** How often it re-reads the host's idle signal while it waits. */
export const EXTENSION_IDLE_POLL_MS = 50;

/** How long `compact` waits for the turn boundary the kernel compacts at. */
export const EXTENSION_COMPACT_WAIT_MS = 60_000;

export type ExtensionSessionHostDeps = {
  /** host-core RPC, or null before the host has started. */
  getHost: () => ExtensionHostCaller | null;
  /** The Agent Host, which owns turn admission for either runtime. */
  getAgentHost: () => { queue: ExtensionAgentHostQueue } | null;
  /**
   * The agent runtime — the kernel sidecar — that runs this session's turns, or
   * null before it has started. Its `agent.surface`, `agent.setActiveTools`,
   * `agent.abort` and `agent.compact` are the members host-core has no answer
   * for.
   */
  getAgentRuntime: () => ExtensionHostCaller | null;
  /** True while the session has a turn running; `setModel` is idle-only. */
  isTurnActive: (sessionId: string) => boolean;
  /** Renderer notification of a binding change (`session:modelChanged`). */
  broadcast: (event: string, payload: unknown[]) => void;
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

type SessionRow = {
  providerId?: unknown;
  modelId?: unknown;
  mode?: unknown;
  thinkingLevel?: unknown;
  title?: unknown;
  projectPath?: unknown;
};

/**
 * One session row as the extension surface needs it.
 *
 * `providerId`/`modelId` are the *session's* binding, never a provider row: a
 * plugin agent's provider id (`extension-agent:…`) has no row at all, and the
 * ids are exactly what `setModel` persists next time.
 */
function bindingFrom(row: SessionRow | null | undefined): ExtensionSessionBinding | undefined {
  if (!row) return undefined;
  const providerId = typeof row.providerId === "string" ? row.providerId : "";
  const modelId = typeof row.modelId === "string" ? row.modelId : "";
  if (!providerId || !modelId) return undefined;
  return {
    providerId,
    modelId,
    ...(typeof row.mode === "string" ? { mode: row.mode } : {}),
    ...(typeof row.thinkingLevel === "string" ? { thinkingLevel: row.thinkingLevel } : {}),
    ...(typeof row.title === "string" ? { title: row.title } : {}),
    ...(typeof row.projectPath === "string" && row.projectPath.trim()
      ? { projectPath: row.projectPath.trim() }
      : {}),
  };
}

/**
 * Extension message content as the one text the Host queue carries (D386).
 *
 * Mirrors the Node runtime's `sendUserMessage`: text parts are joined, and a
 * non-text block contributes nothing rather than a JSON dump the model would
 * have to decode.
 */
export function extensionMessageText(content: string | unknown[]): string {
  if (!Array.isArray(content)) return String(content);
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The kernel's `agent.surface` answer, narrowed to what the bridge reports.
 *
 * Every field is checked because it crossed a process boundary: a missing or
 * mistyped number leaves that member unavailable rather than becoming `0`, which
 * a caller would read as a measured empty context.
 */
export function extensionSurfaceFrom(answer: unknown): ExtensionSessionSurface | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const record = answer as { usage?: unknown; systemPrompt?: unknown; tools?: unknown };
  const surface: ExtensionSessionSurface = {};

  if (record.usage && typeof record.usage === "object") {
    const usage = record.usage as { tokens?: unknown; contextWindow?: unknown; percent?: unknown };
    const tokens = finiteNumber(usage.tokens);
    const contextWindow = finiteNumber(usage.contextWindow);
    if (tokens !== undefined && contextWindow !== undefined) {
      // A `null` percentage is the kernel saying the budget is zero, exactly as
      // Node answers; an unreadable one is also "no percentage", never 0.
      surface.usage = { tokens, contextWindow, percent: finiteNumber(usage.percent) ?? null };
    }
  }

  if (typeof record.systemPrompt === "string") surface.systemPrompt = record.systemPrompt;

  if (record.tools && typeof record.tools === "object") {
    const tools = record.tools as { known?: unknown; active?: unknown; catalog?: unknown };
    // `known: false` is the kernel declining to describe a session it has not
    // run a turn for. Main reports the same absence, not "this session has no
    // tools".
    if (tools.known === true) {
      const active = Array.isArray(tools.active)
        ? tools.active.filter((name): name is string => typeof name === "string")
        : [];
      const catalog = Array.isArray(tools.catalog)
        ? tools.catalog.flatMap((entry): ExtensionToolInfo[] => {
            if (!entry || typeof entry !== "object") return [];
            const tool = entry as { name?: unknown; description?: unknown; active?: unknown };
            if (typeof tool.name !== "string") return [];
            return [{
              name: tool.name,
              description: typeof tool.description === "string" ? tool.description : "",
              active: tool.active === true,
            }];
          })
        : [];
      surface.tools = { active, catalog };
    }
  }

  return Object.keys(surface).length > 0 ? surface : undefined;
}

export function createExtensionSessionHost(
  deps: ExtensionSessionHostDeps,
): AgentExtensionSessionHost {
  const requireHost = (): ExtensionHostCaller => {
    const host = deps.getHost();
    if (!host) throw new Error("host unavailable");
    return host;
  };
  const requireRuntime = (): ExtensionHostCaller => {
    const runtime = deps.getAgentRuntime();
    if (!runtime) throw new Error("agent runtime unavailable");
    return runtime;
  };
  /**
   * Wait for the session to settle, for at most `timeoutMs`.
   *
   * The host's idle signal is the Agent Host's active-turn set — a state, not an
   * event: this side of the boundary has no turn-ended callback, so polling is
   * the only observation available. The wait is bounded on purpose: a session
   * that never settles must resolve, not hold an extension's handler open for the
   * life of the app. `false` says it timed out.
   */
  const waitForIdle = async (
    sessionId: string,
    timeoutMs: number = EXTENSION_IDLE_WAIT_MS,
  ): Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (!deps.isTurnActive(sessionId)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, EXTENSION_IDLE_POLL_MS));
    }
  };

  return {
    async sessionBinding(sessionId: string): Promise<ExtensionSessionBinding | undefined> {
      const host = deps.getHost();
      if (!host || !sessionId) return undefined;
      try {
        const result = await host.call<{ session?: SessionRow | null }>("session.get", {
          id: sessionId,
          messageLimit: 1,
        });
        const binding = bindingFrom(result?.session);
        if (!binding) return undefined;
        // The row carries the provider id, not the label an extension addresses it
        // by. Read it from the provider list — this runs once per Runner, not per
        // call, so one extra RPC is cheaper than a cache to invalidate.
        const providers = await host
          .call<{ providers?: { id?: string; vendorKey?: string }[] }>("providers.list", {
            includeDisabled: true,
          })
          .catch(() => undefined);
        const row = providers?.providers?.find((entry) => entry?.id === binding.providerId);
        const label = typeof row?.vendorKey === "string" ? row.vendorKey.trim() : "";
        return label ? { ...binding, providerKey: label } : { ...binding, providerKey: binding.providerId };
      } catch (error) {
        deps.log?.("warn", "extension session binding unreadable", {
          sessionId,
          error: String(error),
        });
        return undefined;
      }
    },

    async configureModel(input: ExtensionSessionConfigureInput) {
      const host = requireHost();
      const sessionId = input.sessionId.trim();
      const result = await host.call<{
        session?: { providerId?: string; modelId?: string; thinkingLevel?: string } | null;
      }>("session.configure", {
        id: sessionId,
        mode: input.mode || "agent",
        providerId: input.providerId,
        modelId: input.modelId,
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      });
      if (result?.session) {
        deps.broadcast("session:modelChanged", [
          {
            sessionId,
            modelKey:
              result.session.providerId && result.session.modelId
                ? `${result.session.providerId}/${result.session.modelId}`
                : null,
            thinkingLevel: result.session.thinkingLevel,
          },
        ]);
      }
      return {
        ok: Boolean(result?.session),
        session: bindingFrom(result?.session) ?? null,
      };
    },

    async renameSession(input: { sessionId: string; title: string }): Promise<void> {
      await requireHost().call("session.rename", {
        id: input.sessionId,
        title: input.title,
      });
    },

    async queueUserMessage(input: {
      sessionId: string;
      content: string;
      idempotencyKey?: string;
    }) {
      const agentHost = deps.getAgentHost();
      if (!agentHost) throw new Error("agent host unavailable");
      return agentHost.queue.push({
        sessionId: input.sessionId,
        content: input.content,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
    },

    async prioritizeQueuedMessage(id: string): Promise<void> {
      const agentHost = deps.getAgentHost();
      if (!agentHost) throw new Error("agent host unavailable");
      await agentHost.queue.prioritize(id);
    },

    isSessionIdle(sessionId: string): boolean {
      return !deps.isTurnActive(sessionId);
    },

    async sessionSurface(sessionId: string): Promise<ExtensionSessionSurface | undefined> {
      const runtime = deps.getAgentRuntime();
      if (!runtime || !sessionId) return undefined;
      try {
        const answer = await runtime.call("agent.surface", { sessionId });
        return extensionSurfaceFrom(answer);
      } catch (error) {
        deps.log?.("warn", "extension session surface unreadable", {
          sessionId,
          error: String(error),
        });
        return undefined;
      }
    },

    /**
     * The on-demand subset the session's next request declares
     * (`ctx.setActiveTools`).
     *
     * The answer is the state the write left behind, so the caller can report
     * what happened without reading back.
     */
    async setActiveTools(
      sessionId: string,
      names: string[],
    ): Promise<ExtensionSessionSurface["tools"] | undefined> {
      const runtime = requireRuntime();
      const answer = await runtime.call<{ tools?: unknown }>("agent.setActiveTools", {
        sessionId,
        names,
      });
      return extensionSurfaceFrom(answer)?.tools;
    },

    /**
     * Abort the session's running turn (`ctx.abort`).
     *
     * The kernel's own abort: it cancels the turn and settles the ask cards it
     * left open, which is what `runtime.abort()` does under Node.
     */
    async abortSession(sessionId: string): Promise<void> {
      const runtime = requireRuntime();
      const answer = await runtime.call<{ aborted?: boolean }>("agent.abort", { sessionId });
      deps.log?.("info", "extension aborted the session", {
        sessionId,
        aborted: answer?.aborted === true,
      });
    },

    /**
     * Compact the session's context now (`ctx.compact`).
     *
     * Deliberately different from Node, and the difference is the one thing this
     * member cannot hide: Node sets a flag the next turn boundary applies, while
     * the kernel compacts on the spot — a provider call that writes a checkpoint
     * — and refuses while a turn is running. Waiting for the boundary first
     * restores the observable shape (the call returns at once, the summary lands
     * when the session is free) without pretence: a wait that times out still
     * asks, and the kernel's refusal is reported as it is.
     */
    async compactSession(sessionId: string): Promise<boolean> {
      const runtime = requireRuntime();
      await waitForIdle(sessionId, EXTENSION_COMPACT_WAIT_MS);
      const answer = await runtime.call<{ compacted?: boolean }>("agent.compact", { sessionId });
      return answer?.compacted === true;
    },

    waitForIdle,
  };
}
