'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createJobs, MAX_JOBS_PER_PLAN } = require('../lib/jobs');

/** A handler table that answers the way main.js will wire the six stages. */
function handlers(overrides) {
  const base = {
    requirement: async function (ctx, args, reporter) {
      reporter.progress({ done: 1, total: 2, label: 'features' });
      reporter.log('info', 'decomposed ' + String(args.source || ''));
      return { planId: 'p-1', features: 2 };
    },
    cases: async function () {
      return { planId: 'p-1', cases: 3 };
    },
  };
  return Object.assign(base, overrides || {});
}

/** One macrotask turn: enough for an async handler to settle without flakes. */
function settle() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

test('createJobs refuses a handler table that cannot run a job', async function () {
  const jobs = createJobs();
  assert.deepStrictEqual(jobs.setHandlers(handlers()), ['cases', 'requirement']);
  await assert.rejects(
    async function () {
      jobs.start({}, { planId: 'p-1', kind: 'run' });
    },
    function (error) {
      return error.code === 'JOB_HANDLER_MISSING';
    },
  );
  // A handler table may also be injected at construction time.
  const preset = createJobs({ handlers: handlers() });
  assert.strictEqual(preset.start({}, { planId: 'p-1', kind: 'cases' }).status, 'running');
});

test('start returns a running snapshot immediately and finishes later', async function () {
  const jobs = createJobs({ handlers: handlers() });
  const snapshot = jobs.start({}, { planId: 'p-1', kind: 'requirement', args: { source: 'spec' }, total: 2 });
  // The contract: nothing is awaited, so the work cannot be done yet.
  assert.strictEqual(snapshot.status, 'running');
  assert.strictEqual(snapshot.result, null);
  assert.strictEqual(snapshot.finishedAt, null);
  assert.match(snapshot.id, /^job-\d{14}-[a-z0-9]{4}$/);
  assert.strictEqual(snapshot.kind, 'requirement');
  assert.strictEqual(snapshot.stage, 'requirement');
  assert.strictEqual(snapshot.progress.total, 2);

  await settle();
  const done = jobs.get(snapshot.id);
  assert.strictEqual(done.status, 'done');
  assert.ok(done.finishedAt);
  assert.deepStrictEqual(done.result, { planId: 'p-1', features: 2 });
  // The reporter writes through to the same record.
  assert.strictEqual(done.progress.done, 1);
  assert.strictEqual(done.progress.label, 'features');
  assert.ok(
    done.log.some(function (entry) {
      return entry.level === 'info' && entry.message.indexOf('decomposed spec') !== -1;
    }),
  );
});

test('a rejected handler is stored as error, never thrown at the caller', async function () {
  const jobs = createJobs({
    handlers: handlers({
      run: async function () {
        throw Object.assign(new Error('RUN_GATE_CLOSED: approve the case set'), { code: 'REVIEW_GATE_CLOSED' });
      },
    }),
  });
  const snapshot = jobs.start({}, { planId: 'p-1', kind: 'run' });
  await settle();
  const failed = jobs.get(snapshot.id);
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.error.code, 'REVIEW_GATE_CLOSED');
  assert.match(failed.error.message, /approve the case set/);
  assert.strictEqual(failed.result, null);
  // A non-Error rejection still lands in the record instead of escaping.
  const bare = createJobs({
    handlers: handlers({
      report: async function () {
        return Promise.reject('boom');
      },
    }),
  });
  const second = bare.start({}, { planId: 'p-1', kind: 'report' });
  await settle();
  assert.strictEqual(bare.get(second.id).error.code, 'JOB_FAILED');
  assert.strictEqual(bare.get(second.id).error.message, 'boom');
});

test('a second job of the same kind on one plan is refused while the first runs', async function () {
  // One deferred per call: a shared slot would be overwritten by the other
  // plan's job and the assertion below would wait on the wrong promise.
  const releases = [];
  const jobs = createJobs({
    handlers: handlers({
      author: function () {
        return new Promise(function (resolve) {
          releases.push(resolve);
        });
      },
    }),
  });
  const first = jobs.start({}, { planId: 'p-1', kind: 'author' });
  assert.throws(
    function () {
      jobs.start({}, { planId: 'p-1', kind: 'author' });
    },
    function (error) {
      // The refusal carries the running job so the panel can attach to it.
      return error.code === 'JOB_BUSY' && error.jobId === first.id && error.job.status === 'running';
    },
  );
  // A different kind, or a different plan, is not blocked.
  assert.strictEqual(jobs.start({}, { planId: 'p-1', kind: 'cases' }).status, 'running');
  assert.strictEqual(jobs.start({}, { planId: 'p-2', kind: 'author' }).status, 'running');
  assert.strictEqual(releases.length, 2);
  releases[1]({ scripts: 0 });
  releases[0]({ scripts: 1 });
  await settle();
  assert.strictEqual(jobs.get(first.id).status, 'done');
  // Once it is finished the slot is free again.
  assert.strictEqual(jobs.start({}, { planId: 'p-1', kind: 'author' }).status, 'running');
});

test('cancel marks a running job cancelled and keeps a late result out of it', async function () {
  let release = null;
  const jobs = createJobs({
    handlers: handlers({
      diagnose: function () {
        return new Promise(function (resolve) {
          release = resolve;
        });
      },
    }),
  });
  const snapshot = jobs.start({}, { planId: 'p-1', kind: 'diagnose' });
  const cancelled = jobs.cancel(snapshot.id, 'user closed the panel');
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.ok(cancelled.finishedAt);
  assert.strictEqual(cancelled.reason, 'user closed the panel');
  release({ blocking: [] });
  await settle();
  const after = jobs.get(snapshot.id);
  // The handler cannot resurrect a cancelled job by resolving later.
  assert.strictEqual(after.status, 'cancelled');
  assert.strictEqual(after.result, null);
  assert.strictEqual(jobs.cancel(snapshot.id).status, 'cancelled');
  assert.strictEqual(jobs.cancel('job-nope'), null);
});

test('finished snapshots are capped per plan, oldest dropped first', async function () {
  const jobs = createJobs({ handlers: handlers(), maxPerPlan: 4 });
  const ids = [];
  for (let index = 0; index < 6; index += 1) {
    ids.push(jobs.start({}, { planId: 'p-1', kind: 'cases' }).id);
    await settle();
  }
  const kept = jobs.list('p-1').map(function (job) {
    return job.id;
  });
  assert.strictEqual(kept.length, 4);
  assert.strictEqual(jobs.get(ids[0]), null);
  assert.strictEqual(jobs.get(ids[1]), null);
  assert.ok(jobs.get(ids[5]));
  // list() with no plan answers every plan, and clear() only drops finished jobs.
  assert.ok(jobs.list().length >= 4);
  assert.strictEqual(jobs.clear('p-1').removed, 4);
  assert.strictEqual(jobs.size(), 0);
  assert.strictEqual(MAX_JOBS_PER_PLAN, 50);
});

test('latestFor and list are scoped to one plan and answer creation order', async function () {
  const jobs = createJobs({ handlers: handlers() });
  const first = jobs.start({}, { planId: 'p-1', kind: 'cases' });
  const other = jobs.start({}, { planId: 'p-2', kind: 'cases' });
  await settle();
  const second = jobs.start({}, { planId: 'p-1', kind: 'requirement', args: { source: 'x' } });
  await settle();
  assert.strictEqual(jobs.latestFor('p-1').id, second.id);
  assert.strictEqual(jobs.latestFor('p-2').id, other.id);
  assert.deepStrictEqual(
    jobs.list('p-1').map(function (job) {
      return job.id;
    }),
    [first.id, second.id],
  );
  assert.strictEqual(jobs.get('job-missing'), null);
  assert.strictEqual(jobs.latestFor('p-9'), null);
});

test('an unknown kind and a missing planId are refused with a code', async function () {
  const jobs = createJobs({ handlers: handlers() });
  assert.throws(
    function () {
      jobs.start({}, { planId: 'p-1', kind: 'deploy' });
    },
    function (error) {
      return error.code === 'JOB_KIND_INVALID' && /unknown job kind/.test(error.message);
    },
  );
  assert.throws(
    function () {
      jobs.start({}, { kind: 'cases' });
    },
    function (error) {
      return error.code === 'JOB_PLAN_REQUIRED';
    },
  );
  assert.deepStrictEqual(jobs.kinds(), ['requirement', 'cases', 'author', 'run', 'diagnose', 'report']);
});

test('the progress and log helpers are inert for an unknown job', function () {
  const jobs = createJobs({ handlers: handlers() });
  assert.strictEqual(jobs.progress('job-nope', { done: 1 }), null);
  assert.strictEqual(jobs.log('job-nope', 'info', 'hello'), null);
  const snapshot = jobs.start({}, { planId: 'p-1', kind: 'cases' });
  assert.deepStrictEqual(jobs.progress(snapshot.id, { done: 2, total: 3, label: 'run' }), { done: 2, total: 3, label: 'run' });
  assert.deepStrictEqual(jobs.progress(snapshot.id, { done: 'nonsense' }).done, 0);
  assert.strictEqual(jobs.log(snapshot.id, 'shout', 'x').level, 'info');
});
