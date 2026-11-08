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
const schema = require('./lib/schema');
const store = require('./lib/store');
const runner = require('./lib/runner');
const stages = require('./lib/stages');
const report = require('./lib/report');
const llm = require('./lib/llm');
const jobs = require('./lib/jobs');
const kb = require('./lib/kb');

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
        maxOutput: {
          type: 'number',
          description: 'Captured output retained per stream, in characters (default 4096).',
        },
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
/**
 * A plan root a synchronous caller can name.
 *
 * Every store reader needs a string root, but the host api only answers one
 * through an async call. A renderer action or a panel click that arrives before
 * the plugin finished loading, or in a context where nothing may await, then has
 * no root at all. PI_AUTOTEST_PLAN_ROOT pins it for those callers; unset, the
 * async path in pluginPlanRoot() stays the only answer.
 */
function syncPlanRoot() {
  const pinned = process.env.PI_AUTOTEST_PLAN_ROOT;
  if (pinned) {
    try {
      return fs.realpathSync.native(pinned);
    } catch (error) {
      return pinned;
    }
  }
  return null;
}

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
async function pluginPlanRoot(pi) {
  const reader = pi && pi.plugin && pi.plugin.getDataPath;
  if (typeof reader !== 'function') return null;
  // Bind the receiver explicitly: the host api is a proxy whose methods are not
  // guaranteed to be pure functions of their arguments, and an unbound call
  // inside a promise chain answers a different directory than the same call
  // outside it. Resolving once per call keeps every reader on one root.
  const value = await Promise.resolve(reader.call(pi.plugin));
  if (typeof value !== 'string' || !value) return null;
  // Resolve to one spelling. Windows reports the same directory as
  // C:\Users\ADMINI~1\... to mkdtemp and C:\Users\Administrator\... to the
  // host join, and every plan lookup in lib/store.js compares strings — a plan
  // written under one spelling is invisible to a reader holding the other, so
  // the panel listed a plan and then answered PLAN_NOT_FOUND for its own click
  // (2026-11-08). One realpath here covers every reader downstream.
  const root = path.join(value, 'autotest');
  try {
    return fs.realpathSync.native(root);
  } catch (error) {
    // The directory does not exist yet: the first write creates it, and a
    // resolved path is not available before that. Fall through rather than
    // failing a read that is only asking for an empty list.
    return root;
  }
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
      // A pinned root wins so a caller that cannot await still lands on one
      // directory; otherwise resolve through the host api as usual.
      dataDir: syncPlanRoot() || (await pluginPlanRoot(currentPi)),
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
  // The host resolves activationEvents to commands.register calls
  // (plugin-host-process.mjs:628-637 looks the id up in a Map filled only by
  // api.commands.register), so the toolbar command has to be registered here;
  // naming it in the manifest alone would leave a palette entry that runs
  // nothing.
  if (pi && pi.commands && typeof pi.commands.register === 'function') {
    await pi.commands.register({
      id: 'autotest.open',
      title: 'Autotest: open the workbench',
      keywords: ['autotest', 'test', 'qa', 'workbench', '测试', '工作台'],
      category: 'Autotest',
      run: revealWorkbench,
    });
    // The knowledge base lives in the same view, but it is a separate errand:
    // the palette entry opens the workbench already switched to that tab
    // (the view reads `tab` from the reveal payload), so a user hunting for a
    // saved requirement does not have to land on the rail first.
    await pi.commands.register({
      id: 'autotest.knowledge',
      title: 'Autotest: open the knowledge base',
      keywords: ['autotest', 'knowledge', 'reference', '知识库', '资料'],
      category: 'Autotest',
      run: function () {
        return revealWorkbench({ tab: 'knowledge' });
      },
    });
  }
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
  try {
    if (pi && pi.commands && typeof pi.commands.unregister === 'function') {
      await pi.commands.unregister('autotest.open');
      await pi.commands.unregister('autotest.knowledge');
    }
  } catch (ignored) {
    // Teardown clears the host-side table by plugin id anyway
    // (plugin-runtime.ts:3669-3671); a stale entry here would only outlive
    // the process if unload failed, and then the whole plugin is gone.
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

/* ------------------------------------------------------------------ views */

/**
 * Open the workbench in a work-panel tab.
 *
 * pi.ui.revealView is the only way in (packages/plugin-sdk/src/index.ts:1373,
 * needs the ui.view permission, implemented at plugin-runtime.ts:4652-4706).
 * It targets the *active session*, so a plugin command fired while no session
 * is open answers INVALID_ARGUMENT — that is the host contract, not a bug, and
 * the toast says which way to go instead of failing silently.
 */
async function revealWorkbench(options) {
  const ctx = { pi: pi };
  try {
    if (!pi || !pi.ui || typeof pi.ui.revealView !== 'function') {
      throw Object.assign(new Error('this host build has no ui.revealView'), { code: 'UNSUPPORTED' });
    }
    // `tab` is the plugin's own contract with its page, not a host field: an
    // older host ignores unknown members, and the page falls back to its first
    // tab when none arrives.
    await pi.ui.revealView({ viewId: 'workbench', tab: (options && options.tab) || null });
    return { ok: true };
  } catch (error) {
    const code = (error && error.code) || 'REVEAL_FAILED';
    log('info', 'reveal workbench failed: ' + code + ' ' + ((error && error.message) || ''));
    if (pi && pi.ui && typeof pi.ui.showToast === 'function') {
      // showToast takes (message, level) positionally — packages/plugin-sdk/src/index.ts:1366.
      // Handing it an object stringifies as "[object Object]" in the host
      // (plugin-runtime.ts:2500 does String(payload?.message)) and, when the
      // object reaches the renderer unbranded, React #31 tears the window down.
      try {
        await pi.ui.showToast(
          code === 'INVALID_ARGUMENT'
            ? 'Open a chat session first, then run Autotest: open the workbench.'
            : 'Autotest: the workbench could not be opened (' + code + ').',
          'warn',
        );
      } catch (ignored) {
        /* a toast is best effort */
      }
    }
    throw error;
  }
}

/* ------------------------------------------------------------ async jobs */

/**
 * Panel-driven stage work runs as jobs, not as a synchronous handler.
 *
 * The host gives a panel invocation 30 seconds (PLUGIN_PANEL_TIMEOUT_MS,
 * plugin-runtime.ts:698) while a stage that calls a model can take minutes; a
 * synchronous handler would therefore answer TIMEOUT while the work kept
 * running invisibly. Every long channel below starts a job, hands the panel a
 * ticket, and lets the panel poll autotest.job for progress.
 *
 * The registry is per plugin process and in memory by design: a job's whole
 * value is its live progress, and a process restart has already stopped the
 * work it was describing.
 */
let jobRegistry = null;

/**
 * The shared ctx for work that no conversation started.
 *
 * A panel click has no session, no model key and no abort signal, so
 * toolContext(null) supplies exactly that: the host api, the settings and one
 * resolved dataDir. `pi` is already bound by the time any channel runs.
 */
async function workContext() {
  return toolContext(null);
}

/**
 * Wrap one stage call as a job handler.
 *
 * The handler receives the job's own args and reports progress through the
 * reporter the registry hands it, so a panel sees a live line while a stage
 * runs instead of a frozen rail.
 */
function jobHandler(kind, run) {
  return async function handler(ctx, args, reporter) {
    reporter.log('info', kind + ' stage started');
    const started = Date.now();
    const result = await run(ctx, args || {}, reporter);
    reporter.log('info', kind + ' stage finished in ' + (Date.now() - started) + 'ms');
    return result;
  };
}

/**
 * The six stage handlers a panel may dispatch.
 *
 * Each one is the same lib/plan.js function the agent tool calls, so the gate
 * is enforced once, in one place: a panel cannot reach a stage the agent could
 * not. `ctx.signal` is absent here -- a panel click carries no abort -- which
 * is why cancel() is a state change rather than a real interrupt (lib/jobs.js).
 */
function stageHandlers() {
  return {
    requirement: jobHandler('requirement', function (ctx, args) {
      return plan.requirement(ctx, args);
    }),
    cases: jobHandler('cases', function (ctx, args, reporter) {
      reporter.progress({ done: 0, total: 0, label: 'generating cases' });
      return plan.cases(ctx, Object.assign({}, args, { regenerate: args.regenerate === true }));
    }),
    author: jobHandler('author', function (ctx, args, reporter) {
      const ids = Array.isArray(args.testCaseIds) ? args.testCaseIds : [];
      reporter.progress({ done: 0, total: ids.length, label: 'writing scripts' });
      return plan.author(ctx, args);
    }),
    run: jobHandler('run', function (ctx, args, reporter) {
      const ids = Array.isArray(args.testCaseIds) ? args.testCaseIds : [];
      reporter.progress({ done: 0, total: ids.length, label: 'running scripts' });
      return plan.run(ctx, args);
    }),
    diagnose: jobHandler('diagnose', function (ctx, args, reporter) {
      reporter.progress({ done: 0, total: 1, label: 'classifying failures' });
      return plan.diagnoseTool(ctx, args);
    }),
    report: jobHandler('report', function (ctx, args, reporter) {
      reporter.progress({ done: 0, total: 1, label: 'rendering report' });
      return plan.reportTool(ctx, args);
    }),
  };
}

/**
 * The registry, created on first use with the stage handlers wired in.
 *
 * Built lazily rather than at module scope so requiring main.js in a test has
 * no side effects, and so a host reload cannot leave a registry behind that
 * outlives the handlers it dispatches into.
 */
function jobStore() {
  if (!jobRegistry) jobRegistry = jobs.createJobs({ handlers: stageHandlers() });
  return jobRegistry;
}

/**
 * Start one job and answer the panel with a ticket.
 *
 * A start failure is returned as data, not thrown: JOB_BUSY carries the id of
 * the job that is already running, and the panel needs that id to attach its
 * progress line to the right row rather than to show a bare error.
 */
async function startJob(kind, payload) {
  const args = payload || {};
  const ctx = await workContext();
  const planId = args.planId || lastPanelPlanId || null;
  if (!planId) {
    return { ok: false, code: 'PLAN_ID_REQUIRED', message: 'open or create a plan before starting a stage' };
  }
  try {
    const ticket = jobStore().start(ctx, {
      planId: planId,
      kind: kind,
      args: Object.assign({}, args, { planId: planId }),
      label: kind,
    });
    lastPanelPlanId = planId;
    return { ok: true, planId: planId, job: ticket };
  } catch (error) {
    const answer = {
      ok: false,
      code: (error && error.code) || 'JOB_FAILED',
      message: (error && error.message) || String(error),
    };
    // JOB_BUSY names the live job so the panel can poll it instead of guessing.
    if (error && error.jobId) answer.jobId = error.jobId;
    if (error && error.job) answer.job = error.job;
    return answer;
  }
}

/**
 * The requirement stage is the only one that may create a plan.
 *
 * Without a planId the stage makes one and reports its id in the result, so the
 * job is started under a placeholder and re-keyed once the stage answers. A
 * panel that watched a placeholder would poll a plan that never exists.
 */
async function startRequirement(payload) {
  const args = payload || {};
  const ctx = await workContext();
  if (!String(args.source || '').trim()) {
    return { ok: false, code: 'REQUIREMENT_SOURCE_MISSING', message: 'paste the requirement text before decomposing it' };
  }
  const planId = args.planId || lastPanelPlanId || null;
  try {
    const ticket = jobStore().start(ctx, {
      planId: planId || 'new-plan',
      kind: 'requirement',
      args: Object.assign({}, args, planId ? { planId: planId } : {}),
      label: 'decomposing requirement',
      stage: 'requirements',
    });
    if (planId) lastPanelPlanId = planId;
    return { ok: true, planId: planId, job: ticket };
  } catch (error) {
    return {
      ok: false,
      code: (error && error.code) || 'JOB_FAILED',
      message: (error && error.message) || String(error),
    };
  }
}

/* ------------------------------------------------------------ panel bridge */

/**
 * Work-panel channels.
 *
 * The host answers a thrown error with PLUGIN_CALL_FAILED and nothing else
 * (plugin-host-process.mjs:804-818), so failures come back as data carrying
 * their own code: the view has to say *what* went wrong, and the bridge has a
 * 30s budget that a swallowed rejection would burn for nothing.
 *
 * The set of actions the view may take is deliberately identical to the
 * renderer bridge — status/approve/select. Starting a run or editing a script
 * stays on the agent tool side, where the approval gate is enforced.
 */
let lastPanelPlanId = null;

async function panelSnapshot(payload) {
  const ctx = await toolContext(null);
  // The panel names no workspace: a view opened from the work panel has no
  // session behind it, so listPlans() must not be gated on one. It reads the
  // plan root directly and the projection reuses the same ctx.
  const meta = store.listPlans(ctx.dataDir);
  const wanted = payload && payload.planId ? String(payload.planId) : lastPanelPlanId || (meta[0] && meta[0].id) || null;
  let projection = null;
  if (wanted) {
    try {
      projection = plan.reviewPlan(ctx, wanted);
      lastPanelPlanId = wanted;
    } catch (error) {
      // A plan deleted behind the panel must not blank the whole list; the
      // reason travels next to the empty detail instead.
      if (error.code !== 'PLAN_NOT_FOUND') throw error;
      projection = null;
      // A remembered plan the root does not hold must be forgotten. Keeping it
      // made the panel list an empty root and still answer every stage click
      // with that stale planId: the job started against a directory that does
      // not exist here, and the user saw a running bar for work on no plan
      // (2026-11-08).
      if (!meta.length || !meta.some(function (entry) { return entry.id === wanted; })) {
        lastPanelPlanId = (meta[0] && meta[0].id) || null;
      }
    }
  }
  const appearance = await readAppearance();
  return {
    ok: true,
    plans: meta,
    planId: projection ? projection.planId : null,
    plan: projection,
    base: appearanceBase(appearance),
    locale: (await hostLocale()).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en',
  };
}

const PANEL_CHANNELS = {
  // The view calls this on boot to learn the stage rail and tool list before it
  // asks for a plan. Without it every workbench open logged an UNSUPPORTED
  // error and the page kept a stale rail until the first snapshot landed.
  'autotest.meta': async function () {
    return {
      ok: true,
      pluginId: 'pi.autotest',
      stages: schema.STAGES.slice(),
      tools: TOOLS.map(function (tool) { return tool.name; }),
      rendererActions: ['status', 'approve', 'select', 'reveal', 'meta'],
      // The view needs the action surface, not just the stage names: a rail
      // click maps a stage to a channel, and that map lives here so the page
      // never invents a channel the plugin does not answer.
      actions: {
        requirement: 'autotest.start',
        cases: 'autotest.cases.generate',
        author: 'autotest.author',
        run: 'autotest.execute',
        diagnose: 'autotest.diagnose',
        report: 'autotest.report',
      },
      jobKinds: jobs.KINDS.slice(),
    };
  },
  'autotest.snapshot': panelSnapshot,
  'autotest.appearance': async function () {
    const appearance = await readAppearance();
    return { ok: true, appearance: appearance, base: appearanceBase(appearance) };
  },
  'autotest.status': async function (payload) {
    const ctx = await toolContext(null);
    return { ok: true, result: await plan.status(ctx, { planId: payload && payload.planId }) };
  },
  'autotest.approve': async function (payload) {
    const ctx = await toolContext(null);
    const args = payload || {};
    const cases = Array.isArray(args.cases) ? args.cases : [];
    if (cases.length === 0) {
      const error = new Error('approve needs the reviewed case rows; an empty list would approve nothing');
      error.code = 'CASES_EMPTY';
      throw error;
    }
    const answer = await plan.approveCaseSet(ctx, {
      planId: args.planId,
      cases: cases,
      decision: args.decision === 'rejected' ? 'rejected' : 'approved',
      actor: args.actor || 'workbench',
      note: args.note,
    });
    lastPanelPlanId = answer.planId || lastPanelPlanId;
    return { ok: true, result: answer };
  },
  'autotest.select': async function (payload) {
    const ctx = await toolContext(null);
    const args = payload || {};
    return {
      ok: true,
      result: await plan.select(ctx, {
        planId: args.planId,
        testCaseIds: args.testCaseIds,
        selected: typeof args.selected === 'boolean' ? args.selected : undefined,
      }),
    };
  },
  'autotest.reveal': async function (payload) {
    const ctx = await toolContext(null);
    return { ok: true, result: await plan.callRendererAction(ctx, 'reveal', payload || {}) };
  },
  'autotest.report': async function (payload) {
    const ctx = await toolContext(null);
    return Object.assign({ ok: true }, plan.reportMarkdown(ctx, payload && payload.planId));
  },
  'autotest.trace': async function (payload) {
    const ctx = await toolContext(null);
    const resolved = plan.resolvePlan(ctx, { planId: payload && payload.planId });
    return { ok: true, planId: resolved.state.id, rows: plan.traceRows(resolved.state) };
  },

  /* -------------------------------------------------------- stage actions */

  // Each long channel answers a job ticket immediately; the panel polls
  // autotest.job. planId defaults to the plan the panel is already showing, so
  // a click on the rail needs no argument beyond the stage it names.
  'autotest.start': async function (payload) {
    return startRequirement(payload);
  },
  'autotest.cases.generate': async function (payload) {
    return startJob('cases', payload);
  },
  'autotest.author': async function (payload) {
    return startJob('author', payload);
  },
  'autotest.execute': async function (payload) {
    return startJob('run', payload);
  },
  'autotest.diagnose': async function (payload) {
    return startJob('diagnose', payload);
  },
  'autotest.report': async function (payload) {
    return startJob('report', payload);
  },
  'autotest.job': async function (payload) {
    const args = payload || {};
    const registry = jobStore();
    if (args.jobId) {
      const one = registry.get(String(args.jobId));
      if (!one) return { ok: false, code: 'JOB_NOT_FOUND', message: 'no job ' + String(args.jobId) };
      return { ok: true, job: one };
    }
    const planId = args.planId || lastPanelPlanId || null;
    if (!planId) return { ok: true, jobs: [], active: null };
    const all = registry.list(planId);
    const active = registry.latestFor(planId);
    return { ok: true, planId: planId, jobs: all, active: active && active.status === 'running' ? active : null };
  },
  'autotest.job.cancel': async function (payload) {
    const args = payload || {};
    const answer = jobStore().cancel(String(args.jobId || ''), args.reason);
    if (!answer) return { ok: false, code: 'JOB_NOT_FOUND', message: 'no job ' + String(args.jobId) };
    return { ok: true, job: answer, cancelled: answer.status === 'cancelled' };
  },

  /* ----------------------------------------------------------- knowledge */

  // The knowledge base is plain files under the same data root as the plans
  // (lib/kb.js), so a panel edit and an agent read always see one store.
  'kb.list': async function (payload) {
    const ctx = await workContext();
    return Object.assign({ ok: true }, kb.list(ctx, payload || {}));
  },
  'kb.collections': async function () {
    const ctx = await workContext();
    return Object.assign({ ok: true }, kb.collections(ctx));
  },
  'kb.read': async function (payload) {
    const ctx = await workContext();
    return { ok: true, item: kb.read(ctx, payload || {}) };
  },
  'kb.write': async function (payload) {
    const ctx = await workContext();
    const saved = kb.write(ctx, payload || {});
    return { ok: true, id: saved.id, item: saved };
  },
  'kb.remove': async function (payload) {
    const ctx = await workContext();
    return Object.assign({ ok: true }, kb.remove(ctx, payload || {}));
  },
  'kb.search': async function (payload) {
    const ctx = await workContext();
    return Object.assign({ ok: true }, kb.search(ctx, payload || {}));
  },
  // What the case/script stages were actually shown, and what a hypothetical
  // query would retrieve now. The panel needs both: the first to explain a
  // generated row's citation, the second to answer "what would change if I
  // edited this entry" without running a model.
  'kb.retrieve': async function (payload) {
    const ctx = await workContext();
    return Object.assign({ ok: true }, kb.retrieve(ctx, payload || {}));
  },
  'kb.attach': async function (payload) {
    const args = payload || {};
    const ctx = await workContext();
    const planId = args.planId || lastPanelPlanId || null;
    if (!planId) return { ok: false, code: 'PLAN_ID_REQUIRED', message: 'open a plan before attaching knowledge' };
    const ids = Array.isArray(args.ids) ? args.ids : [];
    if (ids.length === 0) return { ok: false, code: 'SELECTION_EMPTY', message: 'select at least one knowledge entry' };
    return Object.assign({ ok: true }, plan.attachKnowledge(ctx, planId, ids));
  },
  'kb.detach': async function (payload) {
    const args = payload || {};
    const ctx = await workContext();
    const planId = args.planId || lastPanelPlanId || null;
    if (!planId) return { ok: false, code: 'PLAN_ID_REQUIRED', message: 'open a plan before detaching knowledge' };
    const ids = Array.isArray(args.ids) ? args.ids : [];
    if (ids.length === 0) return { ok: false, code: 'SELECTION_EMPTY', message: 'select at least one knowledge entry' };
    return Object.assign({ ok: true }, plan.detachKnowledge(ctx, planId, ids));
  },
};

async function onPanelInvoke(channel, payload) {
  const handler = PANEL_CHANNELS[channel];
  if (!handler) {
    return { ok: false, code: 'UNSUPPORTED', message: 'unknown panel channel: ' + String(channel) };
  }
  // A panel can be reopened while the plugin is still loading; onLoad has not
  // necessarily run yet, so bind the host api here too.
  pi = pi || globalThis.pi;
  currentPi = currentPi || pi;
  try {
    return await handler(payload || {});
  } catch (error) {
    return {
      ok: false,
      code: (error && error.code) || 'PANEL_FAILED',
      message: (error && error.message) || String(error),
    };
  }
}

/**
 * Host locale and appearance, mirroring pi.gitlens/main.js:67-119.
 *
 * A docked view has no appearance:changed push channel, so the page polls these
 * through the bridge instead. Both host APIs are optional: an older host
 * answers nothing and the view keeps its last palette.
 */
async function hostLocale() {
  try {
    if (pi && pi.app && typeof pi.app.getLocale === 'function') {
      const value = await pi.app.getLocale();
      if (typeof value === 'string' && value) return value;
    }
  } catch (ignored) {
    /* older host */
  }
  return 'en';
}

function appearanceBase(appearance) {
  if (!appearance || typeof appearance !== 'object') return 'system';
  if (appearance.base === 'light' || appearance.base === 'dark') return appearance.base;
  if (appearance.theme === 'light' || appearance.theme === 'dark') return appearance.theme;
  return 'system';
}

async function readAppearance() {
  try {
    if (pi && pi.app && typeof pi.app.getAppearance === 'function') {
      const value = await pi.app.getAppearance();
      if (value && typeof value === 'object') return value;
    }
  } catch (ignored) {
    /* older host: the page falls back to prefers-color-scheme */
  }
  return null;
}

module.exports = {
  onLoad,
  onUnload,
  onRendererCall,
  onPanelInvoke,
  PANEL_CHANNELS,
  TOOLS,
  PLAN_SAFE,
  registerTools,
  // Exposed for tests: the registry is process state, but the handlers and the
  // stage map are pure values a test can assert on without a host.
  jobStore,
  stageHandlers,
  startJob,
};