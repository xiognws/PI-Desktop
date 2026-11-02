/**
 * The one place that actually calls a model for memory extraction (ADR 0376).
 *
 * Everything decision-shaped lives in `@pi-desktop/agent-runtime`
 * (`memory-extraction.ts`); this module only assembles the one-shot completion
 * the app already knows how to run — same launch resolver, same provider config,
 * same credentials — and posts whatever survives parsing to `memory.propose`.
 *
 * Three rules shape it:
 *
 * - It **runs on every tool-using turn**: this build forces extraction on from
 *   the bottom and ignores `memoryExtractAfterTurn`, which the UI still
 *   stores. A completion per turn is the accepted cost.
 * - It only runs on a turn that **used a tool**. A chat turn rarely produces a
 *   durable fact, so the cheap signal keeps most turns free.
 * - It **never fails a turn**: the turn has already finished when this runs, and
 *   every failure is a log line.
 */

import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionTranscript,
  completeOneShot,
  parseExtractionCandidates,
  type ExtractionTurn,
  type RuntimeProviderConfig,
} from "@pi-desktop/agent-runtime";
import type { AppSettings } from "@pi-desktop/shared";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "./oauth";
import { pluginCompleteContext } from "./plugin-agent-complete";

const EXTRACTION_TIMEOUT_MS = 30_000;

type HostLike = {
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};

type SessionLike = {
  id?: string;
  projectPath?: string | null;
  messages?: Array<{ role?: string; content?: unknown }>;
};

export type MemoryExtractionDependencies = {
  settings: () => Promise<AppSettings>;
  session: (id: string) => Promise<SessionLike | undefined>;
  resolveLaunch: (
    sessionId: string,
    session: Record<string, unknown>,
    settings: AppSettings,
    options: Record<string, unknown>,
  ) => Promise<any>;
  vendorOAuth: VendorOAuth;
  host: () => HostLike | null;
  logger: {
    app: (category: string, level: string, event: string, data?: unknown) => void;
  };
  /** Injectable for tests; defaults to the runtime's one-shot completion. */
  complete?: typeof completeOneShot;
};

export type MemoryExtractionRequest = {
  sessionId: string;
  /** True when the turn ran at least one tool; extraction skips chat-only turns. */
  usedTools: boolean;
  /** Only Agent turns are reviewed; Plan and Goal declare a denial-only tool set. */
  mode?: string;
};

function flattenTurns(session: SessionLike | undefined): ExtractionTurn[] {
  const turns: ExtractionTurn[] = [];
  for (const message of session?.messages ?? []) {
    const role = message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : null;
    if (!role) continue;
    const content = typeof message?.content === "string" ? message.content : "";
    if (content.trim()) turns.push({ role, content });
  }
  return turns;
}

export function createMemoryExtractionService(deps: MemoryExtractionDependencies) {
  const complete = deps.complete ?? completeOneShot;

  async function run(request: MemoryExtractionRequest): Promise<number> {
    if (!request.usedTools) return 0;
    if (request.mode && request.mode !== "agent") return 0;
    const host = deps.host();
    if (!host) return 0;

    const settings = await deps.settings();
    // Forced on: extraction runs after every tool-using turn regardless of
    // `memoryExtractAfterTurn`. The stored setting is no longer a gate; the UI
    // toggle is kept so an existing profile does not lose the field. This
    // override of ADR 0376 is deliberate.
    const providerId = settings.defaultProviderId;
    const modelId = settings.defaultModelId;
    if (!providerId || !modelId) return 0;

    const session = await deps.session(request.sessionId);
    const transcript = buildExtractionTranscript(flattenTurns(session));
    if (!transcript.trim()) return 0;

    const launch = await deps.resolveLaunch(
      request.sessionId,
      (session ?? {}) as Record<string, unknown>,
      settings,
      { mode: "agent", providerId, modelId, thinkingLevel: "off" },
    );
    const provider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => deps.vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
    let text: string | undefined;
    try {
      const context = pluginCompleteContext({
        modelKey: `${providerId}/${modelId}`,
        thinkingLevel: "off",
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: transcript }],
      });
      const result = await complete(provider, context, launch.sidecarParams.thinkingLevel, {
        signal: controller.signal,
        sessionId: request.sessionId,
        emptyErrorCode: "INVALID_ARGUMENT",
        emptyErrorMessage: "The model returned no text.",
      });
      text = result.text;
    } finally {
      clearTimeout(timer);
    }

    const candidates = parseExtractionCandidates(text ?? "");
    if (candidates.length === 0) return 0;

    const scope = session?.projectPath ? "project" : "session";
    let queued = 0;
    for (const candidate of candidates) {
      try {
        const response = await host.call<{ queued?: boolean }>("memory.propose", {
          scope,
          projectPath: scope === "project" ? session?.projectPath : undefined,
          sessionId: scope === "session" ? request.sessionId : undefined,
          kind: candidate.kind,
          title: candidate.title,
          body: candidate.body,
          tags: candidate.tags,
          origin: "turn",
        });
        if (response?.queued) queued += 1;
      } catch (error) {
        deps.logger.app("memory", "warn", "memory extraction proposal failed", {
          sessionId: request.sessionId,
          data: String(error),
        });
      }
    }
    deps.logger.app("memory", "info", "memory extraction queued proposals", {
      sessionId: request.sessionId,
      data: { candidates: candidates.length, queued },
    });
    return queued;
  }

  const running = new Set<string>();

  return {
    /**
     * Fire and forget: the turn is already finished, so nothing waits on this.
     * One pass per session at a time, or a burst of turns would queue reviews
     * faster than a person can read them.
     */
    schedule(request: MemoryExtractionRequest): void {
      if (!request.usedTools) return;
      if (running.has(request.sessionId)) return;
      running.add(request.sessionId);
      void run(request)
        .catch((error: unknown) => {
          deps.logger.app("memory", "warn", "memory extraction failed", {
            sessionId: request.sessionId,
            data: String(error),
          });
        })
        .finally(() => running.delete(request.sessionId));
    },
    /** Exposed so a test or a future manual "extract now" can await the pass. */
    run,
  };
}
