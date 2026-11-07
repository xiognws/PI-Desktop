// The review gate: the one place where a human edits and approves the case set.
// Nothing is written before approval, so this card is the contract between the
// model and the repository.
import { h, useState, useCallback, Button, Chip, Empty, Pre } from './ui.mjs';

const EDITABLE = ['title', 'priority', 'steps', 'expected'];

/**
 * Rail `state` -> the `data-status` vocabulary the stylesheet paints.
 * `ready` is the stage the rail cursor points at: it is the next one to run,
 * not a finished one, so it must not read as done.
 */
export const RAIL_STATUS = {
  done: 'done',
  failed: 'failed',
  awaiting_review: 'awaiting_review',
  running: 'running',
  ready: 'running',
  locked: 'blocked',
};

function joined(value) {
  if (Array.isArray(value)) return value.join('\n');
  return typeof value === 'string' ? value : '';
}

function draftFrom(cases) {
  const draft = {};
  (cases || []).forEach(function (item) {
    draft[item.id] = {
      title: item.title || '',
      priority: item.priority || 'P2',
      steps: joined(item.steps),
      expected: joined(item.expected),
      selected: item.selected !== false,
    };
  });
  return draft;
}

function dirty(cases, draft) {
  const count = Object.keys(draft).length;
  if (!count) return false;
  return (cases || []).some(function (item) {
    const edit = draft[item.id];
    if (!edit) return true;
    const lines = function (value) {
      return String(value || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
    };
    if (edit.title !== (item.title || '')) return true;
    if (edit.priority !== (item.priority || 'P2')) return true;
    if (lines(edit.expected).join('\u0001') !== lines(joined(item.expected)).join('\u0001')) return true;
    if (edit.selected !== (item.selected !== false)) return true;
    return lines(edit.steps).join('\u0001') !== lines(joined(item.steps)).join('\u0001');
  });
}

export function ReviewGate(props) {
  const state = props.state;
  const cases = (state && state.cases) || [];
  const [draft, setDraft] = useState(function () { return draftFrom(cases); });
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);

  const edit = useCallback(function (id, key, value) {
    setDraft(function (previous) {
      const next = Object.assign({}, previous);
      next[id] = Object.assign({}, next[id], { [key]: value });
      return next;
    });
  }, []);

  if (!cases.length) return h(Empty, null, 'no cases generated yet');
  const changed = dirty(cases, draft);

  function approve() {
    const edited = cases.map(function (item) {
      const local = draft[item.id] || {};
      // Both fields are arrays on the wire. lib/plan.js:488-495 only applies a
      // patch when the value is an array and its joined text differs, so sending
      // `expected` as the textarea string silently dropped every expected-result
      // edit while still reporting a clean approval.
      const lines = function (value) {
        return String(value || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
      };
      return {
        id: item.id,
        title: local.title,
        priority: local.priority,
        steps: lines(local.steps),
        expected: lines(local.expected),
        selected: local.selected !== false,
      };
    });
    props.run('approve', { cases: edited, decision: 'approved', note: note || null });
  }

  function reject() {
    props.run('approve', { cases: [], decision: 'rejected', note: note || null });
  }

  return h('div', { className: 'at-gate' },
    h('div', { className: 'at-gate-title' },
      'Review gate: ' + cases.filter(function (item) { return item.selected !== false; }).length + ' of ' + cases.length + ' selected',
    ),
    h('div', { className: 'at-muted' }, 'Scripts are written only after you approve. Edits bump the revision and close the gate again until re-approved.'),
    h('table', { className: 'at-table' },
      h('thead', null, h('tr', null,
        h('th', { style: { width: '28px' } }, ''),
        h('th', { style: { width: '64px' } }, 'id'),
        h('th', null, 'title'),
        h('th', { style: { width: '72px' } }, 'prio'),
        h('th', null, 'steps'),
        h('th', null, 'expected'),
      )),
      h('tbody', null, cases.map(function (item) {
        const local = draft[item.id] || {};
        const stale = typeof item.revision === 'number' && typeof item.approvedRevision === 'number' && item.revision > item.approvedRevision;
        return h('tr', { key: item.id },
          h('td', null, h('input', {
            type: 'checkbox',
            checked: local.selected !== false,
            onChange: function (event) { edit(item.id, 'selected', event.target.checked); },
          })),
          h('td', null, h(Chip, { title: stale ? 'edited after the last approval' : null }, item.id + (stale ? ' *' : ''))),
          h('td', { className: 'at-editable' }, h('input', {
            className: 'at-input',
            value: local.title || '',
            onChange: function (event) { edit(item.id, 'title', event.target.value); },
          })),
          h('td', null, h('select', {
            className: 'at-input',
            value: local.priority || 'P2',
            onChange: function (event) { edit(item.id, 'priority', event.target.value); },
          }, ['P0', 'P1', 'P2', 'P3'].map(function (value) { return h('option', { key: value, value }, value); }))),
          h('td', { className: 'at-editable' }, h('textarea', {
            className: 'at-input',
            rows: 2,
            value: local.steps || '',
            onChange: function (event) { edit(item.id, 'steps', event.target.value); },
          })),
          h('td', { className: 'at-editable' }, h('textarea', {
            className: 'at-input',
            rows: 2,
            value: local.expected || '',
            onChange: function (event) { edit(item.id, 'expected', event.target.value); },
          })),
        );
      })),
    ),
    h('div', { className: 'at-actions' },
      h(Button, { kind: 'primary', disabled: props.busy, onClick: approve }, changed ? 'Approve edits' : 'Approve'),
      h(Button, { kind: 'danger', disabled: props.busy, onClick: reject }, 'Reject'),
      h('input', {
        className: 'at-input',
        style: { maxWidth: '260px' },
        placeholder: 'review note (optional)',
        value: note,
        onChange: function (event) { setNote(event.target.value); },
      }),
      changed ? h('span', { className: 'at-warn' }, 'edits pending - they bump every touched case to a new revision') : null,
    ),
    state && state.coverage ? h('div', { className: 'at-muted' },
      'coverage ' + Math.round((state.coverage.ratio || 0) * 100) + '% (' + (state.coverage.covered || 0) + '/' + (state.coverage.total || 0) + ' features); ' +
      (state.duplicates && state.duplicates.length ? state.duplicates.length + ' duplicate title(s)' : 'no duplicate titles'),
    ) : null,
  );
}
