// Tool result cards. Each renderer is registered against one agent tool name and
// reads the tool result the host already has, so no extra round-trip is needed
// to show what a run produced.
import { h, Button, Chip, Empty, Pre, StatusLine, formatMs } from './ui.mjs';
import { ReviewGate, RAIL_STATUS } from './gate.mjs';

export { ReviewGate };

/**
 * The rail projection `lib/stages.js:66-90` sends is keyed by `state`, not by
 * the stage-status vocabulary: done | failed | awaiting_review | running |
 * ready | locked. Map it once, here, so every consumer paints the same way a
 * missing entry can never look "running".
 */
export function StageRailView(props) {
  const rail = props.rail || { stages: [] };
  return h('div', { className: 'at-rail' }, (rail.stages || []).map(function (entry) {
    return h('span', {
      key: entry.stage,
      className: 'at-stage',
      'data-status': RAIL_STATUS[entry.state] || entry.state || 'pending',
      'data-current': rail.cursor === entry.stage ? 'yes' : 'no',
      title: entry.reason || entry.note || entry.status || null,
    }, entry.label || entry.stage);
  }));
}

function resultOf(props) {
  const value = props.toolResult;
  if (!value || typeof value !== 'object') return null;
  return value;
}

function failureOf(props) {
  if (props.toolStatus !== 'error') return null;
  const value = resultOf(props);
  if (value && value.message) return value.code ? value.code + ': ' + value.message : value.message;
  return props.toolError || 'tool failed';
}

function Shell(props) {
  return h('div', { className: 'at-root' },
    h('div', { className: 'at-head' },
      h('span', { className: 'at-title' }, props.title),
      props.planId ? h(Chip, { title: props.planId }, props.planId) : null,
      props.status ? h(Chip, null, props.status) : null,
      typeof props.durationMs === 'number' ? h('span', { className: 'at-muted' }, formatMs(props.durationMs)) : null,
      props.toolStatus === 'running' ? h('span', { className: 'at-muted' }, 'running') : null,
    ),
    h(StatusLine, { error: failureOf(props) }),
    props.children,
  );
}

export function RequirementCard(props) {
  const value = resultOf(props) || {};
  const features = value.features || [];
  const gaps = value.gaps || [];
  return h(Shell, Object.assign({}, props, { title: 'Requirement decomposition' }),
    features.length ? h('table', { className: 'at-table' },
      h('thead', null, h('tr', null, h('th', null, 'id'), h('th', null, 'feature'), h('th', null, 'acceptance'))),
      h('tbody', null, features.map(function (item, index) {
        return h('tr', { key: item.id || index },
          h('td', null, h(Chip, null, item.id || 'F-' + (index + 1))),
          h('td', null, item.title || ''),
          h('td', null, Array.isArray(item.acceptance) ? item.acceptance.join('; ') : (item.acceptance || '')),
        );
      })),
    ) : h(Empty, null, 'no features extracted'),
    gaps.length ? h('div', null,
      h('div', { className: 'at-warn' }, 'gaps the source does not answer (' + gaps.length + ')'),
      h('ul', { className: 'at-list' }, gaps.map(function (gap, index) {
        return h('li', { key: index }, typeof gap === 'string' ? gap : (gap.title || gap.question || JSON.stringify(gap)));
      })),
    ) : null,
    value.gapsDecision === false ? h('div', { className: 'at-warn' }, 'gaps were not confirmed; case generation assumes the answers above') : null,
  );
}

export function CasesCard(props) {
  const value = resultOf(props) || {};
  const cases = value.cases || [];
  // The host reports the gate, not a status string: awaiting review shows up as
  // cases that still carry an unapproved revision.
  const awaiting = cases.some(function (item) {
    return item.approvedRevision === null || item.approvedRevision === undefined || item.revision > item.approvedRevision;
  });
  return h(Shell, Object.assign({}, props, { title: 'Case set' }),
    h('div', { className: 'at-muted' },
      cases.length + ' case(s); ' +
      (value.coverage ? 'coverage ' + Math.round((value.coverage.ratio || 0) * 100) + '%' : 'coverage n/a') + '; ' +
      ((value.duplicates && value.duplicates.length) ? value.duplicates.length + ' duplicate(s)' : 'no duplicates'),
    ),
    awaiting ? h(ReviewGate, { state: value, run: props.run, busy: props.busy }) : null,
    value.review ? h('div', { className: 'at-muted' }, value.review) : null,
    awaiting ? null : h('table', { className: 'at-table' },
      h('thead', null, h('tr', null, h('th', null, 'id'), h('th', null, 'title'), h('th', null, 'prio'), h('th', null, 'feature'), h('th', null, ''))),
      h('tbody', null, cases.map(function (item) {
        return h('tr', { key: item.id },
          h('td', null, h(Chip, null, item.id)),
          h('td', null, item.title || ''),
          h('td', null, item.priority || 'P2'),
          h('td', null, item.featureId || ''),
          h('td', null, item.selected === false ? h('span', { className: 'at-muted' }, 'deselected') : null),
        );
      })),
    ),
  );
}

export function ScriptsCard(props) {
  const value = resultOf(props) || {};
  const scripts = value.scripts || [];
  return h(Shell, Object.assign({}, props, { title: 'Generated scripts' }),
    scripts.length ? h('table', { className: 'at-table' },
      h('thead', null, h('tr', null, h('th', null, 'case'), h('th', null, 'lang'), h('th', null, 'lines'), h('th', null, 'file'))),
      h('tbody', null, scripts.map(function (item, index) {
        return h('tr', { key: item.testCaseId || index },
          h('td', null, h(Chip, null, item.testCaseId || '?')),
          h('td', null, item.language || ''),
          h('td', null, String(item.lines || 0)),
          h('td', { className: 'at-muted' }, item.file || ''),
        );
      })),
    ) : h(Empty, null, value.reason || 'no scripts written'),
    value.blockedReason ? h('div', { className: 'at-warn' }, value.blockedReason) : null,
  );
}

export function RunCard(props) {
  const value = resultOf(props) || {};
  const entries = value.results || value.entries || [];
  const last = value.summary || value.lastRun || {};
  return h(Shell, Object.assign({}, props, { title: 'Execution', status: last.failed ? 'failed' : 'passed' }),
    h('div', { className: 'at-muted' },
      (last.total || 0) + ' run(s): ' + (last.passed || 0) + ' passed, ' + (last.failed || 0) + ' failed, ' + (last.skipped || 0) + ' skipped',
    ),
    entries.length ? h('table', { className: 'at-table' },
      h('thead', null, h('tr', null, h('th', null, 'case'), h('th', null, 'status'), h('th', null, 'exit'), h('th', null, 'time'), h('th', null, 'class'))),
      h('tbody', null, entries.map(function (item, index) {
        const bad = item.status && item.status !== 'passed';
        return h('tr', { key: (item.testCaseId || index) + '-' + index },
          h('td', null, h(Chip, null, item.testCaseId || '?')),
          h('td', { className: bad ? 'at-bad' : 'at-ok' }, item.status || ''),
          h('td', null, item.exitCode === null || item.exitCode === undefined ? '-' : String(item.exitCode)),
          h('td', null, formatMs(item.durationMs) || '-'),
          h('td', null, item.reason || item.kind || ''),
        );
      })),
    ) : h(Empty, null, 'no run recorded'),
  );
}

export function DiagnoseCard(props) {
  const value = resultOf(props) || {};
  const entries = value.entries || [];
  const blocking = value.blocking || [];
  const counts = value.counts || value.summary || {};
  return h(Shell, Object.assign({}, props, { title: 'Failure analysis', status: value.repairAllowed ? 'repair allowed' : 'human required' }),
    blocking.length ? h('div', { className: 'at-danger' },
      h('div', { className: 'at-danger-title' }, 'stop: ' + blocking.length + ' failure(s) are not a script problem'),
      h('ul', { className: 'at-list' }, blocking.map(function (item, index) {
        return h('li', { key: index }, (item.testCaseId || '?') + ' - ' + (item.kind || 'unknown') + ': ' + (item.reason || ''));
      })),
    ) : null,
    h('div', { className: 'at-muted' },
      'classes: ' + Object.keys(counts).map(function (key) { return key + '=' + counts[key]; }).join(' '),
    ),
    value.narrative ? h(Pre, { text: value.narrative }) : null,
    entries.length ? h('table', { className: 'at-table' },
      h('thead', null, h('tr', null, h('th', null, 'case'), h('th', null, 'class'), h('th', null, 'conf'), h('th', null, 'repair?'))),
      h('tbody', null, entries.map(function (item, index) {
        return h('tr', { key: index },
          h('td', null, h(Chip, null, item.testCaseId || '?')),
          h('td', null, item.kind || 'unknown'),
          h('td', null, typeof item.confidence === 'number' ? item.confidence.toFixed(2) : '-'),
          h('td', null, item.needsRepair ? 'yes' : 'no'),
        );
      })),
    ) : null,
  );
}

export function ReportCard(props) {
  const value = resultOf(props) || {};
  return h(Shell, Object.assign({}, props, { title: 'Report' }),
    h('div', { className: 'at-kv' },
      h('dt', null, 'markdown'), h('dd', null, value.markdownPath || value.path || 'n/a'),
      h('dt', null, 'status'), h('dd', null, value.status || 'n/a'),
    ),
    value.summary ? h(Pre, { text: typeof value.summary === 'string' ? value.summary : JSON.stringify(value.summary, null, 2) }) : null,
  );
}

export function StatusCard(props) {
  const value = resultOf(props) || {};
  const state = value.state || null;
  const rail = value.rail || null;
  const plans = value.plans || [];
  if (plans.length && !state) {
    return h(Shell, Object.assign({}, props, { title: 'Plans' }),
      h('table', { className: 'at-table' },
        h('thead', null, h('tr', null, h('th', null, 'plan'), h('th', null, 'title'), h('th', null, 'stage'), h('th', null, 'status'))),
        h('tbody', null, plans.map(function (item) {
          return h('tr', { key: item.id },
            h('td', null, h(Chip, null, item.id)),
            h('td', null, item.title || ''),
            h('td', null, item.activeStage || ''),
            h('td', null, item.status || ''),
          );
        })),
      ),
    );
  }
  return h(Shell, Object.assign({}, props, { title: 'Plan status', status: state && state.status }),
    rail ? h(StageRailView, { rail: rail }) : null,
    state ? h('div', { className: 'at-kv' },
      h('dt', null, 'active stage'), h('dd', null, state.activeStage || '-'),
      h('dt', null, 'features'), h('dd', null, String((state.features || []).length)),
      h('dt', null, 'cases'), h('dd', null, String((state.cases || []).length)),
      h('dt', null, 'scripts'), h('dd', null, String((state.scripts || []).length)),
      h('dt', null, 'gate'), h('dd', null, value.gate && value.gate.ok ? 'open' : 'closed' + (value.gate && value.gate.reason ? ' (' + value.gate.reason + ')' : '')),
    ) : null,
  );
}