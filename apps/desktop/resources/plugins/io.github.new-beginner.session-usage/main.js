/**
 * Session Usage — /usage for the current PI-Desktop session.
 *
 * Reads only local usage metadata (transcript, persistence queue and turns).
 * Message text, tool arguments and credentials are never returned.
 */

const { existsSync, readFileSync, statSync, watch } = require("node:fs");
const path = require("node:path");

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    total: 0,
  };
}

function addTokens(into, part) {
  if (!part) return into;
  into.input += n(part.input);
  into.output += n(part.output);
  into.cacheRead += n(part.cacheRead);
  into.cacheWrite += n(part.cacheWrite);
  into.cacheWrite5m += n(part.cacheWrite5m);
  into.cacheWrite1h += n(part.cacheWrite1h);
  into.reasoning += n(part.reasoning);
  into.total += n(part.total) || (n(part.input) + n(part.output) + n(part.cacheRead) + n(part.cacheWrite) + n(part.reasoning));
  return into;
}

function cacheCreationParts(usage) {
  const nested =
    usage.cache_creation && typeof usage.cache_creation === "object"
      ? usage.cache_creation
      : usage.cacheCreation && typeof usage.cacheCreation === "object"
        ? usage.cacheCreation
        : {};
  const cacheWrite5m = n(nested.ephemeral_5m_input_tokens ?? nested.ephemeral5mInputTokens);
  const cacheWrite1h = n(nested.ephemeral_1h_input_tokens ?? nested.ephemeral1hInputTokens);
  let cacheWrite = n(
    usage.cacheWriteTokens ??
      usage.cache_creation_input_tokens ??
      usage.cache_write_input_tokens ??
      usage.cacheWrite,
  );
  if (!cacheWrite && (cacheWrite5m || cacheWrite1h)) cacheWrite = cacheWrite5m + cacheWrite1h;
  return { cacheWrite, cacheWrite5m, cacheWrite1h };
}

function toTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = n(usage.inputTokens ?? usage.input_tokens ?? usage.input);
  const output = n(usage.outputTokens ?? usage.output_tokens ?? usage.output);
  const cacheRead = n(
    usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cacheRead ?? usage.cached_tokens,
  );
  const created = cacheCreationParts(usage);
  const reasoning = n(usage.reasoningTokens ?? usage.reasoning_output_tokens ?? usage.reasoning);
  const total = n(usage.totalTokens ?? usage.total_tokens ?? usage.total);
  if (!input && !output && !cacheRead && !created.cacheWrite && !reasoning && !total) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: created.cacheWrite,
    cacheWrite5m: created.cacheWrite5m,
    cacheWrite1h: created.cacheWrite1h,
    reasoning,
    total: total || input + output + cacheRead + created.cacheWrite + reasoning,
  };
}

function promptTokens(tokens) {
  return n(tokens?.input) + n(tokens?.cacheRead) + n(tokens?.cacheWrite);
}

function hitRate(tokens) {
  const prompt = promptTokens(tokens);
  if (!prompt) return null;
  return n(tokens.cacheRead) / prompt;
}

function hostRootFromDataPath(dataPath) {
  return path.resolve(String(dataPath || ""), "..", "..", "..");
}

function openHostDb(dbFile) {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return null;
  }
  if (!sqlite?.DatabaseSync) return null;
  try {
    return new sqlite.DatabaseSync(dbFile, { readOnly: true });
  } catch {
    return null;
  }
}

function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}

function localeFromRaw(raw) {
  const text = String(raw || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
  if (!text) return "";
  if (text === "zh" || text.startsWith("zh-") || text.includes("hans") || text.includes("chinese")) {
    return "zh-CN";
  }
  return "en";
}

function localeOf(appearance, fallback) {
  return localeFromRaw(appearance?.language || appearance?.locale || fallback) || "zh-CN";
}

function isZh(locale) {
  return locale === "zh-CN";
}

function formatInt(value, locale) {
  return n(value).toLocaleString(isZh(locale) ? "zh-CN" : "en-US");
}

function formatCompact(value) {
  const num = n(value);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 1 : 2).replace(/\.0+$/, "")}M`;
  if (num >= 10_000) return `${(num / 1_000).toFixed(num >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(num));
}

function formatPct(rate, locale) {
  if (rate == null || !Number.isFinite(rate)) return isZh(locale) ? "—" : "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

function shortId(id) {
  const text = String(id || "");
  return text.length <= 8 ? text : text.slice(0, 8);
}

const identity = value => typeof value === "string" ? value.trim() : "";
const operationKey = id => JSON.stringify(["operation", id]);
const normalizedUsage = usage => usage?.desktopUsage && typeof usage.desktopUsage === "object" ? usage.desktopUsage : usage;
function measuredTokens(usage) {
  usage = normalizedUsage(usage);
  const tokens = toTokens(usage);
  if (tokens) return tokens;
  const zero = usage && typeof usage === "object" &&
    ["inputTokens", "input_tokens", "input", "outputTokens", "output_tokens", "output", "totalTokens", "total_tokens", "total"]
      .some(key => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0);
  return zero ? emptyTokens() : null;
}
// The host's addUsage deduplicates globally by operationId, keeping the larger
// reported total. Model/time similarity is never an identity or ownership link.
function mergeReply(records, row, issues) {
  const previous = records.get(row.key);
  if (!previous) { records.set(row.key, row); return; }
  const conflict = previous.identityConflict || row.identityConflict ||
    (previous.agentId !== "unknown" && row.agentId !== "unknown" && previous.agentId !== row.agentId);
  const agentId = conflict ? "unknown" : row.agentId === "unknown" ? previous.agentId : row.agentId;
  if (conflict) issues.push("conflicting_agent_identity");
  const rank = record => record.id ? record.source.includes("jsonl") ? 3 : record.source.includes("outbox") ? 2 : 1 : 0;
  const metadata = rank(row) >= rank(previous) ? row : previous;
  const measured = row.tokens.total >= previous.tokens.total ? row : previous;
  const sources = new Set([...previous.source.split("+"), ...row.source.split("+")]);
  records.set(row.key, { ...previous, ...row, ...metadata, key: row.key, agentId,
    identityConflict: !!conflict, tokens: measured.tokens,
    modelId: metadata.modelId !== "unknown" ? metadata.modelId : measured.modelId,
    providerId: metadata.providerId || measured.providerId,
    source: ["jsonl", "checkpoint", "outbox", "database"].filter(source => sources.has(source)).join("+") });
}

// Host persists delegated messages in the parent's JSONL, identified by
// meta.parentToolCallId. Task tool_call results add a human-readable agent and
// delegationId. Neither model names nor timestamps establish ownership.
function parseJsonlUsage(file, expectedSessionId, queuedRecords = null, source = "jsonl") {
  const result = { replies: [], agents: [], malformed: 0, compactCount: 0,
    missing: false, issues: [], missingUsage: new Set(), pendingUsage: new Set() };
  let text;
  if (!queuedRecords) {
    try { text = readFileSync(file, "utf8"); }
    catch (error) {
      result.missing = true;
      result.issues.push(error.code === "ENOENT" ? "missing_transcript" : "unreadable_transcript");
      return result;
    }
  }
  const agents = new Map(), messages = new Map(), delegationStates = new Map();
  const identity = value => typeof value === "string" ? value.trim() : "";
  const agentFor = callId => {
    if (!agents.has(callId)) agents.set(callId, {
      id: `agent:${callId}`, kind: "agent", callId, name: "", delegationId: "", status: "unknown",
    });
    return agents.get(callId);
  };
  const lines = queuedRecords || text.split(/\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (typeof line === "string" && !line.trim()) continue;
    let record;
    try { record = typeof line === "string" ? JSON.parse(line) : line; }
    catch { result.malformed += 1; continue; }
    if (record?.type === "session" && expectedSessionId && record.sessionId !== expectedSessionId) {
      result.issues.push("session_identity_mismatch");
      return result;
    }
    if (record?.type === "compaction" || record?.role === "compactionSummary") {
      result.compactCount += 1;
      continue;
    }
    if (record?.type !== "message") continue;
    const meta = record.meta || {};
    // Whitelist tool metadata only; never return arguments, results or text.
    if (record.role === "tool" && ["Task", "TaskWait", "TaskList", "TaskStop"].includes(record.toolName)) {
      for (const block of Array.isArray(record.blocks) ? record.blocks : []) {
        if (block?.type !== "tool_call" || block.name !== record.toolName) continue;
        let value = block.result;
        if (typeof value === "string") { try { value = JSON.parse(value); } catch { value = null; } }
        const details = value?.details;
        if (!details || typeof details !== "object") continue;
        const states = [details, ...["delegations", "stopped", "stopPending", "settled"]
          .flatMap(key => Array.isArray(details[key]) ? details[key] : [])];
        for (const state of states) {
          const id = identity(state?.delegationId);
          if (id) delegationStates.set(id, { name: identity(state.agent), status: identity(state.status) });
        }
        const callId = identity(block.callId);
        if (record.toolName !== "Task" || !callId || !identity(details.delegationId)) continue;
        const agent = agentFor(callId);
        agent.delegationId = identity(details.delegationId);
        agent.name = identity(details.agent) || agent.name;
        agent.status = identity(details.status) || agent.status;
      }
    }
    if (record.role !== "assistant") continue;
    const callId = identity(meta.parentToolCallId);
    const unconfirmed = !callId && (identity(meta.agentName) || identity(meta.nestedParentToolCallId));
    if (unconfirmed) result.issues.push("unconfirmed_agent_identity");
    const agentId = unconfirmed ? "unknown" : callId ? agentFor(callId).id : "main";
    if (callId) agentFor(callId).name = identity(meta.agentName) || agentFor(callId).name;
    const id = identity(record.id);
    const messageKey = JSON.stringify([agentId, id || `line:${index + 1}`]);
    // Updated snapshots replace the same message without changing its position.
    messages.set(messageKey, { id, messageKey, agentId, meta, createdAt: record.createdAt || null });
  }
  // Task's initial result may remain 'running' after settlement. Later wait/list/
  // stop snapshots identify the same delegation explicitly, never by agent name.
  for (const [delegationId, state] of delegationStates) {
    let matching = [...agents.values()].filter(row => row.delegationId === delegationId);
    if (!matching.length) {
      const agent = agentFor(`delegation:${delegationId}`);
      agent.callId = "";
      agent.delegationId = delegationId;
      matching = [agent];
    }
    for (const agent of matching) {
      agent.name = state.name || agent.name;
      agent.status = ["running", "completed", "failed", "timed_out", "stopped"].includes(state.status) ? state.status : "unknown";
    }
  }
  if (result.malformed) result.issues.push("malformed_records");
  const operations = new Map();
  const lineage = normalizeUsageAgents({ agents: [...agents.values()], replies: [...messages.values()] });
  for (const row of lineage.replies) {
    if (row.meta.status === "streaming") { result.pendingUsage.add(row.agentId); continue; }
    const usage = normalizedUsage(row.meta.usage);
    const atomic = Array.isArray(usage?.operations) && usage.operations.length ? usage.operations : [usage];
    if (usage?.aggregation === "aggregate" && atomic[0] === usage) {
      result.issues.push("aggregate_only_usage"); continue;
    }
    for (const part of atomic) {
      const tokens = measuredTokens(part);
      if (!tokens) { result.missingUsage.add(row.agentId); continue; }
      // usageForEvent uses this exact message identity when usage lacks an ID.
      const operationId = identity(part?.operationId) ||
        (row.id && expectedSessionId ? `message:${expectedSessionId}:${row.id}` : "");
      const key = operationId ? operationKey(operationId) : row.messageKey;
      mergeReply(operations, {
        id: row.id, key, operationId, agentId: row.agentId, source,
        createdAt: row.createdAt,
        modelId: identity(row.meta.modelId) || identity(part?.modelId) || "unknown",
        providerId: identity(row.meta.providerId) || identity(part?.providerId),
        durationMs: row.meta.responseDurationMs == null ? null : n(row.meta.responseDurationMs), tokens,
      }, result.issues);
    }
  }
  result.replies = [...operations.values()];
  result.agents = lineage.agents;
  result.issues = [...new Set(result.issues)];
  return result;
}

// Official InflightRecord (schema 1) is saved independently of the outbox.
// Only final assistant snapshots count. Never retain blocks/content/thinking.
function projectCompletedCheckpoint(record, sessionId) {
  const message = record?.message, meta = message?.meta;
  if (record?.schema !== 1 || record.sessionId !== sessionId || message?.role !== "assistant" ||
      !identity(message.id) || !["complete", "error", "aborted"].includes(meta?.status)) return null;
  return { type: "message", role: "assistant", id: identity(message.id),
    createdAt: typeof message.createdAt === "string" ? message.createdAt : null,
    meta: { usage: normalizedUsage(meta.usage), status: meta.status,
      modelId: identity(meta.modelId), providerId: identity(meta.providerId),
      parentToolCallId: identity(meta.parentToolCallId), agentName: identity(meta.agentName),
      nestedParentToolCallId: identity(meta.nestedParentToolCallId), responseDurationMs: meta.responseDurationMs } };
}
function readCompletedCheckpoint(file, sessionId) {
  let record, issue = "";
  try { record = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") issue = "unreadable_checkpoint"; }
  const message = projectCompletedCheckpoint(record, sessionId);
  const parsed = parseJsonlUsage(null, sessionId, message ? [message] : [], "checkpoint");
  if (issue) parsed.issues.push(issue);
  return parsed;
}
// Cache only normalized measured operations. Recreate a whitelisted message
// after the current renderer has explicitly identified the same conversation.
function restoreCompletedCheckpoints(cache, sessionId) {
  const records = [];
  if (cache?.schema === 1 && cache.sessionId === sessionId && Array.isArray(cache.replies)) {
    for (const row of cache.replies) {
      if (!identity(row?.id) || !identity(row?.operationId) || !row.tokens ||
          !Object.values(row.tokens).every(value => Number.isSafeInteger(value) && value >= 0)) continue;
      const tokens = row.tokens;
      records.push({ type: "message", role: "assistant", id: identity(row.id),
        createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
        meta: { status: "complete", modelId: identity(row.modelId), providerId: identity(row.providerId),
          parentToolCallId: row.agentId?.startsWith("agent:") ? row.agentId.slice(6) : "",
          agentName: row.agentId === "unknown" ? "unconfirmed" : "", responseDurationMs: row.durationMs,
          usage: { operationId: identity(row.operationId), inputTokens: tokens.input, outputTokens: tokens.output,
            cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite,
            cache_creation: { ephemeral_5m_input_tokens: tokens.cacheWrite5m, ephemeral_1h_input_tokens: tokens.cacheWrite1h },
            reasoningTokens: tokens.reasoning, totalTokens: tokens.total } } });
    }
  }
  return parseJsonlUsage(null, sessionId, records, "checkpoint");
}

// The host's outbox precedes JSONL/SQLite persistence. Project only usage and
// verified message lineage; never send message content, tool args/results or keys.
function readQueuedUsage(file, sessionId) {
  let entries, issue = "";
  try {
    entries = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(entries)) throw new Error("invalid queue");
  } catch (error) {
    entries = [];
    if (error.code !== "ENOENT") issue = "unreadable_usage_queue";
  }
  const records = [], operations = new Map(), issues = [];
  const detailsOf = value => {
    const details = value?.details;
    if (!details || typeof details !== "object") return null;
    const stateOf = state => ({ delegationId: identity(state?.delegationId), agent: identity(state?.agent), status: identity(state?.status) });
    return { ...stateOf(details), ...Object.fromEntries(["delegations", "stopped", "stopPending", "settled"]
      .map(key => [key, (Array.isArray(details[key]) ? details[key] : []).map(stateOf)])) };
  };
  for (const entry of entries) {
    if (entry?.sessionId !== sessionId) continue;
    const usage = normalizedUsage(entry.usage);
    const atomic = Array.isArray(usage?.operations) && usage.operations.length ? usage.operations : identity(usage?.operationId) ? [usage] : [];
    for (const part of atomic) {
      const operationId = identity(part?.operationId), tokens = measuredTokens(part);
      if (!operationId || !tokens) { issues.push("malformed_queued_usage"); continue; }
      mergeReply(operations, { id: "", key: operationKey(operationId), operationId,
        agentId: "unknown", source: "outbox", createdAt: null, durationMs: null,
        modelId: identity(part.modelId) || "unknown", providerId: identity(part.providerId), tokens }, issues);
    }
    const message = entry.message;
    if (message?.role === "assistant") {
      records.push({ type: "message", role: "assistant", id: identity(message.id), createdAt: message.createdAt,
        meta: { usage: message.usage, status: message.status, modelId: identity(message.modelId), providerId: identity(message.providerId),
          parentToolCallId: identity(message.parentToolCallId), agentName: identity(message.agentName),
          nestedParentToolCallId: identity(message.nestedParentToolCallId), responseDurationMs: message.responseDurationMs } });
    } else if (message?.role === "tool" && ["Task", "TaskWait", "TaskList", "TaskStop"].includes(message.toolName)) {
      const details = detailsOf(message.toolResult);
      if (details) records.push({ type: "message", role: "tool", toolName: message.toolName,
        blocks: [{ type: "tool_call", name: message.toolName, callId: identity(message.toolCallId), result: { details } }] });
    }
  }
  const parsed = parseJsonlUsage(null, sessionId, records, "outbox");
  for (const row of parsed.replies) mergeReply(operations, row, issues);
  return { ...parsed, replies: [...operations.values()], issues: [...new Set([...parsed.issues, ...issues, ...(issue ? [issue] : [])])] };
}

function retainQueuedUsage(previous, next) {
  if (!previous) return next;
  const records = new Map(), issues = [...next.issues];
  // Queue entries disappear as the host flushes them. Keep measured operations
  // for this exact selection until durable sources catch up; no guessed deltas.
  for (const row of [...previous.replies, ...next.replies]) mergeReply(records, row, issues);
  return { ...next, replies: [...records.values()], issues: [...new Set(issues)],
    agents: [...new Map([...previous.agents, ...next.agents].map(row => [row.id, row])).values()] };
}

// Resume calls share a delegation, not an agent name or a model.
function normalizeUsageAgents(parsed) {
  const groups = new Map(), aliases = new Map();
  const byId = new Map();
  for (const agent of parsed.agents || []) {
    const previous = byId.get(agent.id);
    byId.set(agent.id, { ...previous, ...agent,
      delegationId: agent.delegationId || previous?.delegationId || "",
      name: agent.name || previous?.name || "",
      status: agent.status === "unknown" ? previous?.status || agent.status : agent.status,
      callIds: [...new Set([...(previous?.callIds || []), ...(agent.callIds || []), ...(agent.callId ? [agent.callId] : [])])] });
  }
  const delegationByCall = new Map();
  for (const agent of byId.values()) {
    if (!agent.delegationId) continue;
    for (const callId of agent.callIds) delegationByCall.set(callId, agent.delegationId);
  }
  for (const agent of byId.values()) {
    if (!agent.delegationId && agent.callId) agent.delegationId = delegationByCall.get(agent.callId) || "";
    const key = agent.delegationId ? `delegation:${agent.delegationId}` : agent.id;
    let canonical = groups.get(key);
    if (!canonical) { canonical = { ...agent, callIds: [] }; groups.set(key, canonical); }
    else { canonical.name = agent.name || canonical.name; if (agent.status !== "unknown") canonical.status = agent.status; }
    canonical.callIds = [...new Set([...canonical.callIds, ...agent.callIds])];
    aliases.set(agent.id, canonical.id);
    for (const callId of canonical.callIds) aliases.set(`agent:${callId}`, canonical.id);
  }
  const remap = id => aliases.get(id) || id;
  return { ...parsed, agents: [...groups.values()],
    replies: parsed.replies.map(row => ({ ...row, agentId: remap(row.agentId) })),
    missingUsage: new Set([...(parsed.missingUsage || [])].map(remap)),
    pendingUsage: new Set([...(parsed.pendingUsage || [])].map(remap)) };
}

function buildUsageScopes(parsed, parentRunning = false) {
  parsed = normalizeUsageAgents(parsed);
  const agentsById = new Map(parsed.agents.map((agent, index) => [agent.id, { ...agent, ordinal: index + 1 }]));
  function summarize(identity, replies, issues, running) {
    const summed = sumReplies(replies);
    const history = replies.map((reply, index) => ({
      id: reply.id, key: reply.key, operationId: reply.operationId, source: reply.source, sequence: index + 1,
      modelId: reply.modelId, providerId: reply.providerId,
      agentId: reply.agentId, agentName: agentsById.get(reply.agentId)?.name || "",
      agentOrdinal: agentsById.get(reply.agentId)?.ordinal || null,
      delegationId: agentsById.get(reply.agentId)?.delegationId || "",
      createdAt: reply.createdAt, durationMs: reply.durationMs, tokens: metricsOf(reply.tokens),
    }));
    issues = [...new Set(issues)];
    const failed = issues.some(code => ["unreadable_transcript", "session_identity_mismatch", "malformed_records", "unreadable_database", "malformed_database_usage"].includes(code));
    const availability = history.length ? "available" : failed ? "failed" : issues.length ? "pending" : "empty";
    return { ...identity, complete: issues.length === 0, unavailable: issues.length > 0 && history.length === 0,
      availability, issues, running, replies: history.length, hasTotals: history.length > 0, totals: metricsOf(summed.totals), history,
      last: history.at(-1) || null,
      byModel: summed.byModel.map(row => ({ ...row, tokens: metricsOf(row.tokens) })),
    };
  }
  const unknown = parsed.replies.some(row => row.agentId === "unknown");
  const partitionIssues = unknown || parsed.aggregateOnly ? ["partition_incomplete"] : [];
  const issuesFor = id => [
    ...parsed.issues, ...partitionIssues,
    ...(parsed.missingUsage.has(id) ? ["missing_usage"] : []),
    ...(parsed.pendingUsage.has(id) ? ["pending_usage"] : []),
  ];
  const main = summarize({ id: "main", kind: "main" }, parsed.replies.filter(r => r.agentId === "main"),
    issuesFor("main"), parentRunning);
  const children = [...agentsById.values()].map(agent => {
    const replies = parsed.replies.filter(r => r.agentId === agent.id);
    const issues = issuesFor(agent.id);
    if (!replies.length) issues.push(agent.status === "running" ? "pending_agent_usage" : "missing_agent_usage");
    return summarize(agent, replies, issues, agent.status === "running");
  });
  const subIssues = [...parsed.issues, ...partitionIssues, ...children.flatMap(child => child.issues)];
  const subagents = summarize({ id: "subagents", kind: "subagents" }, parsed.replies.filter(r => r.agentId.startsWith("agent:")), subIssues, children.some(child => child.running));
  const all = summarize({ id: "all", kind: "all" }, parsed.replies,
    [...main.issues, ...subagents.issues, ...(unknown ? ["unknown_usage_identity"] : [])], parentRunning || subagents.running);
  if (!all.replies && parsed.aggregateOnly) {
    all.totals = metricsOf(parsed.aggregateOnly); all.hasTotals = true;
    all.summaryOnly = true; all.unavailable = false; all.availability = "summary";
  }
  return [all, main, subagents, ...children];
}

function sumReplies(replies) {
  const totals = emptyTokens();
  const byModel = new Map();
  for (const reply of replies) {
    addTokens(totals, reply.tokens);
    const key = reply.modelId || "unknown";
    const row = byModel.get(key) || { modelId: key, replies: 0, tokens: emptyTokens() };
    row.replies += 1;
    addTokens(row.tokens, reply.tokens);
    byModel.set(key, row);
  }
  if (!totals.total) {
    totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning;
  }
  return { totals, byModel: [...byModel.values()].sort((a, b) => b.tokens.total - a.tokens.total) };
}

function readSessionRow(db, sessionId) {
  if (!db || !sessionId) return null;
  try {
    const row = db.prepare(
      "select id, title, model_id, provider_id, thinking_level, updated_at, created_at from sessions where id = ? and deleted_at is null",
    ).get(sessionId);
    return row || null;
  } catch {
    return null;
  }
}

function readRunningSessionIds(db) {
  const ids = new Set();
  if (!db) return ids;
  try {
    const rows = db.prepare(
      "select distinct session_id as id from turns where status in ('running', 'queued', 'pending')",
    ).all();
    for (const row of rows || []) {
      if (row?.id) ids.add(String(row.id));
    }
  } catch {
    /* ignore */
  }
  return ids;
}

function readRecentSessionRows(db, limit = 16) {
  if (!db) return [];
  try {
    return db.prepare(
      "select id, title, model_id, thinking_level, updated_at from sessions where deleted_at is null order by updated_at desc limit ?",
    ).all(limit) || [];
  } catch {
    return [];
  }
}

function readTurnUsage(db, sessionId) {
  const result = { replies: [], tokens: emptyTokens(), completed: 0, aggregateOnly: null,
    aggregateOnlyTurns: 0, available: false, issues: [] };
  if (!db) { result.issues.push("unreadable_database"); return result; }
  const operations = new Map(), legacy = emptyTokens();
  let rows;
  try {
    rows = db.prepare("select rowid as row_key, input_tokens, output_tokens, usage_json, status from turns where session_id = ? order by rowid").all(sessionId);
  } catch { result.issues.push("unreadable_database"); return result; }
  result.available = true;
  for (const row of rows) {
    if (row.status === "completed") result.completed += 1;
    let usage;
    try { usage = typeof row.usage_json === "string" ? JSON.parse(row.usage_json) : row.usage_json; }
    catch { result.issues.push("malformed_database_usage"); continue; }
    const aggregate = measuredTokens(usage) ||
      (n(row.input_tokens) || n(row.output_tokens) ? toTokens({ inputTokens: row.input_tokens, outputTokens: row.output_tokens }) : null);
    const atomic = Array.isArray(usage?.operations) && usage.operations.length ? usage.operations : identity(usage?.operationId) ? [usage] : [];
    const turnRecords = new Map();
    for (const part of atomic) {
      const operationId = identity(part?.operationId), tokens = measuredTokens(part);
      if (!operationId || !tokens) { result.issues.push("malformed_database_usage"); continue; }
      const record = { id: "", key: operationKey(operationId), operationId, agentId: "unknown", source: "database",
        createdAt: null, durationMs: null, modelId: identity(part.modelId) || "unknown", providerId: identity(part.providerId), tokens };
      mergeReply(operations, record, result.issues);
      mergeReply(turnRecords, record, result.issues);
    }
    if (aggregate && !turnRecords.size) {
      addTokens(legacy, aggregate); result.aggregateOnlyTurns += 1;
      result.issues.push("aggregate_only_usage");
    } else if (aggregate && aggregate.total > sumReplies([...turnRecords.values()]).totals.total) {
      // The aggregate can contain legacy/unattributed counts. Do not fabricate
      // another reply or add the aggregate on top of its operations.
      result.issues.push("aggregate_remainder");
    }
  }
  result.replies = [...operations.values()];
  result.tokens = addTokens(sumReplies(result.replies).totals, legacy);
  if (result.aggregateOnlyTurns) result.aggregateOnly = legacy;
  result.issues = [...new Set(result.issues)];
  return result;
}

function mergeUsageSources(parsed, turns, queued = null, checkpoint = null) {
  const sources = [parsed, queued, checkpoint, turns].filter(Boolean);
  const normalized = normalizeUsageAgents({ ...parsed,
    agents: sources.flatMap(source => source.agents || []),
    replies: [...turns.replies, ...(checkpoint?.replies || []), ...(queued?.replies || []), ...parsed.replies],
    missingUsage: new Set(sources.flatMap(source => [...(source.missingUsage || [])])),
    pendingUsage: new Set(sources.flatMap(source => [...(source.pendingUsage || [])])) });
  const issues = sources.flatMap(source => source.issues), records = new Map();
  for (const row of normalized.replies) mergeReply(records, row, issues);
  return { ...normalized, replies: [...records.values()], issues: [...new Set(issues)], aggregateOnly: turns.aggregateOnly };
}

function metricsOf(tokens) {
  const prompt = promptTokens(tokens);
  return {
    ...tokens,
    prompt,
    hitRate: hitRate(tokens),
    uncachedRate: prompt ? n(tokens.input) / prompt : null,
  };
}

function retainKnownSource(previous, next) {
  if (!previous || !next.issues.some(code => ["missing_transcript", "unreadable_transcript", "session_identity_mismatch", "malformed_records", "unreadable_database", "malformed_database_usage"].includes(code))) return next;
  const issues = [...next.issues, "retained_usage"], records = new Map();
  for (const row of [...previous.replies, ...next.replies]) mergeReply(records, row, issues);
  const retained = { ...previous, ...next, replies: [...records.values()], issues: [...new Set(issues)] };
  if (previous.agents) retained.agents = [...new Map([...previous.agents, ...next.agents].map(row => [row.id, row])).values()];
  if ("available" in next) {
    retained.aggregateOnly = next.aggregateOnly || previous.aggregateOnly;
    retained.tokens = addTokens(sumReplies(retained.replies).totals, retained.aggregateOnly);
    if (!next.available) retained.completed = previous.completed;
  }
  return retained;
}

async function appearance() {
  try {
    if (typeof pi.app?.getAppearance === "function") return await pi.app.getAppearance();
  } catch {
    /* ignore */
  }
  return null;
}

async function hostLocale(look) {
  const candidates = [];
  try {
    if (typeof pi.app?.getLocale === "function") {
      candidates.push(await pi.app.getLocale());
    }
  } catch {
    /* ignore */
  }
  try {
    const appearanceLook = look || (await appearance());
    candidates.push(appearanceLook?.locale, appearanceLook?.language);
  } catch {
    /* ignore */
  }
  const mapped = candidates.map(localeFromRaw).filter(Boolean);
  if (mapped.includes("zh-CN")) return "zh-CN";
  return mapped[0] || "zh-CN";
}

async function buildReport(sessionId, context, known = null) {
  const dataPath = await pi.plugin.getDataPath();
  const hostRoot = hostRootFromDataPath(dataPath);
  const sessionsDir = path.join(hostRoot, "sessions");
  const dbFile = path.join(hostRoot, "pi.sqlite");
  const db = existsSync(dbFile) ? openHostDb(dbFile) : null;
  try {
    sessionId = validateSessionId(sessionId, true);
    const look = await appearance();
    const locale = await hostLocale(look);
    const running = readRunningSessionIds(db);
    const untitled = isZh(locale) ? "未命名会话" : "Untitled session";
    const recentSessions = readRecentSessionRows(db, 16).map((row) => ({
      id: String(row.id),
      shortId: shortId(row.id),
      title: row.title || untitled,
      modelId: String(row.model_id || ""),
      running: running.has(String(row.id)),
    }));
    if (!sessionId) {
      return {
        ok: false,
        locale,
        recentSessions,
        error: contextError(context.status, locale),
      };
    }
    const file = path.join(sessionsDir, `${sessionId}.jsonl`);
    const actualParsed = parseJsonlUsage(file, sessionId);
    const actualTurns = readTurnUsage(db, sessionId);
    const parsed = retainKnownSource(known?.transcript, actualParsed);
    const turns = retainKnownSource(known?.database, actualTurns);
    const queued = retainQueuedUsage(known?.queue, readQueuedUsage(path.join(hostRoot, "session-message-outbox.json"), sessionId));
    const checkpoint = retainQueuedUsage(known?.checkpoint,
      readCompletedCheckpoint(path.join(sessionsDir, `${sessionId}.inflight.json`), sessionId));
    const merged = mergeUsageSources(parsed, turns, queued, checkpoint);
    const order = new Map((known?.historyKeys || []).map((key, index) => [key, index]));
    merged.replies.sort((a, b) => (order.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.key) ?? Number.MAX_SAFE_INTEGER));
    const parentRunning = db ? running.has(sessionId) : !!known?.parentRunning;
    const scopes = buildUsageScopes(merged, parentRunning);
    const combined = scopes[0];
    // Reconcile the same deduplicated records, never infer ownership from a
    // model, timestamp or a turn aggregate. Null counts mean not recorded.
    const unknownReplies = merged.replies.filter(row => row.agentId === "unknown");
    const summaryOnly = !!combined.summaryOnly;
    const partition = scope => ({ replies: summaryOnly ? null : scope.replies, totals: scope.totals });
    const reconciliation = {
      summaryOnly, all: partition(combined), main: partition(scopes[1]), subagents: partition(scopes[2]),
      unknown: { replies: summaryOnly ? null : unknownReplies.length,
        totals: summaryOnly ? combined.totals : metricsOf(sumReplies(unknownReplies).totals) },
    };
    const session = readSessionRow(db, sessionId) || known?.session;
    if (!session && parsed.missing && !combined.hasTotals) {
      return { ok: false, locale, recentSessions, error: isZh(locale)
        ? "当前会话没有可读取的本地用量。" : "This session has no readable local usage." };
    }
    if (known) Object.assign(known, { transcript: parsed, database: turns, queue: queued, checkpoint,
      historyKeys: merged.replies.map(row => row.key), session, parentRunning });
    const { history, last } = combined;
    if (!recentSessions.some((row) => row.id === sessionId)) {
      recentSessions.unshift({
        id: sessionId,
        shortId: shortId(sessionId),
        title: session?.title || untitled,
        modelId: String(session?.model_id || last?.modelId || ""),
        running: running.has(sessionId),
      });
    }
    return {
      ok: true,
      locale,
      generatedAt: new Date().toISOString(),
      session: {
        id: sessionId,
        shortId: shortId(sessionId),
        title: session?.title || untitled,
        modelId: session?.model_id || last?.modelId || "",
        thinkingLevel: String(session?.thinking_level || "").trim(),
        updatedAt: session?.updated_at || null,
        running: parentRunning,
      },
      replies: combined.replies,
      compactCount: parsed.compactCount,
      malformed: parsed.malformed,
      missingTranscript: parsed.missing,
      complete: combined.complete,
      unavailable: combined.unavailable,
      issues: combined.issues,
      hasTotals: combined.hasTotals,
      summaryOnly: !!combined.summaryOnly,
      sourceCoverage: { transcript: !actualParsed.missing, database: actualTurns.available,
        queueOperations: queued.replies.length, checkpointOperations: checkpoint.replies.length,
        databaseOperations: turns.replies.length, unknownRecords: merged.replies.filter(row => row.agentId === "unknown").length,
        aggregateOnlyTurns: turns.aggregateOnlyTurns },
      scopes,
      reconciliation,
      totals: combined.totals,
      history,
      last,
      byModel: combined.byModel,
      recentSessions,
      turns: {
        completed: turns.completed,
        tokens: metricsOf(turns.tokens),
      },
    };
  } finally {
    closeQuietly(db);
  }
}

function lineFor(tokens, locale) {
  const hit = formatPct(tokens.hitRate, locale);
  const created = n(tokens.cacheWrite);
  if (isZh(locale)) {
    const extra = created ? ` · 缓存创建 ${formatCompact(created)}` : "";
    return `输入 ${formatCompact(tokens.input)} · 缓存命中 ${formatCompact(tokens.cacheRead)}（${hit}）${extra} · 输出 ${formatCompact(tokens.output)}`;
  }
  const extra = created ? ` · create ${formatCompact(created)}` : "";
  return `in ${formatCompact(tokens.input)} · cache ${formatCompact(tokens.cacheRead)} (${hit})${extra} · out ${formatCompact(tokens.output)}`;
}

function toastFor(report) {
  if (!report.ok) return report.error;
  const head = isZh(report.locale) ? "当前会话" : "This session";
  return `${head} · ${lineFor(report.totals, report.locale)}`;
}

function markdownFor(report) {
  if (!report.ok) return report.error;
  const zh = isZh(report.locale);
  const t = report.totals;
  const lines = [];
  lines.push(zh ? `## 会话用量` : `## Session usage`);
  lines.push("");
  lines.push(zh ? `- 会话：${report.session.title} (\`${report.session.shortId}\`)` : `- Session: ${report.session.title} (\`${report.session.shortId}\`)`);
  if (report.session.modelId) {
    lines.push(zh ? `- 模型：${report.session.modelId}` : `- Model: ${report.session.modelId}`);
  }
  lines.push(zh ? `- 助手回复：${report.replies}次` : `- Assistant replies: ${report.replies}`);
  if (report.compactCount) {
    lines.push(zh ? `- 压缩次数：${report.compactCount}` : `- Compactions: ${report.compactCount}`);
  }
  lines.push("");
  lines.push(zh ? `| 类型 | Token |` : `| Kind | Tokens |`);
  lines.push(`| --- | ---: |`);
  lines.push(`${zh ? "输入（未命中）" : "Input (uncached)"} | ${formatInt(t.input, report.locale)} |`);
  lines.push(`${zh ? "缓存命中" : "Cache read"} | ${formatInt(t.cacheRead, report.locale)} |`);
  lines.push(`${zh ? "缓存创建" : "Cache create"} | ${formatInt(t.cacheWrite, report.locale)} |`);
  if (n(t.cacheWrite5m) || n(t.cacheWrite1h)) {
    lines.push(`${zh ? "缓存创建 5m" : "Cache create 5m"} | ${formatInt(t.cacheWrite5m, report.locale)} |`);
    lines.push(`${zh ? "缓存创建 1h" : "Cache create 1h"} | ${formatInt(t.cacheWrite1h, report.locale)} |`);
  }
  lines.push(`${zh ? "提示词合计" : "Prompt total"} | ${formatInt(t.prompt, report.locale)} |`);
  lines.push(`${zh ? "输出" : "Output"} | ${formatInt(t.output, report.locale)} |`);
  lines.push(`${zh ? "思考" : "Reasoning"} | ${formatInt(t.reasoning, report.locale)} |`);
  lines.push(`${zh ? "命中率" : "Hit rate"} | ${formatPct(t.hitRate, report.locale)} |`);
  if (report.last) {
    lines.push("");
    lines.push(zh ? `最近一轮：${lineFor(report.last.tokens, report.locale)}` : `Last reply: ${lineFor(report.last.tokens, report.locale)}`);
  }
  if (report.byModel.length > 1) {
    lines.push("");
    lines.push(zh ? `按模型：` : `By model:`);
    for (const row of report.byModel) {
      lines.push(`- ${row.modelId} · ${row.replies}${zh ? "次" : " turns"} · ${lineFor(row.tokens, report.locale)}`);
    }
  }
  lines.push("");
  lines.push(
    zh
      ? "命中率 = 缓存命中 /（未命中输入 + 缓存命中 + 缓存创建）。Claude 的 cache_creation 会计入缓存创建。"
      : "Hit rate = cache read / (uncached input + cache read + cache create). Claude cache_creation counts as create.",
  );
  return lines.join("\n");
}

function validateSessionId(value, allowEmpty = false) {
  if (allowEmpty && (value === "" || value == null)) return "";
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || value.includes("..")) {
    throw Object.assign(new Error("invalid session identity"), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function contextError(status, locale) {
  const zh = isZh(locale);
  if (status === "none") return zh ? "请在主界面打开一个会话。" : "Open a conversation in the main window.";
  if (status === "ambiguous") return zh ? "当前会话标记不明确，请重新选择对话。" : "Ambiguous session markers. Select the conversation again.";
  if (status === "unavailable") return zh ? "无法识别当前会话，请确认 PI-Desktop ≥ 0.17.0 或手动选择会话。" : "Cannot identify the current session. Check PI-Desktop ≥ 0.17.0 or select a session manually.";
  return zh ? "等待主界面会话识别。请重新加载插件并确认 renderer.extension 权限。" : "Waiting for the main-window extension. Reload the plugin and grant renderer.extension.";
}

let hostContext = { sessionId: "", status: "waiting" };
let manualSessionId = "";
let revision = 0;
let rendererInstance = "";
let rendererSequence = 0;
const retiredInstances = new Set();
let lastReport = null;
let reportQueue = Promise.resolve();
let usageWatchers = [];
let usagePollTimer = null;
let knownSources = {};
let changeTimer = null;
const completionCaches = new Map();
let loadedVersion = "";
let watchError = "";
let running = false;
let usageVersion = 0;
const usageWaiters = new Set();
function announceUsageChange() {
  usageVersion += 1;
  for (const finish of [...usageWaiters]) finish(true);
}
function waitForUsage(after) {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid usage version");
  const result = changed => ({ changed, version: usageVersion, context: selectionContext() });
  if (!running || after !== usageVersion) return Promise.resolve(result(true));
  if (usageWaiters.size >= 8) throw new Error("too many usage subscribers");
  return new Promise(resolve => {
    const finish = changed => { clearTimeout(timer); usageWaiters.delete(finish); resolve(result(changed)); };
    const timer = setTimeout(() => finish(false), 20000); // below the host's 30s panel RPC limit
    usageWaiters.add(finish);
  });
}

function selectionContext() {
  return {
    revision,
    mode: manualSessionId ? "fixed" : "follow",
    sessionId: manualSessionId || hostContext.sessionId,
    status: manualSessionId ? "active" : hostContext.status,
    activeSessionId: hostContext.sessionId,
  };
}

function invalidate() {
  revision += 1; lastReport = null; knownSources = {};
  if (changeTimer !== null) clearTimeout(changeTimer);
  changeTimer = null;
  announceUsageChange();
}
function reportSignature(report) {
  return JSON.stringify({ ...report, generatedAt: undefined });
}
function scheduleUsageChange(filename) {
  const snapshot = selectionContext();
  if (!running || !snapshot.sessionId || (filename != null &&
      ![`${snapshot.sessionId}.jsonl`, `${snapshot.sessionId}.inflight.json`].includes(String(filename)))) return;
  if (changeTimer !== null) return;
  // Fixed, short batching window: continuous stream writes cannot postpone completion.
  changeTimer = setTimeout(() => {
    changeTimer = null;
    if (current(snapshot)) void refreshReport(true).catch(() => {});
  }, 25);
}
function usageSourceStamp(root, sessionId) {
  if (!sessionId) return "";
  const files = [path.join(root, "sessions", `${sessionId}.jsonl`), path.join(root, "sessions", `${sessionId}.inflight.json`),
    ...["pi.sqlite", "pi.sqlite-wal", "session-message-outbox.json"].map(file => path.join(root, file))];
  return JSON.stringify([sessionId, ...files.map(file => {
    try { const stat = statSync(file); return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]; }
    catch (error) { return error.code || "unavailable"; }
  })]);
}
async function startUsageWatcher() {
  for (const watcher of usageWatchers) watcher.close();
  usageWatchers = []; watchError = "";
  if (usagePollTimer !== null) clearTimeout(usagePollTimer);
  const root = hostRootFromDataPath(await pi.plugin.getDataPath());
  const addWatch = (dir, changed) => {
    try {
      const watcher = watch(dir, changed);
      watcher.on("error", () => { watchError = "watch_unavailable"; scheduleUsageChange(null); });
      usageWatchers.push(watcher);
    } catch { watchError = "watch_unavailable"; }
  };
  // Directory watches survive creation and atomic replacement. SQLite commits
  // can change only the WAL; exclude SHM to avoid notifications from readers.
  addWatch(path.join(root, "sessions"), (_event, filename) => scheduleUsageChange(filename));
  addWatch(root, (_event, filename) => {
    if (filename == null || ["pi.sqlite", "pi.sqlite-wal", "session-message-outbox.json"].includes(String(filename))) scheduleUsageChange(null);
  });
  let stamp = usageSourceStamp(root, selectionContext().sessionId);
  const poll = () => {
    if (!running) return;
    const next = usageSourceStamp(root, selectionContext().sessionId);
    if (next !== stamp) { stamp = next; scheduleUsageChange(null); }
    // Stat only: recover missed/unavailable OS watch notifications without
    // repeatedly scanning transcript/queue bodies or the database when idle.
    usagePollTimer = setTimeout(poll, 750);
  };
  usagePollTimer = setTimeout(poll, 750);
}
function staleReport() { return { ok: false, stale: true, context: selectionContext() }; }
function current(snapshot) { return running && snapshot.revision === revision; }

// Builds and settings writes are serialized. Identity changes invalidate old
// work immediately, including a background refresh; they never wait for scans.
function refreshReport(force = false) {
  const snapshot = selectionContext();
  const task = reportQueue.catch(() => {}).then(async () => {
    if (!current(snapshot)) return staleReport();
    if (!force && lastReport?.context.revision === snapshot.revision) return lastReport;
    if (!knownSources.checkpoint && completionCaches.has(snapshot.sessionId)) {
      knownSources.checkpoint = restoreCompletedCheckpoints(completionCaches.get(snapshot.sessionId), snapshot.sessionId);
    }
    const report = { ...await buildReport(snapshot.sessionId, snapshot, knownSources), context: snapshot,
      pluginVersion: loadedVersion, updateError: watchError };
    if (!current(snapshot)) return staleReport();
    if (lastReport && reportSignature(report) === reportSignature(lastReport)) return lastReport;
    if (snapshot.sessionId && knownSources.checkpoint?.replies.length) {
      completionCaches.delete(snapshot.sessionId);
      completionCaches.set(snapshot.sessionId, { schema: 1, sessionId: snapshot.sessionId,
        replies: knownSources.checkpoint.replies });
      // Keep the last sixteen explicitly viewed conversations, not every session.
      while (completionCaches.size > 16) completionCaches.delete(completionCaches.keys().next().value);
    }
    await pi.plugin.setSettings({ lastReport: report, completionCaches: [...completionCaches.values()] });
    if (!current(snapshot)) return staleReport();
    lastReport = report;
    announceUsageChange();
    return report;
  });
  reportQueue = task.catch(() => {});
  return task;
}

async function showUsage() {
  if (manualSessionId) { manualSessionId = ""; invalidate(); }
  const report = await refreshReport(true);
  if (report.stale) return report;
  try {
    const hint = isZh(report.locale) ? "右侧工作面板菜单 → 会话用量" : "Right work panel menu → Session Usage";
    await pi.ui.showToast(`${toastFor(report)}\n${hint}`);
  } catch { /* toast is optional */ }
  return report;
}

async function onLoad() {
  running = true;
  try { loadedVersion = identity((await pi.plugin.getManifest?.())?.version); }
  catch { loadedVersion = ""; }
  await pi.commands.register({
    id: "sessionUsage.refresh", title: "Usage: current session",
    keywords: ["usage", "token", "cache", "用量", "缓存"], category: "Session",
    run: showUsage,
  });
  // Never trust a report persisted by an earlier load's selected conversation.
  try {
    const settings = await pi.plugin.getSettings?.();
    const caches = settings?.completionCaches || (settings?.completionCache ? [settings.completionCache] : []);
    if (Array.isArray(caches)) for (const cache of caches.slice(-16)) {
      const sessionId = validateSessionId(cache?.sessionId);
      const restored = restoreCompletedCheckpoints(cache, sessionId);
      if (restored.replies.length) completionCaches.set(sessionId, { schema: 1, sessionId, replies: restored.replies });
    }
  } catch { /* untrusted/malformed saved metadata is not a usage source */ }
  await startUsageWatcher();
  await refreshReport().catch(() => {});
}

function onRendererCall(method, args) {
  if (method !== "usage.setContext" || !running) throw new Error("unsupported renderer call");
  const { instance, sequence, status } = args || {};
  const sessionId = validateSessionId(args?.sessionId, status !== "active");
  if (typeof instance !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(instance) ||
      !Number.isSafeInteger(sequence) || sequence < 1 ||
      !["active", "none", "ambiguous", "unavailable"].includes(status) ||
      (status !== "active" && sessionId !== "")) {
    throw Object.assign(new Error("invalid session context"), { code: "INVALID_ARGUMENT" });
  }
  if (retiredInstances.has(instance) || (instance === rendererInstance && sequence < rendererSequence)) {
    return { accepted: false, context: selectionContext() };
  }
  if (instance !== rendererInstance) {
    if (rendererInstance) retiredInstances.add(rendererInstance);
    rendererInstance = instance;
    rendererSequence = 0;
  }
  if (sequence === rendererSequence) return { accepted: true, context: selectionContext() };
  rendererSequence = sequence;
  const changed = hostContext.sessionId !== sessionId || hostContext.status !== status;
  hostContext = { sessionId, status };
  if (changed && !manualSessionId) {
    invalidate();
    // Acknowledge immediately; transcript scanning must not block the 2s relay.
    void refreshReport(true).catch(() => {});
  }
  return { accepted: true, context: selectionContext() };
}

async function onPanelInvoke(channel, payload) {
  if (channel === "usage.watch") return waitForUsage(payload?.after);
  if (channel === "usage.context") return selectionContext();
  if (channel === "usage.refresh" || channel === "usage.get") {
    if (channel === "usage.refresh") {
      if (payload?.follow === true && manualSessionId) { manualSessionId = ""; invalidate(); }
      if (payload?.sessionId) {
        const selected = validateSessionId(payload.sessionId);
        if (manualSessionId !== selected) { manualSessionId = selected; invalidate(); }
      }
    }
    return refreshReport(channel === "usage.refresh");
  }
  return { ok: false, error: `unknown channel: ${channel}` };
}

async function onUnload() {
  running = false;
  invalidate();
  if (usagePollTimer !== null) clearTimeout(usagePollTimer);
  usagePollTimer = null;
  for (const watcher of usageWatchers) watcher.close();
  usageWatchers = [];
  watchError = "";
  completionCaches.clear();
  hostContext = { sessionId: "", status: "waiting" };
  manualSessionId = "";
  rendererInstance = "";
  rendererSequence = 0;
  retiredInstances.clear();
  try { await pi.commands.unregister("usage"); } catch { /* ignore */ }
}

module.exports = { onLoad, onUnload, onPanelInvoke, onRendererCall };
