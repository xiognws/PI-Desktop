"use strict";

/**
 * Read-only enrichment through the host's desktop control catalogue.
 *
 * The desktop side of the data references a provider by catalogue id (a UUID)
 * and never stores a project path, so the panel would show `3f9e919b` and
 * "unassigned" without this. Three read-only operations are used:
 *
 *   providers/list → provider id → display name
 *   session/list   → session id → project id / project path
 *   project/list   → project id → path + name
 *
 * Everything here is optional: the host may not expose the catalogue, an
 * operation may be refused, or the payload shape may differ. The result is
 * cached for a few minutes and carries its own diagnostics; a failure never
 * removes a single usage record — it only leaves placeholders on screen.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const ENRICH_TTL_MS = 10 * 60 * 1000;
const CACHE_SCHEMA = 1;
const OPS = ["providers/list", "session/list", "project/list"];

/** @returns {any} an empty, "unavailable" enrichment result */
function emptyResult(reason) {
  return {
    available: false,
    providers: {},
    sessions: {},
    projects: {},
    updatedAt: 0,
    diagnostics: { reason, ops: [], errors: [] },
  };
}

/**
 * Rows may be returned bare, or wrapped in the first of several conventional
 * collection keys. Rather than guessing one, accept all of them.
 *
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {Array<Record<string, any>>}
 */
function asRows(value, keys) {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === "object");
  if (!value || typeof value !== "object") return [];
  const record = /** @type {Record<string, any>} */ (value);
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key].filter((row) => row && typeof row === "object");
  }
  return [];
}

/** @param {...unknown} values */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/**
 * @param {Array<Record<string, any>>} rows
 * @returns {Record<string, string>}
 */
function normalizeProviders(rows) {
  /** @type {Record<string, string>} */
  const providers = {};
  for (const row of rows) {
    const id = firstString(row.id, row.providerId, row.vendorId);
    const name = firstString(row.name, row.label, row.displayName);
    if (id && name) providers[id] = name;
  }
  return providers;
}

/**
 * @param {Array<Record<string, any>>} rows
 * @returns {Record<string, string>}
 */
function normalizeProjects(rows) {
  /** @type {Record<string, string>} */
  const projects = {};
  for (const row of rows) {
    const id = firstString(row.id, row.projectId);
    const projectPath = firstString(row.path, row.projectPath, row.root, row.workspacePath);
    if (id && projectPath) projects[id] = projectPath;
  }
  return projects;
}

/**
 * @param {Array<Record<string, any>>} rows
 * @param {Record<string, string>} projects
 * @returns {Record<string, { projectPath: string | null, projectId: string | null }>}
 */
function normalizeSessions(rows, projects) {
  /** @type {Record<string, { projectPath: string | null, projectId: string | null }>} */
  const sessions = {};
  for (const row of rows) {
    const id = firstString(row.id, row.sessionId);
    if (!id) continue;
    const projectId = firstString(row.projectId, row.project_id);
    const directPath = firstString(row.projectPath, row.workspacePath, row.cwd, row.path);
    const resolved = directPath || (projectId ? projects[projectId] ?? "" : "");
    sessions[id] = { projectPath: resolved || null, projectId: projectId || null };
  }
  return sessions;
}

/**
 * @param {{ pi?: any, cacheDir: string, ttlMs?: number, now?: number, force?: boolean }} options
 * @returns {Promise<ReturnType<typeof emptyResult>>}
 */
async function loadEnrichment({ pi, cacheDir, ttlMs = ENRICH_TTL_MS, now = Date.now(), force = false }) {
  const cachePath = path.join(cacheDir, "enrich.json");
  let cached = null;
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (parsed && parsed.schema === CACHE_SCHEMA) cached = parsed;
  } catch {
    cached = null;
  }
  if (!force && cached && typeof cached.updatedAt === "number" && now - cached.updatedAt < ttlMs) {
    return cached;
  }

  const invoke = pi && pi.desktop && typeof pi.desktop.invoke === "function" ? pi.desktop.invoke : null;
  if (!invoke) {
    const unavailable = emptyResult("desktop.control is not available in this host");
    if (cached) unavailable.diagnostics.reason = "desktop.control is not available in this host";
    return unavailable;
  }

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const opsSeen = [];
  try {
    const listed = await pi.desktop.listOperations();
    if (Array.isArray(listed)) {
      for (const operation of listed) {
        if (operation && typeof operation.id === "string") opsSeen.push(operation.id);
      }
    }
  } catch (error) {
    errors.push(`listOperations: ${error instanceof Error ? error.message : String(error)}`);
  }

  /**
   * @param {string} operation
   * @returns {Promise<unknown>}
   */
  const call = async (operation) => {
    try {
      return await invoke({ operation, args: [] });
    } catch (error) {
      errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  if (opsSeen.length > 0) {
    for (const operation of OPS) {
      if (!opsSeen.includes(operation)) {
        errors.push(`${operation}: not offered by this host`);
      }
    }
  }

  const [providersRaw, sessionsRaw, projectsRaw] = await Promise.all([
    call("providers/list"),
    call("session/list"),
    call("project/list"),
  ]);

  const providers = normalizeProviders(asRows(providersRaw, ["providers", "items", "data", "rows"]));
  const projects = normalizeProjects(asRows(projectsRaw, ["projects", "items", "data", "rows"]));
  const sessions = normalizeSessions(
    asRows(sessionsRaw, ["sessions", "items", "data", "rows"]),
    projects,
  );

  const result = {
    available: Object.keys(providers).length > 0 || Object.keys(sessions).length > 0,
    providers,
    sessions,
    projects,
    updatedAt: now,
    diagnostics: { reason: "", ops: opsSeen, errors },
  };

  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const temporary = path.join(cacheDir, `.enrich.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify({ schema: CACHE_SCHEMA, ...result })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, cachePath);
  } catch {
    // A cache write failure only costs a repeat lookup next time.
  }

  return result;
}

module.exports = {
  ENRICH_TTL_MS,
  OPS,
  asRows,
  normalizeProviders,
  normalizeProjects,
  normalizeSessions,
  loadEnrichment,
};
