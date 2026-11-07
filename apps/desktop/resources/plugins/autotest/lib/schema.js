'use strict';
/**
 * Stage, status and identifier vocabulary for the autotest workflow.
 * Everything here is pure data so it can be unit tested without the host.
 */

const STAGES = ['requirements', 'cases', 'scripts', 'run', 'verdict', 'report'];

const STAGE_LABELS = {
  requirements: 'Requirements',
  cases: 'Test cases',
  scripts: 'Scripts',
  run: 'Run',
  verdict: 'Verdict',
  report: 'Report',
};

const STAGE_STATUS = ['idle', 'running', 'awaiting_review', 'done', 'failed', 'skipped'];

/** Terminal and review statuses a plan can rest in. */
const PLAN_STATUS = ['draft', 'awaiting_review', 'approved', 'running', 'partial', 'failed', 'done'];

const RUN_STATUS = ['passed', 'failed', 'errored', 'skipped', 'timeout'];

/** Deterministic failure classes produced by lib/diagnose.js. */
const FAILURE_CLASSES = ['environment', 'script', 'assertion', 'product', 'flaky', 'unknown'];

/** Failure classes whose remedy is a human decision, never an automatic rewrite. */
const HUMAN_ONLY_CLASSES = ['environment', 'product'];

const CASE_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

const ID_PREFIX = {
  plan: 'plan',
  requirement: 'req',
  feature: 'feat',
  testcase: 'tc',
  script: 'sc',
  run: 'run',
  verdict: 'vd',
};

function isStage(value) {
  return STAGES.indexOf(value) !== -1;
}

function isFailureClass(value) {
  return FAILURE_CLASSES.indexOf(value) !== -1;
}

/** Case ids are stable and never reused: TC-001, TC-002 ... */
function caseId(index) {
  return ID_PREFIX.testcase.toUpperCase() + '-' + String(index + 1).padStart(3, '0');
}

function featureId(index) {
  return 'F-' + String(index + 1).padStart(2, '0');
}

function requirementId(index) {
  return 'R-' + String(index + 1).padStart(2, '0');
}

function scriptId(testCaseId) {
  return 'script:' + String(testCaseId || 'unknown').toLowerCase();
}

function isCaseId(value) {
  return typeof value === 'string' && /^TC-\d{3,}$/.test(value);
}

module.exports = {
  STAGES,
  STAGE_LABELS,
  STAGE_STATUS,
  PLAN_STATUS,
  RUN_STATUS,
  FAILURE_CLASSES,
  HUMAN_ONLY_CLASSES,
  CASE_PRIORITIES,
  ID_PREFIX,
  isStage,
  isFailureClass,
  isCaseId,
  caseId,
  featureId,
  requirementId,
  scriptId,
};
