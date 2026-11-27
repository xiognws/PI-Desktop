import {
  decideTurnTier,
  normalizeSmartSnapshot,
  type AgentEventEnvelope,
  type SmartBinding,
  type SmartModeSnapshot,
  type SmartRouteReason,
  type SmartTier,
} from "@pi-workspace/shared";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  /**
   * Where the per-session routing memory is kept between runs.
   *
   * Without it the memory is process-local, which is what the first version did: a
   * restart erased the sticky main turn owed after a failed cheap turn, and the restart
   * is exactly when a turn has just died. Omitted in tests, which have no data dir.
   */
  statePath?: string;
};

/**
 * What one session's router remembers about its last turn.
 *
 * `stickyMain` outlives the turn that set it (that is the point); the rest is the
 * evidence the next decision needs and cannot read before dispatch.
 */
type SessionRoutingMemory = {
  /** Turns still owed to the strong half. */
  stickyMain: number;
  /** Tool calls the last closed turn spent. */
  previousTurnSteps: number;
  /** Whether the last closed turn used any tool at all. */
  previousTurnUsedTools: boolean;
  /** When this record last changed, so a stale file can be pruned. */
  updatedAt: number;
};

/** Sessions kept in the state file. Old entries are dropped, not migrated. */
const MAX_REMEMBERED_SESSIONS = 200;
/** How long a write waits for more changes. A turn can end many times a minute. */
const PERSIST_DEBOUNCE_MS = 250;

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

/**
 * Read the memory written by the previous run.
 *
 * A missing, empty or corrupt file means "nothing remembered": routing then behaves
 * exactly as a first start does. Losing one file must never stop a turn.
 */
function loadMemory(statePath: string | undefined): Map<string, SessionRoutingMemory> {
  const memory = new Map<string, SessionRoutingMemory>();
  if (!statePath) return memory;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return memory;
  }
  const sessions = (parsed as { sessions?: unknown })?.sessions;
  if (!sessions || typeof sessions !== "object") return memory;
  for (const [sessionId, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Partial<SessionRoutingMemory>;
    memory.set(sessionId, {
      stickyMain: Number.isFinite(row.stickyMain) ? Number(row.stickyMain) : 0,
      previousTurnSteps: Number.isFinite(row.previousTurnSteps) ? Number(row.previousTurnSteps) : 0,
      previousTurnUsedTools: row.previousTurnUsedTools === true,
      updatedAt: Number.isFinite(row.updatedAt) ? Number(row.updatedAt) : 0,
    });
  }
  return memory;
}

export function createSmartRouting({ logger, statePath }: SmartRoutingDeps) {
  const memory = loadMemory(statePath);
  /** Sessions with a turn in flight: what that turn has done so far. */
  const inFlight = new Map<
    string,
    { steps: number; producedText: boolean; failed: boolean }
  >();

  function memoryOf(sessionId: string): SessionRoutingMemory {
    return (
      memory.get(sessionId) ?? {
        stickyMain: 0,
        previousTurnSteps: 0,
        previousTurnUsedTools: false,
        updatedAt: 0,
      }
    );
  }

  function remember(sessionId: string, next: SessionRoutingMemory): void {
    memory.set(sessionId, { ...next, updatedAt: Date.now() });
    schedulePersist();
  }

  function closeTurn(sessionId: string): void {
    const turn = inFlight.get(sessionId) ?? { steps: 0, producedText: false, failed: false };
    inFlight.delete(sessionId);
    const previous = memoryOf(sessionId);
    // Evidence, not a guess: a cheap turn that failed or answered nothing is
    // the case the routing rules could not see before dispatch. Keep the next
    // turns on the strong model until the conversation produces something.
    const owed = turn.failed || !turn.producedText;
    const stickyMain = owed ? Math.max(previous.stickyMain, 1) : Math.max(previous.stickyMain - 1, 0);
    remember(sessionId, {
      stickyMain,
      previousTurnSteps: turn.steps,
      previousTurnUsedTools: turn.steps > 0,
      updatedAt: Date.now(),
    });
  }

  /**
   * Watch the turn's own events. Everything here is already on the wire, so
   * the signals cost nothing: a tool call, a reply, a failure, a closed turn.
   */
  function turnOf(sessionId: string) {
    let turn = inFlight.get(sessionId);
    if (!turn) {
      turn = { steps: 0, producedText: false, failed: false };
      inFlight.set(sessionId, turn);
    }
    return turn;
  }

  function observeEvent(envelope: AgentEventEnvelope): void {
    const sessionId = envelope.sessionId.trim();
    if (!sessionId) return;
    // A delegate's events belong to the delegate, not to the session's turn.
    const delegated = Boolean(envelope.parentToolCallId);
    const event = envelope.event;
    switch (event.type) {
      case "tool_start":
        if (!delegated) turnOf(sessionId).steps += 1;
        return;
      case "message_end": {
        const message = event.message;
        const text = typeof message.content === "string" ? message.content.trim() : "";
        if (!delegated && message.role === "assistant" && text.length > 0) {
          turnOf(sessionId).producedText = true;
        }
        return;
      }
      case "error":
        if (!delegated) turnOf(sessionId).failed = true;
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
    const remembered = memoryOf(input.sessionId);
    const sticky = remembered.stickyMain;
    const decision = decideTurnTier(
      {
        prompt: input.prompt,
        attachments: input.attachments,
        stagedMode: input.stagedMode,
        turnIndex: input.messageCount,
        stickyMain: sticky,
        ...(input.override ? { override: input.override } : {}),
        previousTurnUsedTools: remembered.previousTurnUsedTools,
        previousTurnSteps: remembered.previousTurnSteps,
        subAvailable,
      },
      snapshot.policy,
    );
    if (sticky > 0) {
      remember(input.sessionId, { ...remembered, stickyMain: sticky - 1 });
    }
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

  let persistTimer: NodeJS.Timeout | null = null;

  /** Write now, keeping the newest sessions and dropping the rest. */
  function flush(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!statePath) return;
    const rows = [...memory.entries()]
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_REMEMBERED_SESSIONS);
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(
        statePath,
        JSON.stringify({ version: 1, sessions: Object.fromEntries(rows) }, null, 0),
        "utf8",
      );
    } catch (error) {
      // A routing hint that cannot be saved is not worth failing a turn over.
      logger.app("session", "warn", "smart routing state not saved", {
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  function schedulePersist(): void {
    if (!statePath || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flush();
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  /** Drop a session's routing state (deleted, or switched out of smart mode). */
  function forget(sessionId: string): void {
    inFlight.delete(sessionId);
    if (memory.delete(sessionId)) schedulePersist();
  }

  return { observeEvent, planTurn, forget, flush };
}

export type SmartRouting = ReturnType<typeof createSmartRouting>;
