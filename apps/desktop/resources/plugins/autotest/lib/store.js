'use strict';
/**
 * Plan persistence. A plan is a directory with one state.json plus append-only
 * artifact directories, so a reviewer can inspect every intermediate product
 * without opening the database.
 */

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./schema');

const STATE_FILE = 'state.json';

function nowIso() {
  return new Date().toISOString();
}

/**
 * A readable plan id prefix.
 *
 * The plan id is also a directory name, so it has to survive arbitrary titles.
 * Alphanumeric runs are kept and everything else folds to a dash — but a title
 * that carries a measurement ("-40C to 85C", "3.5V") would otherwise produce
 * `40c-85c`, i.e. digits from inside the numbers rather than words. Only runs
 * that start with a letter are kept, so a unit or a temperature never becomes
 * the plan's name.
 */
function slug(value) {
  const runs = String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(function (run) {
      return run.length > 0 && /^[a-z]/.test(run);
    });
  const text = runs.join('-').slice(0, 40).replace(/-+$/g, '');
  return text || 'plan';
}

function newPlanId(title) {
  const stamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
  return slug(title) + '-' + stamp;
}

/** Create the on-disk layout for one plan. */
function createPlan(root, input) {
  const id = newPlanId(input && input.title);
  const dir = path.join(root, 'plans', id);
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  const state = {
    version: 1,
    id,
    title: (input && input.title) || 'Untitled plan',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    activeStage: schema.STAGES[0],
    status: 'draft',
    source: {
      kind: (input && input.source && input.source.kind) || 'text',
      ref: (input && input.source && input.source.ref) || null,
      text: (input && input.source && input.source.text) || '',
    },
    stages: schema.STAGES.reduce(function (acc, stage) {
      acc[stage] = { status: 'idle', updatedAt: null, artifactId: null, note: null };
      return acc;
    }, {}),
    requirements: [],
    features: [],
    cases: [],
    scripts: [],
    runs: [],
    verdicts: [],
    approvals: [],
    notes: [],
    // Knowledge-base entries this plan cites. Empty on every plan that predates
    // the knowledge base; lib/plan.js owns the attach/detach writes.
    knowledgeRefs: [],
  };
  writeState(dir, state);
  return { dir: dir, state: state };
}

function planDir(root, planId) {
  if (!planId || String(planId).indexOf('..') !== -1 || !/^[a-z0-9._-]+$/.test(String(planId))) {
    const error = new Error('invalid plan id: ' + String(planId));
    error.code = 'PLAN_ID_INVALID';
    throw error;
  }
  return path.join(root, 'plans', String(planId));
}

/**
 * The plugin data root behind a context bag.
 *
 * The plan store only ever gets a string root, but a sibling store (the
 * knowledge base) needs the same answer from the same kind of ctx, and a second
 * implementation of "where does plugin data live" is how two readers end up on
 * two different directories. Keep it beside planDir, with the same contract:
 * dataDir when the caller already resolved it, otherwise the host api.
 */
function dataRootLike(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    const bare = new Error('a data context with dataDir or a host api is required');
    bare.code = 'DATA_PATH_MISSING';
    throw bare;
  }
  if (ctx.dataDir) return path.resolve(ctx.dataDir);
  const pi = ctx.pi;
  const base = pi && pi.plugin && pi.plugin.getDataPath ? pi.plugin.getDataPath() : null;
  if (typeof base === 'string') return path.resolve(path.join(base, 'autotest'));
  if (base && typeof base.then === 'function') {
    const error = new Error('plugin data path is asynchronous; resolve it before building a root');
    error.code = 'DATA_PATH_ASYNC';
    throw error;
  }
  const missing = new Error('the host api exposes no plugin data path');
  missing.code = 'DATA_PATH_MISSING';
  throw missing;
}

function readState(dir) {
  const file = path.join(dir, STATE_FILE);
  if (!fs.existsSync(file)) {
    const error = new Error('plan not found: ' + dir);
    error.code = 'PLAN_NOT_FOUND';
    throw error;
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.stages = parsed.stages || {};
  schema.STAGES.forEach(function (stage) {
    parsed.stages[stage] = parsed.stages[stage] || { status: 'idle', updatedAt: null, artifactId: null, note: null };
  });
  ['requirements', 'features', 'cases', 'scripts', 'runs', 'verdicts', 'approvals', 'notes', 'knowledgeRefs'].forEach(function (key) {
    parsed[key] = Array.isArray(parsed[key]) ? parsed[key] : [];
  });
  return parsed;
}

function writeState(dir, state) {
  state.updatedAt = nowIso();
  const file = path.join(dir, STATE_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return state;
}

/**
 * Persist one artifact under artifacts/<stage>-<ordinal>.json and return its
 * relative id so downstream stages can cite the exact document they consumed.
 */
function saveArtifact(dir, stage, payload) {
  const existing = fs.existsSync(path.join(dir, 'artifacts'))
    ? fs.readdirSync(path.join(dir, 'artifacts')).filter(function (name) {
        return name.indexOf(stage + '-') === 0;
      })
    : [];
  const ordinal = existing.length + 1;
  const artifactId = stage + '-' + String(ordinal).padStart(2, '0');
  const file = path.join(dir, 'artifacts', artifactId + '.json');
  fs.writeFileSync(file, JSON.stringify({ stage: stage, at: nowIso(), payload: payload }, null, 2), 'utf8');
  return artifactId;
}

function readArtifact(dir, artifactId) {
  const file = path.join(dir, 'artifacts', String(artifactId) + '.json');
  if (!fs.existsSync(file)) {
    const error = new Error('artifact not found: ' + String(artifactId));
    error.code = 'ARTIFACT_NOT_FOUND';
    throw error;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listArtifacts(dir) {
  const root = path.join(dir, 'artifacts');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().map(function (name) {
    return { id: name.replace(/\.json$/, ''), bytes: fs.statSync(path.join(root, name)).size };
  });
}

function setStage(dir, state, stage, patch) {
  if (!schema.isStage(stage)) {
    const error = new Error('unknown stage: ' + String(stage));
    error.code = 'STAGE_UNKNOWN';
    throw error;
  }
  const current = state.stages[stage];
  state.stages[stage] = Object.assign({}, current, patch, { updatedAt: nowIso() });
  if (patch && patch.status === 'running') state.activeStage = stage;
  writeState(dir, state);
  return state.stages[stage];
}

function listPlans(root) {
  const dir = path.join(root, 'plans');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(function (name) {
      return fs.existsSync(path.join(dir, name, STATE_FILE));
    })
    .map(function (name) {
      try {
        const state = readState(path.join(dir, name));
        return {
          id: state.id,
          title: state.title,
          status: state.status,
          activeStage: state.activeStage,
          updatedAt: state.updatedAt,
          cases: state.cases.length,
          runs: state.runs.length,
        };
      } catch (error) {
        return { id: name, title: name, status: 'corrupt', activeStage: null, updatedAt: null, cases: 0, runs: 0 };
      }
    })
    .sort(function (a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
}

module.exports = {
  STATE_FILE,
  nowIso,
  slug,
  newPlanId,
  createPlan,
  planDir,
  dataRootLike,
  readState,
  writeState,
  saveArtifact,
  readArtifact,
  listArtifacts,
  setStage,
  listPlans,
};
