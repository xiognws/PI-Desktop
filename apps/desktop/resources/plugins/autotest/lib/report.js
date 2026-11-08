'use strict';
/**
 * Report rendering. Pure functions over plan state so the same document can go
 * to markdown, to the tool card, and to an artifact file.
 */

const schema = require('./schema');
const stages = require('./stages');

function pct(value) {
  return Math.round((Number(value) || 0) * 100) + '%';
}

function countBy(list, key) {
  const out = {};
  (Array.isArray(list) ? list : []).forEach(function (entry) {
    const value = entry && entry[key] != null ? entry[key] : 'unknown';
    out[value] = (out[value] || 0) + 1;
  });
  return out;
}

/** Headline numbers for the tool card and the report. */
function summarize(state) {
  const cases = Array.isArray(state.cases) ? state.cases : [];
  const selected = cases.filter(function (entry) {
    return entry.selected !== false;
  });
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;
  const results = latestRun && Array.isArray(latestRun.results) ? latestRun.results : [];
  const passed = results.filter(function (entry) {
    return entry.status === 'passed';
  }).length;
  const covered = stages.coverage(state);
  const gate = stages.reviewGate(state);
  return {
    planId: state.id,
    title: state.title,
    status: state.status,
    activeStage: state.activeStage,
    stages: schema.STAGES.map(function (stage) {
      const value = state.stages[stage] || {};
      return {
        stage: stage,
        label: schema.STAGE_LABELS[stage],
        status: value.status || 'idle',
        updatedAt: value.updatedAt || null,
        note: value.note || null,
      };
    }),
    features: (state.features || []).length,
    cases: cases.length,
    selectedCases: selected.length,
    scripts: (state.scripts || []).length,
    runnableScripts: (state.scripts || []).filter(function (entry) {
      return entry.language && entry.body;
    }).length,
    runs: runs.length,
    lastRun: latestRun
      ? {
          id: latestRun.id,
          at: latestRun.at,
          total: results.length,
          passed: passed,
          failed: results.length - passed,
          skipped: results.filter(function (entry) {
            return entry.status === 'skipped';
          }).length,
        }
      : null,
    coverage: covered,
    gate: gate,
    priorities: countBy(selected, 'priority'),
  };
}

function renderMarkdown(state) {
  const sum = summarize(state);
  const lines = [];
  lines.push('# ' + (state.title || state.id));
  lines.push('');
  lines.push('Plan: `' + sum.planId + '`  Status: **' + sum.status + '**  Stage: ' + sum.activeStage);
  lines.push('');
  lines.push('## Stage rail');
  lines.push('');
  lines.push('| Stage | Status | Updated | Note |');
  lines.push('| --- | --- | --- | --- |');
  sum.stages.forEach(function (entry) {
    lines.push(
      '| ' + entry.label + ' | ' + entry.status + ' | ' + (entry.updatedAt || '-') + ' | ' + (entry.note || '-') + ' |',
    );
  });
  lines.push('');
  lines.push('## Coverage and gate');
  lines.push('');
  lines.push('- Feature coverage: ' + sum.coverage.covered + '/' + sum.coverage.total + ' (' + pct(sum.coverage.ratio) + ')');
  if (sum.coverage.missing.length > 0) lines.push('- Uncovered features: ' + sum.coverage.missing.join(', '));
  lines.push('- Cases: ' + sum.cases + ' total, ' + sum.selectedCases + ' selected for execution');
  lines.push('- Review gate: ' + (sum.gate.ok ? 'open' : 'closed - ' + sum.gate.reason));
  lines.push('');
  if (sum.lastRun) {
    lines.push('## Last run');
    lines.push('');
    lines.push(
      '- ' +
        sum.lastRun.id +
        ': ' +
        sum.lastRun.passed +
        ' passed / ' +
        sum.lastRun.failed +
        ' failed / ' +
        sum.lastRun.skipped +
        ' skipped of ' +
        sum.lastRun.total,
    );
    lines.push('');
  }
  const verdicts = Array.isArray(state.verdicts) ? state.verdicts : [];
  if (verdicts.length > 0) {
    const latest = verdicts[verdicts.length - 1];
    lines.push('## Diagnosis');
    lines.push('');
    lines.push('- Recommendation: ' + (latest.recommendation || '-'));
    if (latest.counts) {
      lines.push(
        '- Failure classes: ' +
          Object.keys(latest.counts)
            .filter(function (key) {
              return latest.counts[key] > 0;
            })
            .map(function (key) {
              return key + '=' + latest.counts[key];
            })
            .join(', '),
      );
    }
    if (latest.blocking && latest.blocking.length > 0) {
      lines.push('- Blocking (not a script problem): ' + latest.blocking.join('; '));
    }
    lines.push('');
  }
  lines.push('## Cases');
  lines.push('');
  lines.push('| ID | Priority | Title | Feature | Selected |');
  lines.push('| --- | --- | --- | --- | --- |');
  (state.cases || []).forEach(function (entry) {
    lines.push(
      '| ' +
        entry.id +
        ' | ' +
        (entry.priority || '-') +
        ' | ' +
        String(entry.title || '').replace(/\|/g, '\\|') +
        ' | ' +
        (entry.featureId || '-') +
        ' | ' +
        (entry.selected === false ? 'no' : 'yes') +
        ' |',
    );
  });
  lines.push('');
  lines.push('## Audit trail');
  lines.push('');
  (state.approvals || []).forEach(function (entry) {
    lines.push('- ' + entry.at + ' ' + entry.kind + ' ' + entry.decision + (entry.actor ? ' by ' + entry.actor : ''));
  });
  if ((state.approvals || []).length === 0) lines.push('- no approvals recorded');
  lines.push('');
  return lines.join('\n');
}

module.exports = { summarize, renderMarkdown, countBy, pct };
