'use strict';
/**
 * Panel-initiated asynchronous jobs.
 *
 * Every real stage of the rail is a long call: decomposing a requirement, or
 * authoring twenty scripts, is dozens of model round trips. The host gives a
 * panel bridge 30s (and an agent tool 110s), so a panel that waits for one has
 * already lost by the time the answer arrives. The job registry inverts that:
 * the panel starts a job, gets its snapshot back inside the same tick, and then
 * polls the registry for progress and the final result.
 *
 * Three properties this module is built around:
 *  - `start()` never awaits the work. It returns a snapshot synchronously, so a
 *    caller cannot accidentally turn a job into a blocking call;
 *  - the work itself is injected (`handlers[kind](ctx, args, reporter)`). This
 *    module deliberately does not require lib/plan.js: plan.js is the caller, and
 *    a require back into it would be a cycle;
 *  - a rejected handler is caught and stored as `error`, never left as a
 *    floating promise. An unhandled rejection inside the plugin host process
 *    can take the process down, and that would lose every running job at once.
 *
 * The registry is process memory and nothing else. It is not persisted on
 * purpose: a job is a running call, and a restarted plugin has no call to
 * report on. The finished snapshots are what the panel reads afterwards, and
 * they are bounded per plan so a long session cannot grow without limit.
 */

/** Jobs kept per plan. Oldest finished snapshots are dropped first. */
const MAX_JOBS_PER_PLAN = 50;

/** Entries kept in one job's own log. A chatty handler must not grow unbounded. */
const MAX_LOG_LINES = 200;

const KINDS = ['requirement', 'cases', 'author', 'run', 'diagnose', 'report'];

const STATUSES = ['running', 'done', 'failed', 'cancelled'];

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  return nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6);
}

function newJobId() {
  return 'job-' + stamp() + '-' + randomSuffix();
}

function isFinished(status) {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

function normaliseProgress(patch) {
  const value = patch && typeof patch === 'object' ? patch : {};
  const total = Number(value.total);
  const done = Number(value.done);
  return {
    done: Number.isFinite(done) && done >= 0 ? Math.floor(done) : 0,
    total: Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0,
    label: value.label == null ? '' : String(value.label),
  };
}

/**
 * Create one registry.
 *
 * `options.handlers` is optional. A caller may build the registry during plugin
 * load and inject the table later with `setHandlers`, which is what a module
 * graph that would otherwise cycle needs.
 */
function createJobs(options) {
  const config = options && typeof options === 'object' ? options : {};
  const maxPerPlan = Number.isFinite(Number(config.maxPerPlan)) && Number(config.maxPerPlan) > 0
    ? Math.floor(Number(config.maxPerPlan))
    : MAX_JOBS_PER_PLAN;

  /** jobId -> job record. Insertion order doubles as creation order. */
  const jobs = new Map();
  let handlers = config.handlers && typeof config.handlers === 'object' ? Object.assign({}, config.handlers) : {};

  /** The public shape of one job. Copies, never the live record. */
  function snapshot(job) {
    const value = {
      id: job.id,
      planId: job.planId,
      kind: job.kind,
      stage: job.stage,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: { done: job.progress.done, total: job.progress.total, label: job.progress.label },
      log: job.log.map(function (entry) {
        return { at: entry.at, level: entry.level, message: entry.message };
      }),
      error: job.error ? { code: job.error.code, message: job.error.message } : null,
      result: job.result == null ? null : job.result,
    };
    if (job.reason) value.reason = job.reason;
    return value;
  }

  /**
   * Drop the oldest finished snapshots of one plan once its budget is spent.
   *
   * Running jobs are never dropped: a snapshot that is still being polled is
   * the only progress channel the panel has. When a plan manages to hold
   * `max` running jobs at once the cap is exceeded rather than the poll broken.
   */
  function prune(planId) {
    const owned = [];
    jobs.forEach(function (job) {
      if (job.planId === planId) owned.push(job);
    });
    if (owned.length <= maxPerPlan) return [];
    const dropped = [];
    for (let index = 0; index < owned.length && owned.length - dropped.length > maxPerPlan; index += 1) {
      const candidate = owned[index];
      if (!isFinished(candidate.status)) continue;
      jobs.delete(candidate.id);
      dropped.push(candidate.id);
    }
    return dropped;
  }

  function requireHandler(kind) {
    const handler = handlers[kind];
    if (typeof handler !== 'function') {
      throw fail('no job handler is registered for kind "' + String(kind) + '"', 'JOB_HANDLER_MISSING');
    }
    return handler;
  }

  /**
   * Run one job body on the microtask queue.
   *
   * The body is invoked through `await handler(...)` inside a promise that is
   * never returned to the caller, so a long stage cannot block `start()`, and
   * every outcome (resolve, reject, or an abort) is turned into a stored state
   * before the promise settles.
   */
  async function execute(job, handler, ctx, args) {
    let settled = false;
    const reporter = {
      progress: function (patch) {
        return progress(job.id, patch);
      },
      log: function (level, message) {
        return recordLog(job.id, level, message);
      },
    };
    try {
      const result = await handler(ctx, args, reporter);
      if (settled) return;
      settled = true;
      if (job.status === 'running') {
        job.status = 'done';
        job.result = result == null ? null : result;
      }
    } catch (error) {
      if (settled) return;
      settled = true;
      // A cancel already wrote the terminal state; the handler's rejection is
      // the consequence of it, not a second failure to report.
      if (job.status === 'running') {
        job.status = 'failed';
        job.error = { code: (error && error.code) || 'JOB_FAILED', message: (error && error.message) || String(error) };
      }
    } finally {
      job.finishedAt = nowIso();
      prune(job.planId);
    }
  }

  /**
   * Start one job and return its snapshot immediately.
   *
   * The snapshot is returned synchronously — `start` is not async — so a panel
   * handler has nothing to await and cannot stall its 30s budget on stage work.
   */
  function start(ctx, spec) {
    const input = spec && typeof spec === 'object' ? spec : {};
    const planId = input.planId == null ? '' : String(input.planId);
    if (!planId) throw fail('planId is required to start a job', 'JOB_PLAN_REQUIRED');
    const kind = String(input.kind || '');
    if (KINDS.indexOf(kind) === -1) {
      throw fail('unknown job kind: ' + kind + ' (expected one of ' + KINDS.join(', ') + ')', 'JOB_KIND_INVALID');
    }
    // Refuse before dispatch when nothing can run the job: a task on the board
    // whose owner does not exist is a silent placeholder, not a job.
    const handler = requireHandler(kind);
    const busy = findRunning(planId, kind);
    if (busy) {
      const error = fail('a ' + kind + ' job is already running for this plan', 'JOB_BUSY');
      error.jobId = busy.id;
      error.job = snapshot(busy);
      throw error;
    }
    const job = {
      id: newJobId(),
      planId: planId,
      kind: kind,
      stage: input.stage == null ? kind : String(input.stage),
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      progress: normaliseProgress({ total: input.total, done: 0, label: input.label || '' }),
      log: [],
      error: null,
      result: null,
    };
    jobs.set(job.id, job);
    recordLog(job.id, 'info', 'job ' + kind + ' started');
    // Fire and forget by design: execute() owns every outcome, including its
    // own rejection path, so nothing here can surface as an unhandled rejection.
    execute(job, handler, ctx, input.args || {});
    prune(planId);
    return snapshot(job);
  }

  function run(ctx, spec) {
    return start(ctx, spec);
  }

  function findRunning(planId, kind) {
    let found = null;
    jobs.forEach(function (job) {
      if (found) return;
      if (job.planId === planId && job.kind === kind && job.status === 'running') found = job;
    });
    return found;
  }

  function get(jobId) {
    const job = jobs.get(String(jobId));
    return job ? snapshot(job) : null;
  }

  function latestFor(planId) {
    let found = null;
    jobs.forEach(function (job) {
      if (job.planId === String(planId)) found = job;
    });
    return found ? snapshot(found) : null;
  }

  function list(planId) {
    const wanted = planId == null ? null : String(planId);
    const out = [];
    jobs.forEach(function (job) {
      if (wanted && job.planId !== wanted) return;
      out.push(snapshot(job));
    });
    return out;
  }

  function progress(jobId, patch) {
    const job = jobs.get(String(jobId));
    if (!job) return null;
    const next = normaliseProgress(Object.assign({}, job.progress, patch || {}));
    job.progress = next;
    return { done: next.done, total: next.total, label: next.label };
  }

  function recordLog(jobId, level, message) {
    const job = jobs.get(String(jobId));
    if (!job) return null;
    const entry = {
      at: nowIso(),
      level: ['info', 'warn', 'error'].indexOf(String(level)) === -1 ? 'info' : String(level),
      message: String(message == null ? '' : message).slice(0, 1000),
    };
    job.log.push(entry);
    if (job.log.length > MAX_LOG_LINES) job.log = job.log.slice(job.log.length - MAX_LOG_LINES);
    return { at: entry.at, level: entry.level, message: entry.message };
  }

  /**
   * Mark one job cancelled.
   *
   * There is no abort path into a stage — the host hands a panel invocation no
   * cancellation signal and plan.js takes a signal only on the agent side — so a
   * cancel is a state change plus the ctx.signal the caller may have supplied.
   * The handler keeps running and its result is discarded.
   */
  function cancel(jobId, reason) {
    const job = jobs.get(String(jobId));
    if (!job) return null;
    if (!isFinished(job.status)) {
      job.status = 'cancelled';
      job.finishedAt = nowIso();
      job.reason = reason == null ? 'cancelled by caller' : String(reason);
      // A canceller that can reach the stage's abort signal should say so; the
      // registry cannot invent one, and a silent no-op is what makes a cancel
      // look like it did nothing.
      if (typeof job.abort === 'function') {
        try {
          job.abort();
        } catch (ignored) {
          /* the abort hook is best effort */
        }
      }
      recordLog(job.id, 'warn', 'job cancelled: ' + job.reason);
    }
    return snapshot(job);
  }

  function clear(planId) {
    const wanted = planId == null ? null : String(planId);
    let removed = 0;
    jobs.forEach(function (job, id) {
      if (wanted && job.planId !== wanted) return;
      if (!isFinished(job.status)) return;
      jobs.delete(id);
      removed += 1;
    });
    return { removed: removed, remaining: jobs.size };
  }

  function setHandlers(table) {
    handlers = Object.assign({}, handlers, table && typeof table === 'object' ? table : {});
    return Object.keys(handlers).sort();
  }

  function kinds() {
    return KINDS.slice();
  }

  /** Test seam and a diagnostic: how many jobs are held right now. */
  function size() {
    return jobs.size;
  }

  return {
    start: start,
    run: run,
    get: get,
    latestFor: latestFor,
    list: list,
    progress: progress,
    log: recordLog,
    cancel: cancel,
    clear: clear,
    setHandlers: setHandlers,
    kinds: kinds,
    size: size,
    MAX_JOBS_PER_PLAN: maxPerPlan,
  };
}

module.exports = {
  createJobs,
  KINDS,
  STATUSES,
  MAX_JOBS_PER_PLAN,
  MAX_LOG_LINES,
  newJobId,
};
