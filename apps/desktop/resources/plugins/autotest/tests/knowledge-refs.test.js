'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plan = require('../lib/plan');
const store = require('../lib/store');
const kb = require('../lib/kb');

/** A data root and one plan, the way main.js builds both. */
function fixture() {
  const ctx = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-refs-')) };
  // createPlan answers {dir, state}; the id lives on the state it wrote.
  const created = store.createPlan(path.join(ctx.dataDir), { title: 'Brake rig' });
  return { ctx: ctx, planId: created.state.id };
}

test('a new plan starts with no knowledge refs', function () {
  const { ctx, planId } = fixture();
  assert.deepStrictEqual(store.readState(store.planDir(path.join(ctx.dataDir), planId)).knowledgeRefs, []);
  assert.deepStrictEqual(plan.reviewPlan(ctx, planId).state.knowledgeRefs, []);
});

test('attach and detach keep refs deduplicated and sorted', function () {
  const { ctx, planId } = fixture();
  const first = plan.attachKnowledge(ctx, planId, ['kb-b-20260101000000', 'kb-a-20260101000000', 'kb-b-20260101000000']);
  assert.deepStrictEqual(first.knowledgeRefs, ['kb-a-20260101000000', 'kb-b-20260101000000']);
  assert.deepStrictEqual(first.attached, ['kb-a-20260101000000', 'kb-b-20260101000000']);
  assert.strictEqual(first.planId, planId);

  // A second attach merges rather than replaces, and stays deduplicated.
  const second = plan.attachKnowledge(ctx, planId, ['kb-c-20260101000000', 'kb-a-20260101000000']);
  assert.deepStrictEqual(second.knowledgeRefs, [
    'kb-a-20260101000000',
    'kb-b-20260101000000',
    'kb-c-20260101000000',
  ]);

  // The state on disk is the same answer as the return value.
  assert.deepStrictEqual(store.readState(store.planDir(path.join(ctx.dataDir), planId)).knowledgeRefs, second.knowledgeRefs);

  const detached = plan.detachKnowledge(ctx, planId, ['kb-b-20260101000000']);
  assert.deepStrictEqual(detached.knowledgeRefs, ['kb-a-20260101000000', 'kb-c-20260101000000']);
  assert.deepStrictEqual(detached.detached, ['kb-b-20260101000000']);
  // Detaching something that was never attached is not an error.
  assert.deepStrictEqual(plan.detachKnowledge(ctx, planId, ['kb-none-20260101000000']).knowledgeRefs, [
    'kb-a-20260101000000',
    'kb-c-20260101000000',
  ]);
  // Blank entries never become refs.
  assert.deepStrictEqual(plan.detachKnowledge(ctx, planId, []).knowledgeRefs, ['kb-a-20260101000000', 'kb-c-20260101000000']);
});

test('knowledgeRefs survive a state read and appear in reviewPlan', function () {
  const { ctx, planId } = fixture();
  plan.attachKnowledge(ctx, planId, ['kb-c-20260101000000', 'kb-a-20260101000000']);
  const projected = plan.reviewPlan(ctx, planId);
  assert.deepStrictEqual(projected.state.knowledgeRefs, ['kb-a-20260101000000', 'kb-c-20260101000000']);
  // The projection is a copy: mutating it cannot reach the stored state.
  projected.state.knowledgeRefs.push('kb-injected-20260101000000');
  assert.deepStrictEqual(plan.reviewPlan(ctx, planId).state.knowledgeRefs, ['kb-a-20260101000000', 'kb-c-20260101000000']);
});

test('an old state without the field reads as an empty list', function () {
  const { ctx, planId } = fixture();
  const dir = store.planDir(path.join(ctx.dataDir), planId);
  const state = store.readState(dir);
  delete state.knowledgeRefs;
  store.writeState(dir, state);
  // readState backfills it, so a plan written before this field existed still reads.
  assert.deepStrictEqual(store.readState(dir).knowledgeRefs, []);
  assert.deepStrictEqual(plan.attachKnowledge(ctx, planId, ['kb-a-20260101000000']).knowledgeRefs, ['kb-a-20260101000000']);
});

test('knowledge refs name kb entries and a missing plan is refused', function () {
  const { ctx, planId } = fixture();
  const entry = kb.write(ctx, { collection: 'specs', title: 'Brake spec', tags: ['brake'], text: 'warm up within four seconds' });
  const attached = plan.attachKnowledge(ctx, planId, [entry.id]);
  assert.deepStrictEqual(attached.knowledgeRefs, [entry.id]);
  // The ref is the kb id verbatim: the panel resolves it through kb.read.
  assert.strictEqual(kb.read(ctx, { id: attached.knowledgeRefs[0] }).title, 'Brake spec');
  assert.throws(
    function () {
      plan.attachKnowledge(ctx, 'no-such-plan', ['kb-a-20260101000000']);
    },
    function (error) {
      return error.code === 'PLAN_NOT_FOUND';
    },
  );
  assert.throws(
    function () {
      plan.attachKnowledge(ctx, undefined, ['kb-a-20260101000000']);
    },
    function (error) {
      return error.code === 'PLAN_ID_REQUIRED';
    },
  );
});
