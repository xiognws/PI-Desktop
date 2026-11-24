import {
  decideTurnTier,
  normalizeSmartSnapshot,
  type AgentEventEnvelope,
  type SmartBinding,
  type SmartModeSnapshot,
  type SmartRouteReason,
  type SmartTier,
} from "@pi-workspace/shared";
import type { Logger } from "../logger";

/**
 * Smart mode on the main-process side: which tier a turn runs on, and the two
 * signals that cannot be read before dispatch.
 *
 * The decision itself is pure and lives in `@pi-workspace/shared`, so the
 * renderer can explain it and the tests can table it. What belongs here is the
 * part that only main knows: whether the cheap binding is actually usable
 * (enabled provider, listed model, resolvable credential) and what the *last*
 * turn in this session did — a turn that called tools or failed is evidence
 * about the next one, and it arrives as an event rather than as stored state.
 *
 * Token economics is the whole point, so this module adds no request and no
 * prompt text: every input is already in hand or already on the wire.
 */

/** The provider row fields routing needs; the full row is wider. */
export type SmartProviderRow = {
  id: string;
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  authKind?: string;
  hasSecret?: boolean;
  hasOauth?: boolean;
  defaultModelId?: string | null;
  models?: ReadonlyArray<{ id: string }>;
};

export type SmartPlanInput = {
  sessionId: string;
  /** The session's stored snapshot, exactly as host-core returned it. */
  smartMode: unknown;
  providers: readonly SmartProviderRow[];
  /** Prompt text as typed; the router only reads it. */
  prompt: string;
  attachments: number;
  /** A staged plan/goal run owns this turn's definition. */
  stagedMode: boolean;
  /** Messages already in the session; 0 is the first turn. */
  messageCount: number;
  /** The user named a tier for this turn (`/main`, `/sub`). */
  override?: SmartTier;
};

export type SmartPlan = {
  snapshot: SmartModeSnapshot;
  tier: SmartTier;
  reason: SmartRouteReason;
  /** The binding this turn must run on. `tier: "main"` is the session's own. */
  binding: SmartBinding;
  /** Whether routing fell back to main because the cheap half was unusable. */
  downgraded: boolean;
};

export type SmartRoutingDeps = {
  logger: Logger;
};

/**
 * A provider can serve a turn only when it is enabled, reachable and able to
 * sign a request. Anything else would fail the turn rather than save a token,
 * so it counts as "no cheap model" and the turn stays on main.
 */
export function providerCanServe(
  row: SmartProviderRow | undefined,
  modelId: string,
): row is SmartProviderRow {
  if (!row) return false;
  if (row.enabled === false) return false;
  if (!row.baseUrl || !row.baseUrl.trim()) return false;
  const listed = (row.models ?? []).some((model) => model.id === modelId);
  if (!listed && row.defaultModelId !== modelId) return false;
  if (row.authKind === "none") return true;
  return row.hasSecret === true || row.hasOauth === true;
}

export function createSmartRouting({ logger }: SmartRoutingDeps) {
  /** Sessions whose previous turn called a tool: such a conversation is working, not chatting. */
  const usedToolsLastTurn = new Set<string>();
  const usedToolsThisTurn = new Set<string>();
  /** Turns left to keep on the main model after an escalation. */
  const stickyMainTurns = new Map<string, number>();
  /** Assistant text seen in the turn currently closing. */
  const producedTextThisTurn = new Set<string>();
  /** A root failure was reported for the turn currently closing. */
  const failedThisTurn = new Set<string>();

  function closeTurn(sessionId: string): void {
    if (usedToolsThisTurn.has(sessionId)) usedToolsLastTurn.add(sessionId);
    else usedToolsLastTurn.delete(sessionId);
    usedToolsThisTurn.delete(sessionId);
    const failed = failedThisTurn.delete(sessionId);
    const silent = !producedTextThisTurn.delete(sessionId);
    // Evidence, not a guess: a cheap turn that failed or answered nothing is
    // the case the routing rules could not see before dispatch. Keep the next
    // turns on the strong model until the conversation produces something.
    if (failed || silent) {
      const turns = 1;
      stickyMainTurns.set(sessionId, Math.max(stickyMainTurns.get(sessionId) ?? 0, turns));
    } else if ((stickyMainTurns.get(sessionId) ?? 0) > 0) {
      stickyMainTurns.set(sessionId, (stickyMainTurns.get(sessionId) ?? 1) - 1);
    }
  }

  /**
   * Watch the turn's own events. Everything here is already on the wire, so
   * the signals cost nothing: a tool call, a reply, a failure, a closed turn.
   */
  function observeEvent(envelope: AgentEventEnvelope): void {
    const sessionId = envelope.sessionId.trim();
    if (!sessionId) return;
    // A delegate's events belong to the delegate, not to the session's turn.
    const delegated = Boolean(envelope.parentToolCallId);
    const event = envelope.event;
    switch (event.type) {
      case "tool_start":
        if (!delegated) usedToolsThisTurn.add(sessionId);
        return;
      case "message_end": {
        const message = event.message;
        const text = typeof message.content === "string" ? message.content.trim() : "";
        if (!delegated && message.role === "assistant" && text.length > 0) {
          producedTextThisTurn.add(sessionId);
        }
        return;
      }
      case "error":
        if (!delegated) failedThisTurn.add(sessionId);
        return;
      case "turn_end":
        closeTurn(sessionId);
        return;
      default:
        return;
    }
  }

  /**
   * Decide the tier for one turn, or `null` when the session has no smart mode.
   *
   * Only a plan whose tier is `sub` changes the launch; `main` is the session's
   * own binding, so a session that lost its cheap model keeps working.
   */
  function planTurn(input: SmartPlanInput): SmartPlan | null {
    const snapshot = normalizeSmartSnapshot(input.smartMode);
    if (!snapshot) {
      // No pair means no routing state worth keeping. A chat that left smart
      // mode must not inherit a stale escalation ladder when it comes back.
      forget(input.sessionId);
      return null;
    }
    const subAvailable = providerCanServe(
      input.providers.find((row) => row.id === snapshot.sub.providerId),
      snapshot.sub.modelId,
    );
    const sticky = stickyMainTurns.get(input.sessionId) ?? 0;
    const decision = decideTurnTier(
      {
        prompt: input.prompt,
        attachments: input.attachments,
        stagedMode: input.stagedMode,
        turnIndex: input.messageCount,
        stickyMain: sticky,
        ...(input.override ? { override: input.override } : {}),
        previousTurnUsedTools: usedToolsLastTurn.has(input.sessionId),
        subAvailable,
      },
      snapshot.policy,
    );
    if (sticky > 0) stickyMainTurns.set(input.sessionId, sticky - 1);
    const binding = decision.tier === "sub" ? snapshot.sub : snapshot.main;
    // The router refuses `sub` for an unusable binding itself; keeping the
    // guard here means a stale snapshot cannot dispatch a broken turn either.
    if (decision.tier === "sub" && !subAvailable) {
      return {
        snapshot,
        tier: "main",
        reason: decision.reason,
        binding: snapshot.main,
        downgraded: true,
      };
    }
    logger.app("session", "info", "smart route", {
      sessionId: input.sessionId,
      data: {
        tier: decision.tier,
        reason: decision.reason,
        model: `${binding.providerId}/${binding.modelId}`,
        ...(decision.downgradedFrom ? { downgradedFrom: decision.downgradedFrom } : {}),
      },
    });
    return {
      snapshot,
      tier: decision.tier,
      reason: decision.reason,
      binding,
      downgraded: Boolean(decision.downgradedFrom),
    };
  }

  /** Drop a session's routing state (deleted, or switched out of smart mode). */
  function forget(sessionId: string): void {
    usedToolsLastTurn.delete(sessionId);
    usedToolsThisTurn.delete(sessionId);
    stickyMainTurns.delete(sessionId);
    producedTextThisTurn.delete(sessionId);
    failedThisTurn.delete(sessionId);
  }

  return { observeEvent, planTurn, forget };
}

export type SmartRouting = ReturnType<typeof createSmartRouting>;
