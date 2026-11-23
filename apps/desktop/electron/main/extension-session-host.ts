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
 */
import type {
  AgentExtensionSessionHost,
  ExtensionSessionBinding,
  ExtensionSessionConfigureInput,
} from "./agent-extensions";

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

export type ExtensionSessionHostDeps = {
  /** host-core RPC, or null before the host has started. */
  getHost: () => ExtensionHostCaller | null;
  /** The Agent Host, which owns turn admission for either runtime. */
  getAgentHost: () => { queue: ExtensionAgentHostQueue } | null;
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

export function createExtensionSessionHost(
  deps: ExtensionSessionHostDeps,
): AgentExtensionSessionHost {
  const requireHost = (): ExtensionHostCaller => {
    const host = deps.getHost();
    if (!host) throw new Error("host unavailable");
    return host;
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
  };
}
