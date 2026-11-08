'use strict';
/**
 * Stage transitions and review gates for one plan.
 *
 * Two invariants hold here:
 *  - a stage may only run when its predecessor produced an approved artifact;
 *  - scripts never execute until a human approved the case set that produced them.
 */

const schema = require('./schema');

const FRIENDLY_FAILURE = {
  requirements: 'the requirement stage has not produced an approved feature list yet',
  cases: 'the case set has not been generated yet',
  scripts: 'no approved case set, so no script may be written',
  run: 'the scripts have not been authored yet',
  verdict: 'the run has not produced any result yet',
  report: 'the verdict stage has not been classified yet',
};

/** Literal stage status. `undefined` is idle, never done. */
function stageStatus(state, stage) {
  const entry = state && state.stages ? state.stages[stage] : null;
  return (entry && entry.status) || 'idle';
}

function stageFinished(state, stage) {
  const value = stageStatus(state, stage);
  return value === 'done' || value === 'skipped';
}

/** Stages a plan may run right now, given what is already approved. */
function nextStages(state) {
  const out = [];
  for (let index = 0; index < schema.STAGES.length; index += 1) {
    const stage = schema.STAGES[index];
    if (!stageFinished(state, stage)) {
      out.push(stage);
      break;
    }
  }
  return out;
}

/** Blocking reason for one stage, or null when it may proceed. */
function blockReason(state, stage) {
  if (!schema.isStage(stage)) return 'unknown stage: ' + String(stage);
  const index = schema.STAGES.indexOf(stage);
  for (let before = 0; before < index; before += 1) {
    const predecessor = schema.STAGES[before];
    if (!stageFinished(state, predecessor)) {
      return FRIENDLY_FAILURE[stage] || ('stage "' + predecessor + '" must finish first');
    }
  }
  if (stage === 'run') {
    const gate = reviewGate(state);
    if (!gate.ok) return gate.reason;
  }
  return null;
}

/**
 * Renderer projection of the rail. Directly complements nextStages/blockReason
 * so the card and the guard can never disagree.
 */
function rail(state) {
  const next = nextStages(state);
  const cursor = next.length ? next[0] : null;
  return {
    cursor: cursor,
    stages: schema.STAGES.map(function (stage, index) {
      const status = stageStatus(state, stage);
      const finished = stageFinished(state, stage);
      let state_ = 'done';
      if (status === 'failed') state_ = 'failed';
      else if (status === 'awaiting_review') state_ = 'awaiting_review';
      else if (status === 'running') state_ = 'running';
      else if (!finished && stage === cursor) state_ = 'ready';
      else if (!finished) state_ = 'locked';
      return {
        stage: stage,
        label: schema.STAGE_LABELS[stage],
        status: status,
        state: state_,
        note: (state.stages[stage] && state.stages[stage].note) || null,
        reason: state_ === 'locked' ? blockReason(state, stage) : null,
      };
    }),
  };
}

/**
 * Environment gate: checked before the first model call so a dead rig or a
 * missing interpreter fails fast and for free.
 */
async function environmentGate(runtimes, settings) {
  const captured = runtimes || {};
  const results = [];
  try {
    const probe = await captured.selfCheck({ settings: settings });
    results.push({ id: 'node', ok: probe.ok === true, detail: probe.detail });
  } catch (error) {
    results.push({ id: 'node', ok: false, detail: 'probe threw: ' + error.message });
  }
  const configured = settings && settings.runnerCommand ? String(settings.runnerCommand) : null;
  if (configured) {
    try {
      const probe = await captured.selfCheck({ settings: Object.assign({}, settings, { probe: 'runnerCommand' }) });
      results.push({ id: 'runnerCommand', ok: probe.ok === true, detail: probe.detail });
    } catch (error) {
      results.push({ id: 'runnerCommand', ok: false, detail: 'probe threw: ' + error.message });
    }
  }
  const failed = results.filter(function (entry) {
    return !entry.ok;
  });
  return {
    ok: failed.length === 0,
    results: results,
    reason: failed.length ? failed[0].id + ': ' + failed[0].detail : null,
  };
}

/**
 * The review gate. Cases and scripts are both model products, so the gate is
 * checked at execution time rather than trusted from an earlier checkbox.
 */
function reviewGate(state) {
  const approvals = Array.isArray(state.approvals) ? state.approvals : [];
  const approved = approvals.filter(function (entry) {
    return entry.kind === 'cases' && entry.decision === 'approved';
  });
  if (approved.length === 0) {
    const only = (state.cases || []).some(function (entry) {
      return entry.approvedRevision == null;
    });
    return {
      ok: false,
      reason: only
        ? 'the case set has not been approved yet; review the card and approve it'
        : 'no approved case set yet; approve the generated cases before running',
    };
  }
  const latest = approved[approved.length - 1];
  const casesStatus = (state.stages.cases && state.stages.cases.status) || 'idle';
  if (casesStatus === 'awaiting_review') {
    return { ok: false, reason: 'the case set is still awaiting review' };
  }
  const activeCases = (state.cases || []).filter(function (entry) {
    return entry.selected !== false;
  });
  if (activeCases.length === 0) {
    return { ok: false, reason: 'every case is deselected; select at least one before running' };
  }
  const stale = (state.cases || []).some(function (entry) {
    return typeof entry.approvedRevision === 'number' && entry.revision > entry.approvedRevision;
  });
  if (stale) {
    return { ok: false, reason: 'a case was edited after approval; re-approve the case set' };
  }
  return { ok: true, reason: null, approval: latest, caseCount: activeCases.length };
}

/** Coverage of features by selected cases, computed without any model call. */
function coverage(state) {
  const features = Array.isArray(state.features) ? state.features : [];
  const cases = Array.isArray(state.cases) ? state.cases : [];
  const covered = new Set(
    cases
      .filter(function (entry) {
        return entry.selected !== false;
      })
      .map(function (entry) {
        return entry.featureId;
      }),
  );
  const missing = features
    .filter(function (feature) {
      return !covered.has(feature.id);
    })
    .map(function (feature) {
      return feature.id;
    });
  const total = features.length;
  return {
    total: total,
    covered: total - missing.length,
    missing: missing,
    ratio: total === 0 ? 0 : (total - missing.length) / total,
  };
}

/** Duplicate detection by normalised title, again deterministic. */
function duplicates(cases) {
  const seen = new Map();
  const dups = [];
  (Array.isArray(cases) ? cases : []).forEach(function (entry) {
    const key = String(entry.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .trim();
    if (!key) return;
    if (seen.has(key)) dups.push({ first: seen.get(key), second: entry.id, title: entry.title });
    else seen.set(key, entry.id);
  });
  return dups;
}

/**
 * How many cases a requirement set should produce.
 * Keeps small requirements from exploding and large ones from being truncated.
 */
function caseBudget(featureCount, settings) {
  const perFeature = (settings && Number(settings.casesPerFeature)) || 3;
  const min = (settings && Number(settings.minCases)) || 8;
  const max = (settings && Number(settings.maxCases)) || 40;
  const target = Math.round((Number(featureCount) || 0) * perFeature);
  return Math.max(min, Math.min(max, target));
}

module.exports = {
  nextStages,
  blockReason,
  reviewGate,
  stageStatus,
  stageFinished,
  rail,
  environmentGate,
  coverage,
  duplicates,
  caseBudget,
};