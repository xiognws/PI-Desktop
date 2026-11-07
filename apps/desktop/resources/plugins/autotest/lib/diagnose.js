'use strict';
/**
 * Failure analysis, split out from script repair on purpose.
 *
 * The legacy pipeline judged a failure and immediately rewrote the script,
 * which quietly assumed every failure was a script defect. Here the
 * classification is deterministic first, and only an explicit human decision
 * can turn "the product is wrong" or "the rig is wrong" into a rewrite.
 */

const schema = require('./schema');

const RULES = [
  {
    kind: 'environment',
    weight: 100,
    patterns: [
      /ECONNREFUSED/i,
      /ENOTFOUND/i,
      /EADDRINUSE/i,
      /Could not connect to the debug server/i,
      /device (not found|offline|unauthori[sz]ed)/i,
      /No such device/i,
      /libusb.*(not found|open failed)/i,
      /permission denied.*(tty|usb|port)/i,
      /No module named ['"]?pyserial|No module named ['"]?pyvisa/i,
      /Timeout waiting for the target/i,
      /rig .* (unavailable|not responding)/i,
    ],
  },
  {
    kind: 'script',
    weight: 80,
    patterns: [
      /SyntaxError/i,
      /IndentationError/i,
      /ReferenceError/i,
      /TypeError: Cannot read propert/i,
      /ModuleNotFoundError/i,
      /ImportError/i,
      /Cannot find module/i,
      /ERR_MODULE_NOT_FOUND/i,
      /is not defined/i,
      /unexpected token/i,
      /AttributeError: 'NoneType'/i,
    ],
  },
  {
    kind: 'assertion',
    weight: 60,
    patterns: [
      /AssertionError/i,
      /^\.?\.?F{1,}/,
      /expected .* (but )?(got|received|actual)/i,
      /Expected .* to (be|equal|contain)/i,
      /\bassert_eq\b/i,
      /\bassert\.(strictEqual|deepEqual|ok)\b/i,
      /FAILED .*::/,
    ],
  },
  {
    kind: 'flaky',
    weight: 40,
    patterns: [
      /EAI_AGAIN/i,
      /socket hang up/i,
      /Timed out retrying/i,
      /ECONNRESET/i,
      /element is not (attached|interactable)/i,
      /stale element/i,
    ],
  },
];

/** Score one stream of text against every rule and return the best matches. */
function matchRules(text) {
  const haystack = String(text == null ? '' : text);
  if (!haystack) return [];
  return RULES.map(function (rule) {
    const hits = rule.patterns.filter(function (pattern) {
      return pattern.test(haystack);
    }).map(function (pattern) {
      return String(pattern);
    });
    return { kind: rule.kind, weight: rule.weight, hits: hits };
  })
    .filter(function (entry) {
      return entry.hits.length > 0;
    })
    .sort(function (a, b) {
      return b.weight * b.hits.length - a.weight * a.hits.length;
    });
}

/**
 * Classify one run record.
 * Returns { kind, confidence, evidence, needsRepair, reason }.
 * needsRepair is true only for classes a script change can plausibly fix.
 */
function classifyRun(run) {
  const record = run || {};
  const status = String(record.status || 'unknown');
  if (status === 'passed') {
    return { kind: 'unknown', confidence: 0, evidence: [], needsRepair: false, reason: 'run passed' };
  }
  if (status === 'skipped') {
    return {
      kind: 'environment',
      confidence: 0.5,
      evidence: [String(record.reason || 'skipped')],
      needsRepair: false,
      reason: 'script never executed, so nothing about the product is known',
    };
  }
  if (status === 'timeout') {
    const matches = matchRules(record.stderr);
    const kind = matches.length > 0 && matches[0].kind === 'environment' ? 'environment' : 'flaky';
    return {
      kind: kind,
      confidence: 0.6,
      evidence: ['timeout after ' + String(record.durationMs || 0) + 'ms'].concat(
        matches.map(function (entry) {
          return entry.hits.join(', ');
        }),
      ),
      needsRepair: kind === 'flaky',
      reason: kind === 'flaky' ? 'run exceeded the deadline' : 'the rig stopped answering before the deadline',
    };
  }
  const matches = matchRules(String(record.stderr || '') + '\n' + String(record.stdout || ''));
  if (matches.length === 0) {
    return {
      kind: 'unknown',
      confidence: 0.2,
      evidence: ['exit code ' + String(record.exitCode)],
      needsRepair: false,
      reason: 'no deterministic signature matched; needs a human or model review',
    };
  }
  const best = matches[0];
  const confidence = Math.min(0.95, 0.4 + 0.15 * best.hits.length);
  return {
    kind: best.kind,
    confidence: confidence,
    evidence: matches.slice(0, 3).map(function (entry) {
      return entry.kind + ': ' + entry.hits.join(', ');
    }),
    needsRepair: best.kind === 'script' || best.kind === 'assertion',
    reason: best.kind === 'assertion' ? 'the run reached an assertion, so the product answered' : 'matched ' + best.kind + ' signature',
  };
}

/** Classify a whole execution and summarise the mix. */
function classifyBatch(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const classified = list.map(function (run) {
    return Object.assign({ testCaseId: run.testCaseId, status: run.status }, classifyRun(run));
  });
  const counts = {};
  schema.FAILURE_CLASSES.forEach(function (kind) {
    counts[kind] = 0;
  });
  classified.forEach(function (entry) {
    if (entry.status === 'passed') return;
    counts[entry.kind] = (counts[entry.kind] || 0) + 1;
  });
  const failed = classified.filter(function (entry) {
    return entry.status !== 'passed';
  });
  const humanOnly = failed.filter(function (entry) {
    return schema.HUMAN_ONLY_CLASSES.indexOf(entry.kind) !== -1;
  });
  return {
    total: list.length,
    passed: list.filter(function (run) {
      return run.status === 'passed';
    }).length,
    failed: failed.length,
    counts: counts,
    entries: classified,
    blocking: humanOnly.map(function (entry) {
      return entry.testCaseId + ': ' + entry.kind;
    }),
    recommendation:
      humanOnly.length > 0
        ? 'stop: ' + humanOnly.length + ' failure(s) point at the environment or the product, not the script'
        : failed.length === 0
          ? 'all approved cases passed'
          : 'review the script-side failures before asking for a rewrite',
  };
}

module.exports = { RULES, matchRules, classifyRun, classifyBatch };
