// Shared primitives for the autotest slot components.
import { createElement as h, useEffect, useState, useMemo, useCallback, Fragment } from 'react';
import { call, callError, formatMs } from './bridge.mjs';

export const STAGE_ORDER = ['requirements', 'cases', 'scripts', 'run', 'verdict', 'report'];

export const STAGE_LABELS = {
  requirements: 'Requirement',
  cases: 'Cases',
  scripts: 'Scripts',
  run: 'Run',
  verdict: 'Diagnose',
  report: 'Report',
};

export const STATUS_TEXT = {
  pending: 'pending',
  running: 'running',
  awaiting_review: 'await review',
  done: 'done',
  failed: 'failed',
  blocked: 'blocked',
  skipped: 'skipped',
};

// One plan state fetch bound to a plan id. `reload` is called after every mutation
// so the UI always renders host state rather than an optimistic guess.
export function usePlanState(planId) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async function () {
    if (!planId) return;
    try {
      const answer = await call('status', { planId });
      setState(answer && answer.state ? answer.state : answer);
      setError(null);
    } catch (failure) {
      setError(callError(failure));
    }
  }, [planId]);
  useEffect(function () {
    load();
  }, [load]);
  const run = useCallback(async function (method, payload) {
    setBusy(true);
    try {
      const answer = await call(method, Object.assign({ planId }, payload || {}));
      await load();
      return answer;
    } catch (failure) {
      setError(callError(failure));
      return null;
    } finally {
      setBusy(false);
    }
  }, [planId, load]);
  return { state, error, busy, reload: load, run };
}

/**
 * Rail fallback for callers that only hold a plan state.
 *
 * `state.stages[stage].status` is the persisted stage status, while the rail
 * projection (`lib/stages.js:66-90`) carries the derived `state` the stylesheet
 * paints. Reading `state.stages[].id` (the old shape) matched nothing, so every
 * rail rendered from a state object painted six pending chips. Build the same
 * shape StageRailView consumes instead.
 */
export function StageRail(props) {
  const state = props.state || {};
  const stages = state.stages || {};
  const current = state.activeStage || null;
  return h('div', { className: 'at-rail' }, STAGE_ORDER.map(function (id) {
    const entry = stages[id] || {};
    const status = entry.status || 'idle';
    let painted = 'blocked';
    if (status === 'done') painted = 'done';
    else if (status === 'failed') painted = 'failed';
    else if (status === 'awaiting_review') painted = 'awaiting_review';
    else if (status === 'running') painted = 'running';
    else if (id === current) painted = 'running';
    return h('span', {
      key: id,
      className: 'at-stage',
      'data-status': painted,
      'data-current': current === id ? 'yes' : 'no',
      title: entry.note || STATUS_TEXT[status] || status,
    }, STAGE_LABELS[id] || id);
  }));
}

export function Chip(props) {
  return h('span', { className: 'at-chip', title: props.title || null }, props.children);
}

export function Empty(props) {
  return h('div', { className: 'at-empty' }, props.children || 'nothing here yet');
}

export function Pre(props) {
  return h('pre', { className: 'at-pre' }, props.text || '');
}

export function Button(props) {
  return h('button', {
    type: 'button',
    className: 'at-btn',
    'data-kind': props.kind || 'plain',
    disabled: props.disabled || false,
    onClick: props.onClick,
  }, props.children);
}

export function Field(props) {
  return h('label', { className: 'at-kv' },
    h('dt', null, props.label),
    h('dd', null, props.children),
  );
}

export function StatusLine(props) {
  if (!props.error) return null;
  return h('div', { className: 'at-bad' }, 'error: ' + props.error);
}

export { h, useEffect, useState, useMemo, useCallback, Fragment, formatMs };
