'use strict';
/**
 * pi.autotest - a software and hardware integration test workbench.
 *
 * The plugin contributes eight agent tools and three renderer slots. It owns no
 * window, no port and no database: plans live as directories under the plugin
 * data path, and every review decision happens inside the conversation that
 * produced the artifact.
 */

const fs = require('node:fs');
const path = require('node:path');

const plan = require('./lib/plan');
const runner = require('./lib/runner');
const stages = require('./lib/stages');
const report = require('./lib/report');
const llm = require('./lib/llm');

const PLAN_ID = {
  type: 'string',
  description: 'Plan id returned by autotest_requirement.',
};

const TEST_CASE_IDS = {
  type: 'array',
  items: { type: 'string' },
  description: 'Test case ids such as TC-001.',
};

const TOOLS = [
  {
    name: 'autotest_requirement',
    description:
      'Stage 1 of the autotest workbench. Turn requirement text, a file path or a document reference into a feature breakdown with acceptance criteria and an explicit gap list. Creates a plan when planId is omitted.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['decompose'], description: 'Only "decompose" is supported.' },
        title: { type: 'string', description: 'Human readable plan title.' },
        source: { type: 'string', description: 'Requirement text, or a path or reference to the material.' },
        sourceKind: { type: 'string', enum: ['text', 'file', 'document', 'url'], description: 'How to read source.' },
        sourceRef: { type: 'string', description: 'Original location of the material, for traceability.' },
        planId: { ...PLAN_ID, description: 'Reuse an existing plan instead of creating one.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'autotest_cases',
    description:
      'Stage 2. Generate test cases from the approved feature list. The result is presented for human review and nothing downstream may consume it before approval.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['generate', 'regenerate'], description: 'Regenerate discards the previous case set.' },
        planId: PLAN_ID,
        regenerate: { type: 'boolean', description: 'Allow running even if the stage check would block.' },
      },
      required: ['action', 'planId'],
    },
  },
  {
    name: 'autotest_author',
    description:
      'Stage 3. Write one runnable script per approved test case. Refuses to run while the case set is unapproved, so materialised code always traces back to a reviewed case.',
    risk: 'medium',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write'], description: 'Only "write" is supported.' },
        planId: PLAN_ID,
        testCaseIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional subset of case ids to author in this call. Batch at most 3 per call — every script needs its own model call, and one tool call has a bounded budget.',
        },
      },
      required: ['action', 'planId'],
    },
  },
  {
    name: 'autotest_run',
    description:
      'Stage 4. Execute the approved scripts with a bounded timeout and captured output. Never runs before an approved case set exists.',
    risk: 'medium',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['execute'], description: 'Only "execute" is supported.' },
        planId: PLAN_ID,
        testCaseIds: { ...TEST_CASE_IDS, description: 'Run only these cases; omit to run every script.' },
        timeoutMs: { type: 'number', description: 'Per script timeout in milliseconds.' },
        cwd: { type: 'string', description: 'Working directory for the scripts.' },
      },
      required: ['action', 'planId'],
    },
  },
  {
    name: 'autotest_status',
    description:
      'Read-only. Summarise one plan, or list every plan when planId is omitted: stage rail, coverage, review gate, last run and artifacts.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status'], description: 'Only "status" is supported.' },
        planId: { ...PLAN_ID, description: 'Omit to list all plans.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'autotest_select',
    description:
      'Adjust which reviewed cases take part in the next run. Selection never approves a case; the gate still requires an explicit approval.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['select', 'deselect'], description: 'Select or deselect the listed cases.' },
        planId: PLAN_ID,
        testCaseIds: TEST_CASE_IDS,
        selected: { type: 'boolean', description: 'Explicit target state; omit to select the listed ids.' },
      },
      required: ['action', 'planId', 'testCaseIds'],
    },
  },
  {
    name: 'autotest_diagnose',
    description:
      'Stage 5. Classify the failures of the last run deterministically first (environment, script, assertion, product, flaky, unknown), then ask the model only for narrative. Reports blocking failures that a script rewrite must not paper over.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['diagnose'], description: 'Only "diagnose" is supported.' },
        planId: PLAN_ID,
      },
      required: ['action', 'planId'],
    },
  },
  {
    name: 'autotest_report',
    description:
      'Stage 6. Render the plan into markdown with the stage rail, coverage, gate state, diagnosis and audit trail, and write report.md next to the plan state.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['report'], description: 'Only "report" is supported.' },
        planId: PLAN_ID,
      },
      required: ['action', 'planId'],
    },
  },
];

/** Actions that only read state, so Plan and Goal modes may surface them. */
const PLAN_SAFE = {
  autotest_requirement: [],
  autotest_cases: [],
  autotest_author: [],
  autotest_run: [],
  autotest_status: ['status'],
  autotest_select: [],
  autotest_diagnose: [],
  autotest_report: [],
};

let pi = null;
let currentPi = null;
/** The per-invocation log sink the host hands to tool.execute. */
let activeLog = null;

/**
 * Diagnostics to the host log.
 *
 * A tool handler has no way to surface progress: returning early is the only
 * answer the model sees, and the host's 110s timeout replaces any thrown error
 * with "did not answer call". `pi.plugin.log` is the only channel that survives
 * that, so the tool wrapper reports each boundary there.
 */
function log(message) {
  const text = String(message == null ? '' : message);
  // pi.sendMessage is not a log channel; the child process only forwards a
  // 'log' frame for the per-invocation `log` handed to tool.execute
  // (plugin-host-process.mjs:667). toolContext keeps that sink on ctx, and the
  // fallback writes to stderr, which the host captures as a warn frame.
  try {
    if (activeLog && typeof activeLog === 'function') {
      activeLog(text);
      return;
    }
  } catch (ignored) {
    // Logging must never be the reason a tool handler fails.
  }
  try {
    process.stderr.write('[autotest] ' + text + String.fromCharCode(10));
  } catch (ignored) {
    // Same: a broken stderr is not a tool failure.
  }
}

/**
 * Resolve the plugin settings.
 *
 * `pi.plugin.getSettings()` answers a promise (plugin-sdk `index.ts:1333`
 * declares `getSettings: () => Promise<Record<string, unknown>>`), and the
 * promise is what lands in `ctx.settings`. Every `ctx.settings.foo` read is
 * then `undefined`, so mock mode, the case budget and a configured runner were
 * silently ignored. Await it, and never overwrite it with an unresolved value.
 */
async function pluginSettings(pi) {
  const reader = pi && pi.plugin && pi.plugin.getSettings;
  if (typeof reader !== 'function') return {};
  try {
    const value = await reader.call(pi.plugin);
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    return {};
  }
}

/**
 * The plan root. `pi.plugin.getDataPath()` may answer a promise (the host
 * implements it like getSettings, as a parent call), and path.join never
 * awaits: resolving it here is the only place that can.
 */
async function pluginDataDir(pi) {
  const reader = pi && pi.plugin && pi.plugin.getDataPath;
  if (typeof reader !== 'function') return null;
  const value = await reader.call(pi.plugin);
  return typeof value === 'string' && value ? path.join(value, 'autotest') : null;
}

async function toolContext(toolCtx, extra) {
  // Identity comes last: a caller-supplied extra must never replace `pi`.
  return Object.assign(
    {},
    extra || {},
    {
      pi: currentPi,
      modelKey: toolCtx && toolCtx.modelKey,
      signal: toolCtx && toolCtx.signal,
      toolCallId: toolCtx && toolCtx.toolCallId,
      workspacePath: toolCtx && toolCtx.workspacePath,
      settings: await pluginSettings(currentPi),
      dataDir: await pluginDataDir(currentPi),
      log: activeLog || undefined,
      runtimes: {
        // The probe must run in the workspace, not in the host process cwd, and
        // the whole tool call has a 110s host budget. A probe that burns it
        // reports "exceeded" long after the caller already gave up, so the
        // short PROBE_TIMEOUT_MS is passed explicitly here rather than relying
        // on selfCheck's own default.
        selfCheck: async function (options) {
          const probe = await runner.selfCheck({
            cwd: (toolCtx && toolCtx.workspacePath) || process.cwd(),
            settings: (options && options.settings) || {},
            timeoutMs: runner.PROBE_TIMEOUT_MS,
          });
          // A probe that times out inside the host process says almost nothing,
          // so report what the probe's own record carries: the interpreter path,
          // the platform, and the stdout/stderr of the attempt. The host redacts
          // absolute paths in plugin.log, so the version string is the useful part.
          log(
            'probe ' +
              (probe.ok ? 'ok' : 'failed') +
              ' node=' +
              String(probe.node || '-') +
              ' platform=' +
              String(probe.platform || '-') +
              ' detail=' +
              String(probe.detail || '-').slice(0, 200),
          );
          return probe;
        },
      },
    },
  );
}

function wrap(fn) {
  return async function execute(args, toolCtx) {
    const started = Date.now();
    // The host answers a rejected tool call with "plugin pi.autotest did not
    // answer call" after its 110s budget (plugin-runtime.ts:2703-2707), which
    // names neither the stage nor the error. Report each boundary through the
    // per-invocation sink so plugin.log shows where a slow handler stopped.
    activeLog = typeof (toolCtx && toolCtx.log) === 'function' ? toolCtx.log : null;
    try {
      const entry = String((args && args.action) || '');
      log('tool start ' + entry + ' session=' + String((toolCtx && toolCtx.sessionId) || '-'));
      const ctx = await toolContext(toolCtx);
      log('tool context ready modelKey=' + String(ctx.modelKey || '-') + ' dataDir=' + String(ctx.dataDir || '-'));
      const result = await fn(ctx, args || {}, toolCtx);
      log('tool done ' + entry + ' in ' + (Date.now() - started) + 'ms');
      return Object.assign({ ok: true, durationMs: Date.now() - started }, result, {
        planId: result.planId || (args && args.planId) || null,
      });
    } catch (error) {
      log('tool failed ' + String((error && error.code) || 'AUTOTEST_FAILED') + ': ' + String(error && error.message).slice(0, 300));
      return {
        ok: false,
        durationMs: Date.now() - started,
        code: error.code || 'AUTOTEST_FAILED',
        message: error.message,
        planId: (args && args.planId) || null,
      };
    } finally {
      activeLog = null;
    }
  };
}

function registerTools(pi) {
  const handlers = {
    autotest_requirement: wrap(function (ctx, args) {
      return plan.requirement(ctx, args);
    }),
    autotest_cases: wrap(function (ctx, args) {
      return plan.cases(ctx, Object.assign({}, args, { regenerate: args.action === 'regenerate' || args.regenerate === true }));
    }),
    autotest_author: wrap(function (ctx, args) {
      return plan.author(ctx, args);
    }),
    autotest_run: wrap(function (ctx, args) {
      return plan.run(ctx, args);
    }),
    autotest_status: wrap(function (ctx, args) {
      return plan.status(ctx, args);
    }),
    autotest_select: wrap(function (ctx, args) {
      return plan.select(ctx, Object.assign({}, args, { selected: args.action === 'deselect' ? false : args.selected }));
    }),
    autotest_diagnose: wrap(function (ctx, args) {
      return plan.diagnoseTool(ctx, args);
    }),
    autotest_report: wrap(function (ctx, args) {
      return plan.reportTool(ctx, args);
    }),
  };
  return TOOLS.map(function (definition) {
    return {
      definition: definition,
      handler: handlers[definition.name],
    };
  });
}

/**
 * The host calls onLoad() with no arguments (plugin-host-process.mjs:593
 * `await pluginModule.onLoad()`); the api object only exists on
 * globalThis.pi, set at :582 before the module is even loaded. Reading a
 * parameter instead left `pi` null, so onUnload threw
 * "Cannot read properties of null (reading 'agent')" and the next enable was
 * reported as PLUGIN_LOAD_FAILED.
 */
async function onLoad() {
  pi = globalThis.pi || pi;
  currentPi = pi;
  const registered = registerTools(pi);
  for (const entry of registered) {
    await pi.agent.registerTool({
      name: entry.definition.name,
      description: entry.definition.description,
      risk: entry.definition.risk,
      schema: entry.definition.schema,
      planSafeActions: PLAN_SAFE[entry.definition.name] || [],
      execute: entry.handler,
    });
  }
}

async function onUnload() {
  for (const definition of TOOLS) {
    await pi.agent.unregisterTool(definition.name);
  }
}

/**
 * Renderer bridge. The renderer may ask for status and submit a review
 * decision; it may never start a run or edit a script, so the trust boundary
 * stays on the tool side.
 */
async function onRendererCall(method, payload) {
  if (method === 'meta') {
    const toolNames = TOOLS.map(function (definition) {
      return definition.name;
    });
    return {
      pluginId: (pi.plugin && pi.plugin.getId && pi.plugin.getId()) || 'pi.autotest',
      stages: stages.rail ? ['requirements', 'cases', 'scripts', 'run', 'verdict', 'report'] : [],
      tools: toolNames,
      rendererActions: ['status', 'approve', 'select', 'reveal', 'meta'],
    };
  }
  try {
    const result = await plan.callRendererAction(await toolContext(null), method, payload);
    return result;
  } catch (error) {
    throw Object.assign(new Error(error.message), { code: error.code || 'RENDERER_FAILED' });
  }
}

module.exports = { onLoad, onUnload, onRendererCall, TOOLS, PLAN_SAFE, registerTools };