'use strict';
/**
 * Model access. All prompting goes through one adapter so the workflow can be
 * exercised with a stub in tests and with the host-configured model at runtime.
 * There is no local model deployment: the host already owns the provider.
 */

const schema = require('./schema');

const MOCK_ENV = 'AUTOTEST_MOCK_MODE';

function isMockMode(settings) {
  if (settings && settings.mockMode === true) return true;
  if (settings && settings.mockMode === false) return false;
  return process.env[MOCK_ENV] === '1' || process.env[MOCK_ENV] === 'true';
}

/** Strip a code fence and pull the first JSON value out of a model reply. */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch (error) {
          return null;
        }
      }
    }
  }
  return null;
}

function truncate(value, limit) {
  const text = String(value == null ? '' : value);
  const max = limit || 12000;
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n[...truncated ' + (text.length - max) + ' chars]';
}

/**
 * Call the host model and require a JSON object answer.
 * Throws MODEL_OUTPUT_INVALID with the raw reply when parsing fails so the
 * caller can decide between a retry and surfacing the defect.
 */
async function completeJson(pi, request) {
  const prompt = buildPrompt(request);
  const reply = await callModel(pi, prompt, request);
  const parsed = extractJson(reply);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('model did not return a JSON object for ' + String(request.purpose));
    error.code = 'MODEL_OUTPUT_INVALID';
    error.raw = truncate(reply, 4000);
    throw error;
  }
  return { data: parsed, raw: reply };
}

async function completeText(pi, request) {
  const prompt = buildPrompt(request);
  return callModel(pi, prompt, request);
}

function buildPrompt(request) {
  const parts = [];
  if (request.system) parts.push(request.system);
  if (request.context) parts.push('## Context\n' + truncate(request.context, 24000));
  parts.push('## Task\n' + request.instruction);
  if (request.jsonSchemaHint) {
    parts.push('## Output\nReturn exactly one JSON object, no prose and no code fence. Shape:\n' + request.jsonSchemaHint);
  }
  return parts.join('\n\n');
}

/**
 * Resolve the modelKey the host accepts.
 *
 * `agent.complete` refuses anything without a "/" — the host wants
 * `providerId/modelId` (apps/desktop/electron/main/plugin-runtime.ts:4820-4823
 * `modelKey must be providerId/modelId`). The tool context carries the host's
 * own session key, which is already in that shape in production, but a bare
 * model id (a test stub, a future tool context that only knows the model) must
 * not reach the host and come back as INVALID_ARGUMENT after the plan has
 * already been created and the run gate opened.
 */
function resolveModelKey(request) {
  const raw = request && request.modelKey ? String(request.modelKey) : '';
  if (!raw) return undefined;
  if (raw.indexOf('/') > 0) return raw;
  const settings = (request && request.settings) || {};
  const providerId = settings.defaultProviderId || settings.providerId;
  if (providerId && String(providerId).trim()) return String(providerId).trim() + '/' + raw;
  return undefined;
}

async function callModel(pi, prompt, request) {
  if (request.mock) return request.mock;
  if (isMockMode(request.settings)) return mockReply(request, prompt);
  if (!pi || !pi.agent || typeof pi.agent.complete !== 'function') {
    const error = new Error('host agent.complete is unavailable');
    error.code = 'MODEL_UNAVAILABLE';
    throw error;
  }
  // The host api is `agent.complete({ modelKey, system?, messages, thinkingLevel? })`
  // (apps/desktop/electron/main/plugin-runtime.ts:4815-4900 runAgentComplete). It
  // reads `input.messages` and ignores `prompt`, so sending a single prompt
  // string is a 110s silence, not an error: the tool call died with the host's
  // "did not answer call" timeout before anyone could see this shape was wrong.
  const response = await pi.agent.complete({
    modelKey: resolveModelKey(request),
    messages: [{ role: 'user', content: prompt }],
    thinkingLevel: request.thinkingLevel || 'off',
  });
  if (typeof response === 'string') return response;
  if (response && typeof response.text === 'string') return response.text;
  if (response && typeof response.content === 'string') return response.content;
  const error = new Error('host returned an unrecognised completion shape');
  error.code = 'MODEL_SHAPE_UNKNOWN';
  throw error;
}

/** Deterministic offline replies so the workflow can be exercised without a key. */
function mockReply(request, prompt) {
  const purpose = String(request.purpose || '');
  if (purpose === 'requirement') {
    return JSON.stringify({
      features: [
        {
          id: schema.featureId(0),
          title: 'Mock feature from ' + truncate(prompt, 40),
          description: 'Offline mock feature.',
          acceptance: ['Mock acceptance criterion one', 'Mock acceptance criterion two'],
          requirementRefs: [schema.requirementId(0)],
        },
      ],
      gaps: ['Offline mock run: this plan was produced without a model call.'],
    });
  }
  if (purpose === 'cases') {
    return JSON.stringify({
      cases: [
        {
          id: schema.caseId(0),
          title: 'Mock nominal case',
          featureId: schema.featureId(0),
          priority: 'P1',
          preconditions: ['Mock precondition'],
          steps: ['Mock step one', 'Mock step two'],
          expected: ['Mock expected result'],
          type: 'functional',
        },
      ],
    });
  }
  if (purpose === 'author') {
    return JSON.stringify({
      language: 'javascript',
      script: "console.log('mock autotest script');\n",
      command: null,
      notes: 'Offline mock script; no project command was configured.',
    });
  }
  if (purpose === 'diagnose') {
    return JSON.stringify({
      findings: [
        { segment: 'mock', kind: 'unknown', detail: 'Offline mock diagnosis; deterministic rules produced no match.' },
      ],
      summary: 'Offline mock diagnosis.',
    });
  }
  if (purpose === 'report') {
    return JSON.stringify({ summary: 'Offline mock report summary.' });
  }
  return JSON.stringify({ mock: true, purpose: purpose });
}

module.exports = {
  MOCK_ENV,
  isMockMode,
  extractJson,
  resolveModelKey,
  completeJson,
  completeText,
  buildPrompt,
  mockReply,
};
