// Message-tail rail: shows where the active plan stands inside the same turn
// the assistant is working in, so approval never needs a separate window.
//
// This slot is the only autotest surface that is always visible: tool cards live
// inside the activity group, which the transcript folds by default
// (apps/desktop/src/lib/transcript-display-mode.ts falls back to 'fully-folded'),
// so a review gate rendered only as a tool card can be missed. When the plan
// still needs a decision the same gate is rendered here, at the reply tail.
import { createElement as h, useEffect, useState, useCallback } from 'react';
import { call, callError } from './bridge.mjs';
import { Button, Chip, Empty } from './ui.mjs';
import { StageRailView, ReviewGate } from './cards.mjs';

const PLAN_IN_TEXT = /\bplan-[a-z0-9._-]+/i;

/**
 * Pull the plan id out of the turn text.
 *
 * The host hands this slot the whole assistant turn content, which includes the
 * JSON every tool returned (apps/desktop/src/lib/transcript-summary.ts joins all
 * non-activity message parts). A tool result carries "planId":"plan-...", so the
 * quoted form is tried first; model-authored prose may instead use the
 * `label:plan-...` syntax the skill documents, and that is the fallback.
 */
function planIdFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  const quoted = text.match(/"planId"\s*:\s*"([a-z0-9._-]+)"/i);
  if (quoted) return quoted[1];
  const labelled = text.match(/label\s*:\s*(plan-[a-z0-9._-]+)/i);
  if (labelled) return labelled[1];
  const found = text.match(PLAN_IN_TEXT);
  return found ? found[0] : null;
}

export function StageStrip(props) {
  const message = props && props.message;
  const text = (message && (message.content || message.text)) || '';
  const planId = planIdFromText(text);
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async function (id) {
    if (!id) return;
    try {
      const result = await call('status', { planId: id });
      setAnswer(result || null);
      setError(null);
    } catch (failure) {
      setError(callError(failure));
    }
  }, []);

  useEffect(function () {
    if (!planId) return;
    load(planId);
  }, [planId, load]);

  const run = useCallback(async function (method, payload) {
    setBusy(true);
    try {
      const result = await call(method, Object.assign({ planId: planId }, payload || {}));
      await load(planId);
      return result;
    } catch (failure) {
      setError(callError(failure));
      return null;
    } finally {
      setBusy(false);
    }
  }, [planId, load]);

  if (!planId) return null;

  const state = (answer && answer.state) || null;
  const rail = (answer && answer.rail) || null;
  const gate = (answer && answer.gate) || null;
  // The strip offers the gate; it never re-implements the approval rules.
  const needsDecision = Boolean(
    gate && gate.ok === false && state && Array.isArray(state.cases) && state.cases.length > 0,
  );

  return h('div', { className: 'at-root' },
    h('div', { className: 'at-head' },
      h(Chip, { title: planId }, planId),
      state && state.status ? h(Chip, null, state.status) : null,
      error ? h('span', { className: 'at-bad' }, error) : null,
      h(Button, { onClick: function () { load(planId); }, disabled: busy }, busy ? 'working' : 'Refresh'),
    ),
    rail ? h(StageRailView, { rail: rail }) : h(Empty, null, error ? 'plan state unavailable' : 'loading plan state'),
    needsDecision ? h('div', { className: 'at-warn' }, 'review gate: ' + (gate.reason || 'the case set needs a decision')) : null,
    needsDecision ? h(ReviewGate, { state: state, run: run, busy: busy }) : null,
  );
}
