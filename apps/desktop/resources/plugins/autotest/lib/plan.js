'use strict';
/**
 * Orchestration for the eight autotest tools.
 *
 * Every entry point receives the host execution context (which carries the
 * model key, the abort signal and the tool call id) plus the already-parsed
 * arguments, and returns a JSON-serialisable tool result. Nothing here talks to
 * the host directly except through the injected `pi` object, so the whole
 * surface is testable with a stub.
 */

const fs = require('node:fs');
const path = require('node:path');

const schema = require('./schema');
const store = require('./store');
const llm = require('./llm');
const runner = require('./runner');
const diagnose = require('./diagnose');
const stages = require('./stages');
const report = require('./report');

const PROMPTS = {
  requirement: [
    'You are a test analyst. Read the supplied product material and produce a feature breakdown.',
    'Rules: every feature must cite the requirement text it came from; list gaps where the requirement is ambiguous, unverifiable or contradictory; never invent acceptance criteria that the material does not support; keep titles short.',
  ].join('\n'),
  cases: [
    'You are a test designer. Turn an approved feature list into test cases.',
    'Rules: one case tests one behaviour; prefer behaviour-level cases over implementation steps; mark priority P0 only for data-loss, safety or security paths; state preconditions explicitly; expected results must be observable; do not restate the same check twice.',
  ].join('\n'),
  author: [
    'You are a test automation engineer. Write one runnable script per approved test case.',
    'Rules: no network access assumptions beyond what the case states; assert the expected result explicitly so a wrong product fails the script; never weaken an assertion to make a run pass; keep the script self-contained and print diagnostics on failure; no interactive input.',
    'For JavaScript, write CommonJS: use require() and module.exports, never import/export — the runner stores scripts as .cjs and executes them with plain Node.',
  ].join('\n'),
  diagnose: [
    'You are a test failure analyst. You receive deterministic classifications and run logs.',
    'Rules: never rewrite a script; explain the evidence; say plainly when the cause is the environment or the product; do not propose assertion weakening; if the evidence is insufficient, say so.',
  ].join('\n'),
};

function dataRoot(ctx) {
  // The context is a bag; a caller that hands over only the host api (or only a
  // dataDir) must not turn into a crash. Local state is addressed by dataDir
  // when the caller already resolved it, which is the normal path for every
  // tool and panel entry point in main.js.
  // dataDir wins outright: main.js resolved it once, through the same
  // realpath round-trip the host itself uses, so every reader in this process
  // compares identical strings. Deriving a second root from pi.plugin here is
  // what made a plan the panel had just listed answer PLAN_NOT_FOUND
  // (2026-11-08): Windows hands one caller the short ADMINI~1 spelling and
  // another the long Administrator spelling of the same directory.
  //
  // The rules themselves live in lib/store.js, next to planDir: the knowledge
  // base needs the same root from the same kind of ctx, and two copies of
  // "where does plugin data live" is how two readers end up on two directories.
  return store.dataRootLike(ctx);
}

function ensureRoot(root) {
  fs.mkdirSync(path.join(root, 'plans'), { recursive: true });
  return root;
}

/**
 * Await the plan root for callers that cannot keep a promise.
 *
 * getDataPath() on the host api answers a promise, so every reader that wants
 * a string path has to await it first. main.js already does that; a caller that
 * only has {pi} — a test, a renderer action, a future panel channel — would
 * otherwise walk into DATA_PATH_ASYNC for a directory that exists and is
 * readable. Resolving here keeps one answer for one question.
 */
async function resolveRooted(ctx) {
  if (ctx && typeof ctx === 'object' && ctx.dataDir) return dataRoot(ctx);
  const pi = ctx && ctx.pi;
  const reader = pi && pi.plugin && pi.plugin.getDataPath;
  if (typeof reader !== 'function') return dataRoot(ctx);
  const value = await Promise.resolve(reader.call(pi.plugin));
  if (typeof value !== 'string' || !value) return dataRoot(ctx);
  return dataRoot({ dataDir: path.join(value, 'autotest') });
}

function resolvePlan(ctx, args) {
  const root = ensureRoot(dataRoot(ctx));
  const planId = args && args.planId;
  if (!planId) {
    const error = new Error('planId is required; call autotest_requirement first to create a plan');
    error.code = 'PLAN_ID_REQUIRED';
    throw error;
  }
  const dir = store.planDir(root, planId);
  const state = store.readState(dir);
  return { root: root, dir: dir, state: state };
}

function modelOptions(ctx, purpose) {
  return {
    purpose: purpose,
    modelKey: ctx.modelKey || null,
    settings: ctx.settings || {},
    signal: ctx.signal,
  };
}

/** Run one model call for a stage, tagging a failure with the stage name. */
async function modelCall(stage, fn) {
  try {
    return await fn();
  } catch (error) {
    throw modelFailure(stage, error);
  }
}

/**
 * A model call may refuse before any artifact exists (the host answers
 * INVALID_ARGUMENT for a malformed modelKey, RATE_LIMITED, TIMEOUT, or a reply
 * that is not JSON). Left as a 500-style throw it looks like the stage died;
 * the plan is still empty, so say what actually happened and keep the rail at
 * `failed` instead of `running` forever.
 */
function modelFailure(stage, error) {
  const detail = (error && error.message) || String(error);
  const code = (error && error.code) || 'MODEL_CALL_FAILED';
  const wrapped = new Error(stage + ' stage model call failed (' + code + '): ' + detail);
  wrapped.code = code;
  wrapped.stage = stage;
  return wrapped;
}

function updateStage(dir, state, stage, patch) {
  store.setStage(dir, state, stage, patch);
  return state;
}

/**
 * Record a stage failure on the plan before rethrowing.
 *
 * A thrown error leaves the rail at `running` forever unless the stage is
 * marked: the card then shows a live spinner for a call that already died.
 * The catch wrapper is shared by every stage so the write happens once.
 */
function failStage(dir, state, stage, error) {
  if (!dir || !state) return;
  try {
    updateStage(dir, state, stage, {
      status: 'failed',
      note: (error && error.message ? String(error.message) : String(error)).slice(0, 300),
    });
    store.writeState(dir, state);
  } catch (ignored) {
    // The original failure is the diagnosis; a state write must not mask it.
  }
}

/** Run one stage body with the plan-side failure bookkeeping applied. */
function stageGuard(stage, ctx, args, body) {
  return async function run() {
    let dir = null;
    let state = null;
    try {
      if (args && args.planId) {
        const resolved = resolvePlan(ctx, args);
        dir = resolved.dir;
        state = resolved.state;
      }
      return await body(function capture(capturedDir, capturedState) {
        dir = capturedDir;
        state = capturedState;
      });
    } catch (error) {
      failStage(dir, state, stage, error);
      throw error;
    }
  }();
}

function touchPlan(state) {
  if (state.status === 'draft' || state.status === 'awaiting_review') return state;
  return state;
}

/* ---------------------------------------------------------------- requirement */

async function requirement(ctx, args) {
  const root = ensureRoot(dataRoot(ctx));
  // Fail fast and for free: a dead runtime is an environment problem, and it
  // must be found before any token is spent.
  const env = await stages.environmentGate(ctx.runtimes || {}, ctx.settings || {});
  if (!env.ok) {
    const error = new Error('environment gate failed: ' + env.reason);
    error.code = 'ENVIRONMENT_UNAVAILABLE';
    error.environment = env;
    throw error;
  }
  const options = modelOptions(ctx, 'requirement');
  const isNew = !args.planId;
  const created = isNew
    ? store.createPlan(root, { title: args.title || 'Autotest plan', source: { kind: args.sourceKind || 'text', text: args.source || '' } })
    : resolvePlan(ctx, args);
  const dir = created.dir;
  const state = created.state;

  if (!String(state.source.text || '').trim() && !String(args.source || '').trim()) {
    const error = new Error('the requirement stage needs source material: pass the requirement text, a file path or a document reference');
    error.code = 'REQUIREMENT_SOURCE_MISSING';
    throw error;
  }
  if (args.source) {
    state.source = {
      kind: args.sourceKind || 'text',
      ref: args.sourceRef || null,
      text: args.source,
    };
  }

  updateStage(dir, state, 'requirements', { status: 'running' });
  store.writeState(dir, state);
  let answer;
  try {
    answer = await modelCall('requirements', function () {
    return llm.completeJson(ctx.pi, {
    system: PROMPTS.requirement,
    context: state.source.text,
    instruction:
      'Break the material above into features. For each feature return id, title, description, acceptance (array of strings) and requirementRefs (array of ids you assign such as R-01). Also return gaps: an array of strings naming what is missing or unverifiable.',
    jsonSchemaHint: '{"features":[{"id":"F-01","title":"","description":"","acceptance":[""],"requirementRefs":["R-01"]}],"gaps":[""]}',
    ...options,
    });
  });
  } catch (error) {
    failStage(dir, state, 'requirements', error);
    throw error;
  }

  const features = normaliseFeatures(answer.data.features);
  state.features = features;
  state.requirements = normaliseRequirements(answer.data.requirements, features);
  state.notes = (answer.data.gaps || []).map(function (text) {
    return { kind: 'requirement-gap', text: String(text), at: store.nowIso() };
  });
  const artifactId = store.saveArtifact(dir, 'requirements', { features: features, gaps: state.notes });
  state.status = 'in_progress';
  updateStage(dir, state, 'requirements', {
    status: 'done',
    artifactId: artifactId,
    note: features.length + ' features, ' + state.notes.length + ' gaps',
  });
  store.writeState(dir, state);
  return {
    planId: state.id,
    stage: 'requirements',
    features: features,
    gaps: state.notes.map(function (entry) {
      return entry.text;
    }),
    next: 'review the features, then call autotest_cases',
  };
}

function normaliseFeatures(input) {
  const list = Array.isArray(input) ? input : [];
  return list.map(function (entry, index) {
    return {
      id: entry && entry.id ? String(entry.id) : schema.featureId(index),
      title: String((entry && entry.title) || 'Untitled feature'),
      description: String((entry && entry.description) || ''),
      acceptance: Array.isArray(entry && entry.acceptance) ? entry.acceptance.map(String) : [],
      requirementRefs: Array.isArray(entry && entry.requirementRefs) ? entry.requirementRefs.map(String) : [],
    };
  });
}

function normaliseRequirements(input, features) {
  if (Array.isArray(input)) {
    return input.map(function (entry, index) {
      return { id: entry && entry.id ? String(entry.id) : schema.requirementId(index), text: String((entry && entry.text) || '') };
    });
  }
  const refs = new Set();
  features.forEach(function (feature) {
    feature.requirementRefs.forEach(function (ref) {
      refs.add(ref);
    });
  });
  return Array.from(refs).map(function (ref) {
    return { id: ref, text: '' };
  });
}

/* ---------------------------------------------------------------------- cases */

async function cases(ctx, args) {
  const resolved = resolvePlan(ctx, args);
  const dir = resolved.dir;
  const state = resolved.state;
  const blocked = stages.blockReason(state, 'cases');
  if (blocked && !args.regenerate) {
    const error = new Error(blocked);
    error.code = 'STAGE_BLOCKED';
    throw error;
  }
  if (!state.features.length) {
    const error = new Error('no features on this plan; run autotest_requirement first');
    error.code = 'FEATURES_MISSING';
    throw error;
  }
  const budget = stages.caseBudget(state.features.length, ctx.settings);
  updateStage(dir, state, 'cases', { status: 'running' });
  store.writeState(dir, state);
  let answer;
  try {
    answer = await modelCall('cases', function () {
    return llm.completeJson(ctx.pi, {
    system: PROMPTS.cases,
    context: JSON.stringify({ features: state.features, budget: budget }, null, 2),
    instruction:
      'Produce between ' +
      Math.max(1, budget - 4) +
      ' and ' +
      budget +
      ' test cases covering every feature. Return cases: an array of objects with title, featureId, priority (P0-P3), preconditions, steps and expected (arrays of strings), and type.',
    jsonSchemaHint:
      '{"cases":[{"title":"","featureId":"F-01","priority":"P1","preconditions":[""],"steps":[""],"expected":[""],"type":"functional"}]}',
    ...modelOptions(ctx, 'cases'),
    });
  });
  } catch (error) {
    failStage(dir, state, 'cases', error);
    throw error;
  }
  const generated = normaliseCases(answer.data.cases, state);
  state.cases = generated;
  const cov = stages.coverage(state);
  const dups = stages.duplicates(generated);
  const artifactId = store.saveArtifact(dir, 'cases', { cases: generated, coverage: cov, duplicates: dups });
  state.status = 'awaiting_review';
  updateStage(dir, state, 'cases', {
    status: 'awaiting_review',
    artifactId: artifactId,
    note: generated.length + ' cases, coverage ' + Math.round(cov.ratio * 100) + '%',
  });
  store.writeState(dir, state);
  return {
    planId: state.id,
    stage: 'cases',
    cases: generated,
    coverage: cov,
    duplicates: dups,
    review: 'the card above is editable; approve it before any script is written',
  };
}

function normaliseCases(input, state) {
  const list = Array.isArray(input) ? input : [];
  const known = new Set(
    (state.features || []).map(function (feature) {
      return feature.id;
    }),
  );
  return list.map(function (entry, index) {
    const featureId = String((entry && entry.featureId) || '');
    return {
      id: schema.caseId(index),
      revision: 1,
      approvedRevision: null,
      selected: true,
      title: String((entry && entry.title) || 'Untitled case'),
      featureId: known.has(featureId) ? featureId : known.size > 0 ? Array.from(known)[0] : null,
      priority: schema.CASE_PRIORITIES.indexOf(String((entry && entry.priority) || '')) !== -1 ? String(entry.priority) : 'P2',
      preconditions: Array.isArray(entry && entry.preconditions) ? entry.preconditions.map(String) : [],
      steps: Array.isArray(entry && entry.steps) ? entry.steps.map(String) : [],
      expected: Array.isArray(entry && entry.expected) ? entry.expected.map(String) : [],
      type: String((entry && entry.type) || 'functional'),
    };
  });
}

/* --------------------------------------------------------------------- author */

async function author(ctx, args) {
  const resolved = resolvePlan(ctx, args);
  const dir = resolved.dir;
  const state = resolved.state;
  const blocked = stages.blockReason(state, 'scripts');
  if (blocked) {
    const error = new Error(blocked);
    error.code = 'STAGE_BLOCKED';
    throw error;
  }
  const gate = stages.reviewGate(state);
  if (!gate.ok) {
    const error = new Error('refusing to write scripts: ' + gate.reason);
    error.code = 'REVIEW_GATE_CLOSED';
    throw error;
  }
  const selected = state.cases.filter(function (entry) {
    return entry.selected !== false;
  });
  // Bounded-batch authoring: every script costs one model call, and one tool
  // invocation has a bounded budget (the host gives a tool 110s). Let the
  // caller pass a subset so a large case set is authored across several calls
  // instead of one call that can never finish in time.
  const batch = Array.isArray(args.testCaseIds) && args.testCaseIds.length > 0
    ? args.testCaseIds.map(String)
    : null;
  const scope = batch
    ? selected.filter(function (entry) { return batch.indexOf(entry.id) !== -1; })
    : selected;
  if (batch && scope.length === 0) {
    const error = new Error('none of the requested case ids are selected on this plan: ' + batch.join(', '));
    error.code = 'CASES_NOT_FOUND';
    throw error;
  }
  updateStage(dir, state, 'scripts', { status: 'running' });
  store.writeState(dir, state);
  const scripts = state.scripts.filter(function (entry) {
    // Keep scripts for cases outside this batch; a batched call only rewrites
    // the cases it was asked to author.
    return !batch || batch.indexOf(entry.testCaseId) === -1;
  });
  try {
  for (const testCase of scope) {
    const previous = state.scripts.find(function (entry) {
      return entry.testCaseId === testCase.id;
    });
    const answer = await modelCall('scripts', function () {
      return llm.completeJson(ctx.pi, {
      system: PROMPTS.author,
      context: JSON.stringify(testCase, null, 2),
      instruction:
        'Write one script that executes the steps and asserts every expected result. Return language, script, command (or null when the case needs no project runner) and notes.',
      jsonSchemaHint: '{"language":"javascript","script":"","command":null,"notes":""}',
      ...modelOptions(ctx, 'author'),
      });
    });
    scripts.push({
      testCaseId: testCase.id,
      title: testCase.title,
      language: String(answer.data.language || 'javascript'),
      body: String(answer.data.script || answer.data.body || ''),
      command: answer.data.command ? String(answer.data.command) : null,
      notes: answer.data.notes ? String(answer.data.notes) : null,
      revision: previous ? previous.revision + 1 : 1,
    });
  }
  } catch (error) {
    failStage(dir, state, 'scripts', error);
    throw error;
  }
  state.scripts = scripts;
  const artifactId = store.saveArtifact(dir, 'scripts', { scripts: scripts });
  updateStage(dir, state, 'scripts', {
    status: 'done',
    artifactId: artifactId,
    note: scripts.length + ' scripts' + (batch ? ' (batch ' + scope.length + ')' : ''),
  });
  store.writeState(dir, state);
  return {
    planId: state.id,
    stage: 'scripts',
    scripts: scripts.map(function (entry) {
      return {
        testCaseId: entry.testCaseId,
        title: entry.title,
        language: entry.language,
        command: entry.command,
        revision: entry.revision,
        lines: entry.body.split('\n').length,
        preview: entry.body.slice(0, 400),
      };
    }),
    next: 'call autotest_run with the plan id; it will refuse until the case set is approved',
  };
}

/* ------------------------------------------------------------------------ run */

async function run(ctx, args) {
  const resolved = resolvePlan(ctx, args);
  const dir = resolved.dir;
  const state = resolved.state;
  const blocked = stages.blockReason(state, 'run');
  if (blocked) {
    const error = new Error(blocked);
    error.code = 'STAGE_BLOCKED';
    throw error;
  }
  if (!state.scripts.length) {
    const error = new Error('no scripts on this plan; run autotest_author first');
    error.code = 'SCRIPTS_MISSING';
    throw error;
  }
  const only = Array.isArray(args.testCaseIds) ? new Set(args.testCaseIds.map(String)) : null;
  const selected = state.scripts.filter(function (entry) {
    return !only || only.has(entry.testCaseId);
  });
  updateStage(dir, state, 'run', { status: 'running' });
  const stamp = store.nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
  const runId = 'run-' + stamp;
  const results = await runner.runBatch({
    scripts: selected,
    scriptDir: path.join(dir, 'runs', runId),
    cwd: args.cwd || ctx.workspacePath || null,
    timeoutMs: args.timeoutMs || (ctx.settings && ctx.settings.timeoutMs),
    maxOutput: args.maxOutput,
    signal: ctx.signal,
  });
  const record = { id: runId, at: store.nowIso(), results: results };
  state.runs.push(record);
  const scope = diagnose.classifyBatch(results);
  const artifactId = store.saveArtifact(dir, 'run', record);
  updateStage(dir, state, 'run', {
    status: 'done',
    artifactId: artifactId,
    note: scope.passed + '/' + scope.total + ' passed',
  });
  if (scope.failed > 0) state.status = 'partial';
  store.writeState(dir, state);
  return {
    planId: state.id,
    stage: 'run',
    runId: runId,
    results: results.map(function (entry) {
      return {
        testCaseId: entry.testCaseId,
        title: entry.title,
        status: entry.status,
        exitCode: entry.exitCode,
        durationMs: entry.durationMs,
        reason: entry.reason,
        truncated: entry.truncated,
      };
    }),
    summary: { total: scope.total, passed: scope.passed, failed: scope.failed },
    next: scope.failed > 0 ? 'call autotest_diagnose to classify the failures' : 'call autotest_report',
  };
}

/* --------------------------------------------------------------------- status */

async function status(ctx, args) {
  if (!args.planId) {
    const root = ensureRoot(dataRoot(ctx));
    return { plans: store.listPlans(root), next: 'pass planId for a full status' };
  }
  const resolved = resolvePlan(ctx, args);
  const summary = report.summarize(resolved.state);
  return {
    planId: resolved.state.id,
    summary: summary,
    state: resolved.state,
    rail: stages.rail(resolved.state),
    gate: stages.reviewGate(resolved.state),
    artifacts: store.listArtifacts(resolved.dir),
    next: stages.nextStages(resolved.state),
  };
}

/* --------------------------------------------------------------------- select */

async function select(ctx, args) {
  const resolved = resolvePlan(ctx, args);
  const dir = resolved.dir;
  const state = resolved.state;
  const ids = Array.isArray(args.testCaseIds) ? args.testCaseIds.map(String) : [];
  if (ids.length === 0) {
    const error = new Error('testCaseIds must list at least one case id');
    error.code = 'SELECTION_EMPTY';
    throw error;
  }
  const applied = [];
  state.cases.forEach(function (entry) {
    const wanted = ids.indexOf(entry.id) !== -1;
    const value = typeof args.selected === 'boolean' ? args.selected && wanted : wanted;
    if (entry.selected !== value) {
      entry.selected = value;
      applied.push(entry.id + ' -> ' + (value ? 'selected' : 'deselected'));
    }
  });
  store.writeState(dir, state);
  const cov = stages.coverage(state);
  return {
    planId: state.id,
    applied: applied,
    selectedCases: state.cases.filter(function (entry) {
      return entry.selected !== false;
    }).length,
    coverage: cov,
  };
}

/* -------------------------------------------------------------------- approve */

function approveCaseSet(ctx, args) {
  const resolved = resolvePlan(ctx, args);
  const dir = resolved.dir;
  const state = resolved.state;
  const actor = String(args.actor || 'user');
  const touchedIds = new Set();
  if (Array.isArray(args.cases) && args.cases.length > 0) {
    const byId = new Map(
      state.cases.map(function (entry) {
        return [entry.id, entry];
      }),
    );
    args.cases.forEach(function (patch) {
      const target = patch && byId.get(String(patch.id));
      if (!target) return;
      let touched = false;
      if (typeof patch.title === 'string' && patch.title !== target.title) {
        target.title = patch.title;
        touched = true;
      }
      if (typeof patch.priority === 'string' && schema.CASE_PRIORITIES.indexOf(patch.priority) !== -1 && patch.priority !== target.priority) {
        target.priority = patch.priority;
        touched = true;
      }
      if (Array.isArray(patch.steps) && patch.steps.join('\n') !== (target.steps || []).join('\n')) {
        target.steps = patch.steps.map(String);
        touched = true;
      }
      if (Array.isArray(patch.expected) && patch.expected.join('\n') !== (target.expected || []).join('\n')) {
        target.expected = patch.expected.map(String);
        touched = true;
      }
      if (typeof patch.selected === 'boolean' && patch.selected !== (target.selected !== false)) {
        target.selected = patch.selected;
      }
      if (typeof patch.removed === 'boolean' && patch.removed) target.selected = false;
      // Bump the revision only when content changed: an approval that carries the
      // card's untouched rows must stay approvable, or the gate can never open.
      if (touched) {
        target.revision = (target.revision || 1) + 1;
        touchedIds.add(target.id);
      }
    });
  }
  if (Array.isArray(args.cases) && args.cases.length > 0) {
    // Approving a reviewed card means approving exactly the rows that card showed:
    // a case the human removed from the card is deselected, not silently kept.
    const shown = new Set(
      args.cases.map(function (patch) {
        return String((patch && patch.id) || '');
      }),
    );
    state.cases.forEach(function (entry) {
      if (!shown.has(entry.id)) entry.selected = false;
    });
  }
  // An approval endorses the exact content the reviewer saw. A row touched in this
  // same call carries content the approval did not cover, so its approvedRevision
  // is left behind: the gate stays closed until that edit is approved on its own.
  state.cases.forEach(function (entry) {
    if (touchedIds.has(entry.id)) return;
    entry.approvedRevision = entry.revision;
  });
  const decision = args.decision === 'rejected' ? 'rejected' : 'approved';
  const snapshot = {};
  state.cases.forEach(function (entry) {
    snapshot[entry.id] = { revision: entry.revision, selected: entry.selected !== false };
  });
  const approval = {
    kind: 'cases',
    decision: decision,
    at: store.nowIso(),
    actor: actor,
    note: args.note || null,
    selected: Object.keys(snapshot).filter(function (id) {
      return snapshot[id].selected;
    }),
    revisions: snapshot,
  };
  // An approval that edited and approved in one call endorses nothing: the edited
  // row carries content no reviewer has seen yet. Keeping it out of the approval
  // list is what makes the gate stay shut until that revision is approved on its own.
  if (touchedIds.size === 0) {
    state.approvals.push(approval);
  }
  const cov = stages.coverage(state);
  if (decision === 'approved') {
    updateStage(dir, state, 'cases', {
      status: 'done',
      note: state.cases.length + ' cases approved, coverage ' + Math.round(cov.ratio * 100) + '%',
    });
    state.status = 'approved';
  } else {
    updateStage(dir, state, 'cases', { status: 'failed', note: 'rejected by ' + actor });
    state.status = 'awaiting_review';
  }
  store.writeState(dir, state);
  return {
    planId: state.id,
    decision: decision,
    cases: state.cases.length,
    selected: state.cases.filter(function (entry) {
      return entry.selected !== false;
    }).length,
    coverage: cov,
    gate: stages.reviewGate(state),
  };
}

/* ------------------------------------------------------------------- diagnose */

async function diagnoseTool(ctx, args) {
  const resolved = resolvePlan(ctx, args);
  const dir = resolved.dir;
  const state = resolved.state;
  const blocked = stages.blockReason(state, 'verdict');
  if (blocked) {
    const error = new Error(blocked);
    error.code = 'STAGE_BLOCKED';
    throw error;
  }
  const runRecord = state.runs.length > 0 ? state.runs[state.runs.length - 1] : null;
  if (!runRecord) {
    const error = new Error('no run recorded on this plan; call autotest_run first');
    error.code = 'RUN_MISSING';
    throw error;
  }
  updateStage(dir, state, 'verdict', { status: 'running' });
  store.writeState(dir, state);
  const deterministic = diagnose.classifyBatch(runRecord.results);
  const failures = deterministic.entries.filter(function (entry) {
    return entry.status !== 'passed';
  });
  let narrative = null;
  if (failures.length > 0) {
    const failedRuns = runRecord.results.filter(function (entry) {
      return entry.status !== 'passed';
    });
    let answer;
    try {
      answer = await modelCall('verdict', function () {
      return llm.completeText(ctx.pi, {
      system: PROMPTS.diagnose,
      context: JSON.stringify(
        {
          classification: failures,
          runs: failedRuns.map(function (entry) {
            return {
              testCaseId: entry.testCaseId,
              status: entry.status,
              exitCode: entry.exitCode,
              stderr: String(entry.stderr || '').slice(0, 4000),
              stdout: String(entry.stdout || '').slice(0, 2000),
            };
          }),
        },
        null,
        2,
      ),
      instruction:
        'Explain each failure in one or two sentences, say whether the evidence supports a script fix, and end with a single recommendation line. Do not propose weakening any assertion.',
      ...modelOptions(ctx, 'diagnose'),
      });
      });
    } catch (error) {
      failStage(dir, state, 'verdict', error);
      throw error;
    }
    narrative = String(answer).trim();
  }
  const verdict = {
    runId: runRecord.id,
    at: store.nowIso(),
    counts: deterministic.counts,
    total: deterministic.total,
    passed: deterministic.passed,
    failed: deterministic.failed,
    blocking: deterministic.blocking,
    recommendation: deterministic.recommendation,
    entries: deterministic.entries,
    narrative: narrative,
  };
  state.verdicts.push(verdict);
  const artifactId = store.saveArtifact(dir, 'verdict', verdict);
  updateStage(dir, state, 'verdict', {
    status: 'done',
    artifactId: artifactId,
    note: deterministic.blocking.length > 0 ? deterministic.blocking.length + ' blocking' : 'no blocking failures',
  });
  store.writeState(dir, state);
  return {
    planId: state.id,
    stage: 'verdict',
    counts: deterministic.counts,
    blocking: deterministic.blocking,
    recommendation: deterministic.recommendation,
    narrative: narrative,
    entries: deterministic.entries,
    repairAllowed: deterministic.blocking.length === 0 && deterministic.failed > 0,
  };
}

/* --------------------------------------------------------------------- report */

async function reportTool(ctx, args) {
  const resolved = resolvePlan(ctx, args);
  const dir = resolved.dir;
  const state = resolved.state;
  // The rail inside the report must show this write. Render only after the
  // stage is marked done, otherwise report.md always claims "Report | idle".
  updateStage(dir, state, 'report', { status: 'running', note: 'rendering report.md' });
  const markdown = report.renderMarkdown(state);
  const summary = report.summarize(state);
  const artifactId = store.saveArtifact(dir, 'report', { markdown: markdown, summary: summary });
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, markdown, 'utf8');
  updateStage(dir, state, 'report', { status: 'done', artifactId: artifactId, note: 'report.md written' });
  if (summary.gate.ok && summary.lastRun && summary.lastRun.failed === 0) state.status = 'done';
  store.writeState(dir, state);
  return {
    planId: state.id,
    stage: 'report',
    file: file,
    summary: summary,
    markdown: markdown,
  };
}

/* ----------------------------------------------------------------- knowledge */

/**
 * The knowledge refs this plan cites, deduplicated and in a stable order.
 *
 * Sorted on every write so a panel that renders the list twice never sees it
 * reorder, and so two plans citing the same entries compare as strings.
 */
function normaliseRefs(value) {
  const list = Array.isArray(value) ? value : [];
  return Array.from(
    new Set(
      list
        .map(function (entry) {
          return String(entry == null ? '' : entry).trim();
        })
        .filter(Boolean),
    ),
  ).sort();
}

function writeRefs(dir, state, ids) {
  state.knowledgeRefs = normaliseRefs(ids);
  // touchPlan() then writeState(): the same write order every other mutation in
  // this module uses, so state.json is never partially updated.
  touchPlan(state);
  store.writeState(dir, state);
  return state.knowledgeRefs;
}

/** Cite knowledge-base entries from a plan. Unknown ids are just refs; no read is attempted. */
function attachKnowledge(ctx, planId, ids) {
  const resolved = resolvePlan(ctx, { planId: planId });
  const merged = resolved.state.knowledgeRefs.concat(Array.isArray(ids) ? ids : []);
  return { planId: resolved.state.id, knowledgeRefs: writeRefs(resolved.dir, resolved.state, merged), attached: normaliseRefs(ids) };
}

/** Drop knowledge-base refs from a plan. Refs that were never attached are ignored. */
function detachKnowledge(ctx, planId, ids) {
  const resolved = resolvePlan(ctx, { planId: planId });
  const gone = new Set(normaliseRefs(ids));
  const kept = resolved.state.knowledgeRefs.filter(function (entry) {
    return !gone.has(entry);
  });
  return { planId: resolved.state.id, knowledgeRefs: writeRefs(resolved.dir, resolved.state, kept), detached: Array.from(gone).sort() };
}

/* ------------------------------------------------------------ renderer bridge */

/** Actions the renderer may invoke. Anything else is rejected explicitly. */
const RENDERER_ACTIONS = {
  'status': async function (ctx, payload) {
    return status(ctx, { planId: payload.planId });
  },
  'approve': async function (ctx, payload) {
    return approveCaseSet(ctx, {
      planId: payload.planId,
      cases: payload.cases,
      decision: payload.decision,
      actor: payload.actor || 'renderer',
      note: payload.note,
    });
  },
  'select': async function (ctx, payload) {
    return select(ctx, { planId: payload.planId, testCaseIds: payload.testCaseIds, selected: payload.selected });
  },
  'reveal': async function (ctx, payload) {
    const resolved = resolvePlan(ctx, payload);
    const file = path.join(resolved.dir, payload.file === 'report' ? 'report.md' : 'state.json');
    if (!fs.existsSync(file)) {
      const error = new Error('nothing to reveal yet: ' + path.basename(file) + ' does not exist');
      error.code = 'NOTHING_TO_REVEAL';
      throw error;
    }
    return { planId: resolved.state.id, path: file, exists: true };
  },
};

async function callRendererAction(ctx, method, payload) {
  const handler = RENDERER_ACTIONS[method];
  if (!handler) {
    const error = new Error('unsupported renderer action: ' + String(method));
    error.code = 'RENDERER_ACTION_UNSUPPORTED';
    throw error;
  }
  return handler(ctx, payload || {});
}

/* --------------------------------------------------------------------- panel */

/**
 * Everything the work-panel view renders for one plan, in one read.
 *
 * The view runs in a sandboxed page with no fs and no require, so every fact it
 * shows has to be projected here. It also gets a trimmed copy of the case and
 * script bodies: a plan with 40 cases and 40 scripts is megabytes of source, and
 * the panel would spend its whole 30s bridge budget on serialisation.
 */
function reviewPlan(ctx, planId) {
  // Callers hand in either the id or a {planId} bag: the panel bridge passes the
  // id while onRendererCall passes an argument object, and resolvePlan only
  // takes the bag. Answering PLAN_ID_REQUIRED for a valid id would look like a
  // deleted plan.
  const wanted = planId && typeof planId === 'object' ? planId.planId : planId;
  const resolved = resolvePlan(ctx, { planId: wanted });
  const state = resolved.state;
  return {
    planId: state.id,
    title: state.title,
    updatedAt: state.updatedAt,
    summary: report.summarize(state),
    state: {
      id: state.id,
      title: state.title,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      activeStage: state.activeStage,
      status: state.status,
      source: state.source,
      stages: state.stages,
      requirements: state.requirements,
      features: state.features,
      cases: state.cases,
      scripts: (state.scripts || []).map(function (entry) {
        return {
          testCaseId: entry.testCaseId,
          title: entry.title,
          language: entry.language,
          command: entry.command,
          notes: String(entry.notes || '').slice(0, 600),
          revision: entry.revision,
          body: String(entry.body || ''),
        };
      }),
      runs: (state.runs || []).map(function (entry) {
        return {
          id: entry.id,
          at: entry.at,
          results: (entry.results || []).map(function (result) {
            return {
              testCaseId: result.testCaseId,
              title: result.title,
              status: result.status,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              reason: result.reason,
              truncated: result.truncated,
              file: result.file,
              stdout: String(result.stdout || '').slice(0, 20000),
              stderr: String(result.stderr || '').slice(0, 20000),
            };
          }),
        };
      }),
      verdicts: state.verdicts,
      approvals: state.approvals,
      notes: state.notes,
      knowledgeRefs: normaliseRefs(state.knowledgeRefs),
    },
    rail: stages.rail(state),
    gate: stages.reviewGate(state),
    coverage: stages.coverage(state),
    artifacts: store.listArtifacts(resolved.dir),
    next: stages.nextStages(state),
  };
}

/** The markdown report of one plan, rendered on demand (never cached to disk). */
function reportMarkdown(ctx, planId) {
  const wanted = planId && typeof planId === 'object' ? planId.planId : planId;
  const resolved = resolvePlan(ctx, { planId: wanted });
  return {
    planId: resolved.state.id,
    markdown: report.renderMarkdown(resolved.state),
  };
}

/**
 * One row of the traceability matrix. Kept here rather than in the view so the
 * join between feature, case, script and run is testable without a browser.
 */
function traceRows(state) {
  const latest = (state.runs || []).slice(-1)[0] || null;
  const results = {};
  if (latest && Array.isArray(latest.results)) {
    latest.results.forEach(function (entry) {
      results[entry.testCaseId] = entry;
    });
  }
  const scriptByCase = {};
  (state.scripts || []).forEach(function (entry) {
    scriptByCase[entry.testCaseId] = entry;
  });
  return (state.cases || []).map(function (entry) {
    const result = results[entry.id] || null;
    return {
      testCaseId: entry.id,
      title: entry.title,
      priority: entry.priority,
      featureId: entry.featureId,
      selected: entry.selected !== false,
      approvedRevision: typeof entry.approvedRevision === 'number' ? entry.approvedRevision : null,
      revision: entry.revision,
      hasScript: Boolean(scriptByCase[entry.id]),
      status: result ? result.status : null,
      durationMs: result ? result.durationMs : null,
    };
  });
}

module.exports = {
  PROMPTS,
  RENDERER_ACTIONS,
  dataRoot,
  resolveRooted,
  reviewPlan,
  reportMarkdown,
  traceRows,
  ensureRoot,
  resolvePlan,
  requirement,
  cases,
  author,
  run,
  status,
  select,
  approveCaseSet,
  attachKnowledge,
  detachKnowledge,
  normaliseRefs,
  diagnoseTool,
  reportTool,
  callRendererAction,
  normaliseFeatures,
  normaliseCases,
  normaliseRequirements,
  touchPlan,
};