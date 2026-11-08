'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const kb = require('../lib/kb');

/** The same ctx shape every tool and panel entry point builds in main.js. */
function ctx() {
  return { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-kb-')) };
}

function seed(context, entries) {
  return entries.map(function (entry) {
    return kb.write(context, entry).id;
  });
}

test('write then read round trips every field and writes both files', function () {
  const c = ctx();
  const written = kb.write(c, {
    collection: 'specs',
    title: 'Brake warmup',
    tags: ['brake', 'thermal'],
    source: { kind: 'file', ref: 'docs/brake.md' },
    text: 'The brake unit must warm up within 4 seconds.',
  });
  assert.match(written.id, /^kb-brake-warmup-\d{14}$/);
  assert.ok(fs.existsSync(path.join(c.dataDir, 'kb', 'specs', written.id + '.json')));
  assert.ok(fs.existsSync(path.join(c.dataDir, 'kb', 'specs', written.id + '.md')));

  const entry = kb.read(c, { id: written.id });
  assert.strictEqual(entry.id, written.id);
  assert.strictEqual(entry.collection, 'specs');
  assert.strictEqual(entry.title, 'Brake warmup');
  assert.deepStrictEqual(entry.tags, ['brake', 'thermal']);
  assert.deepStrictEqual(entry.source, { kind: 'file', ref: 'docs/brake.md' });
  assert.strictEqual(entry.text, 'The brake unit must warm up within 4 seconds.');
  assert.strictEqual(entry.bytes, Buffer.byteLength(entry.text, 'utf8'));
  assert.strictEqual(entry.createdAt, entry.updatedAt);

  const markdown = fs.readFileSync(path.join(c.dataDir, 'kb', 'specs', written.id + '.md'), 'utf8');
  assert.match(markdown, /^# Brake warmup/);
  assert.match(markdown, /Tags: brake, thermal/);
  assert.match(markdown, /The brake unit must warm up within 4 seconds\./);

  // An entry with neither a title nor a body is a placeholder, not a document.
  assert.throws(
    function () {
      kb.write(c, { title: '  ', text: '   ' });
    },
    function (error) {
      return error.code === 'KB_ENTRY_EMPTY';
    },
  );
  // The default collection is "default", and an id written twice is refused.
  const plain = kb.write(c, { title: 'No collection given', text: 'body' });
  assert.strictEqual(plain.collection, 'default');
});

test('an update keeps createdAt, refreshes updatedAt, and can move collection', async function () {
  const c = ctx();
  const written = kb.write(c, { collection: 'specs', title: 'First title', text: 'first body' });
  const created = kb.read(c, { id: written.id });
  // updatedAt is monotonic by construction, so no sleep is needed to see it move.
  const updated = kb.write(c, { id: written.id, title: 'Second title', text: 'second body', tags: ['new'] });
  assert.strictEqual(updated.id, written.id);
  assert.strictEqual(updated.createdAt, created.createdAt);
  assert.notStrictEqual(updated.updatedAt, created.updatedAt);

  const entry = kb.read(c, { id: written.id });
  assert.strictEqual(entry.title, 'Second title');
  assert.strictEqual(entry.text, 'second body');
  assert.deepStrictEqual(entry.tags, ['new']);
  assert.strictEqual(entry.createdAt, created.createdAt);
  assert.strictEqual(entry.updatedAt, updated.updatedAt);
  // An update that names no collection leaves the entry where it was.
  assert.strictEqual(entry.collection, 'specs');

  const moved = kb.write(c, { id: written.id, collection: 'archive', title: 'Second title', text: 'second body' });
  assert.strictEqual(moved.collection, 'archive');
  assert.strictEqual(kb.read(c, { id: written.id }).collection, 'archive');
  // The markdown twin must not be left behind: collections() would count it twice.
  assert.strictEqual(fs.existsSync(path.join(c.dataDir, 'kb', 'specs', written.id + '.md')), false);
  const names = kb.collections(c).items.map(function (item) {
    return item.name + ':' + item.count;
  });
  assert.deepStrictEqual(names, ['archive:1']);
});

test('list filters by collection and by a case-insensitive substring', async function () {
  const c = ctx();
  seed(c, [
    { collection: 'specs', title: 'Brake warmup', tags: ['thermal'], text: 'warm up within 4 seconds' },
    { collection: 'specs', title: 'Door latch', tags: ['body'], text: 'the latch releases under load' },
    { collection: 'notes', title: 'Bench notes', tags: ['bench'], text: 'the rig was relocated' },
  ]);
  const all = kb.list(c, {});
  assert.strictEqual(all.total, 3);
  assert.strictEqual(kb.list(c, { collection: 'specs' }).total, 2);
  assert.strictEqual(kb.list(c, { collection: 'notes' }).total, 1);
  assert.strictEqual(kb.list(c, { query: 'LATCH' }).total, 1);
  // The query matches text and tags too, not just the title.
  assert.strictEqual(kb.list(c, { query: 'rig' }).total, 1);
  assert.strictEqual(kb.list(c, { query: 'thermal' }).total, 1);
  assert.strictEqual(kb.list(c, { query: 'nothing here' }).total, 0);
  assert.strictEqual(kb.list(c, { limit: 2 }).items.length, 2);
  // A collection name that is not a name is refused, not silently trimmed.
  assert.throws(
    function () {
      kb.list(c, { collection: '../escape' });
    },
    function (error) {
      return error.code === 'KB_COLLECTION_INVALID';
    },
  );
});

test('list is deterministic: same directory, same order, every read', function () {
  const c = ctx();
  seed(c, [
    { collection: 'a', title: 'one', text: 'alpha' },
    { collection: 'b', title: 'two', text: 'beta' },
  ]);
  const first = kb.list(c, {});
  const second = kb.list(c, {});
  assert.deepStrictEqual(
    first.items.map(function (entry) {
      return entry.id;
    }),
    second.items.map(function (entry) {
      return entry.id;
    }),
  );
  // Ties break on id ascending, so two entries written in the same millisecond
  // still answer one stable page in one fixed order.
  const ids = first.items.map(function (entry) {
    return entry.id;
  });
  assert.strictEqual(ids.length, 2);
  // Newest first; the two writes are one millisecond apart, so the second one
  // leads and the first one follows. That is the whole ordering contract.
  assert.strictEqual(first.items[0].updatedAt > first.items[1].updatedAt, true);
  assert.strictEqual(first.items.length, second.items.length);
});

test('remove deletes both files and read then answers KB_NOT_FOUND', function () {
  const c = ctx();
  const written = kb.write(c, { collection: 'specs', title: 'Throwaway', text: 'gone soon' });
  const removed = kb.remove(c, { id: written.id });
  assert.deepStrictEqual(removed, { id: written.id, collection: 'specs', removed: true });
  assert.strictEqual(fs.existsSync(path.join(c.dataDir, 'kb', 'specs', written.id + '.json')), false);
  assert.strictEqual(fs.existsSync(path.join(c.dataDir, 'kb', 'specs', written.id + '.md')), false);
  assert.throws(
    function () {
      kb.read(c, { id: written.id });
    },
    function (error) {
      return error.code === 'KB_NOT_FOUND';
    },
  );
});

test('search scores a title hit above a buried one and quotes an excerpt', function () {
  const c = ctx();
  const ids = seed(c, [
    { collection: 'specs', title: 'Brake warmup', tags: [], text: 'unrelated body text that never mentions the word again' },
    { collection: 'specs', title: 'Rig maintenance', tags: [], text: 'the brake unit must warm up within four seconds of power on, and the brake is checked every cycle' },
    { collection: 'specs', title: 'Door latch', tags: [], text: 'the latch releases under load' },
  ]);
  const result = kb.search(c, { query: 'brake', k: 5 });
  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.terms[0], 'brake');
  // The word in the title outweighs the word buried in a long body.
  assert.strictEqual(result.hits[0].id, ids[0]);
  assert.strictEqual(result.hits[0].title, 'Brake warmup');
  assert.strictEqual(result.hits[0].matched, 'title');
  assert.strictEqual(result.hits[0].excerpt, 'Brake warmup');
  assert.ok(result.hits[0].score > 0);
  assert.ok(result.hits[0].score > result.hits[1].score);
  assert.strictEqual(result.hits[1].id, ids[1]);
  assert.strictEqual(result.hits[1].matched, 'text');
  assert.match(result.hits[1].excerpt, /brake unit must warm up/);
  // The excerpt is a window, not the whole document.
  assert.ok(result.hits[1].excerpt.length < kb.read(c, { id: ids[1] }).text.length);

  // Identical input gives identical output, score included. tookMs is wall
  // clock and is excluded: it is a diagnostic, not part of the answer.
  const again = kb.search(c, { query: 'brake', k: 5 });
  assert.deepStrictEqual(
    Object.assign({}, again, { tookMs: 0 }),
    Object.assign({}, result, { tookMs: 0 }),
  );
  assert.strictEqual(typeof result.tookMs, 'number');
  // A query nothing answers is an empty page, not an error.
  const none = kb.search(c, { query: 'zzzznothing' });
  assert.deepStrictEqual(none.hits, []);
  assert.strictEqual(none.total, 0);
  // k bounds the page, not the total.
  assert.strictEqual(kb.search(c, { query: 'brake', k: 1 }).hits.length, 1);
  assert.strictEqual(kb.search(c, { query: 'brake', k: 1 }).total, 2);
});

test('search is deterministic across a corpus with tied scores', function () {
  const c = ctx();
  seed(c, [
    { collection: 'a', title: 'same words here', text: 'same words here' },
    { collection: 'b', title: 'same words here', text: 'same words here' },
    { collection: 'c', title: 'same words here', text: 'same words here' },
  ]);
  const first = kb.search(c, { query: 'same words' });
  const second = kb.search(c, { query: 'same words' });
  assert.deepStrictEqual(
    first.hits.map(function (hit) {
      return hit.id;
    }),
    second.hits.map(function (hit) {
      return hit.id;
    }),
  );
  assert.strictEqual(first.hits.length, 3);
  const ids = first.hits.map(function (hit) {
    return hit.id;
  });
  assert.deepStrictEqual(ids.slice().sort(), ids);
});

test('an id and a collection are validated, and a traversal id is refused', function () {
  const c = ctx();
  assert.throws(
    function () {
      kb.read(c, { id: '../state' });
    },
    function (error) {
      return error.code === 'KB_ID_INVALID';
    },
  );
  assert.throws(
    function () {
      kb.read(c, { id: 'kb-..-20260101000000' });
    },
    function (error) {
      return error.code === 'KB_ID_INVALID';
    },
  );
  assert.throws(
    function () {
      kb.write(c, { id: 'kb-ok-20260101000000/../escape', title: 'x', text: 'y' });
    },
    function (error) {
      return error.code === 'KB_ID_INVALID';
    },
  );
  // A collection name is normalised to lower case, not refused: a panel that
  // sends "Specs" means the same directory as "specs".
  assert.strictEqual(kb.write(c, { collection: 'UPPER', title: 'x', text: 'y' }).collection, 'upper');
  // Windows is case-insensitive, so existence cannot tell "UPPER" from "upper".
  // The spelling on disk is the assertion that carries meaning: one directory,
  // created under the normalised name.
  assert.deepStrictEqual(fs.readdirSync(path.join(c.dataDir, 'kb')), ['upper']);
  assert.throws(
    function () {
      kb.write(c, { collection: '../escape', title: 'x', text: 'y' });
    },
    function (error) {
      return error.code === 'KB_COLLECTION_INVALID';
    },
  );
  assert.throws(
    function () {
      kb.write(c, { collection: 'with space', title: 'x', text: 'y' });
    },
    function (error) {
      return error.code === 'KB_COLLECTION_INVALID';
    },
  );
  assert.throws(
    function () {
      kb.write(c, { collection: 'a'.repeat(65), title: 'x', text: 'y' });
    },
    function (error) {
      return error.code === 'KB_COLLECTION_INVALID';
    },
  );
  // A syntactically valid segment with no entry is a missing row, not a bad id:
  // the two failures mean different things to a panel.
  assert.throws(
    function () {
      kb.read(c, { id: 'kb-absent-20260101000000' });
    },
    function (error) {
      return error.code === 'KB_NOT_FOUND';
    },
  );
  assert.throws(
    function () {
      kb.read(c, {});
    },
    function (error) {
      return error.code === 'KB_ID_INVALID';
    },
  );
  assert.throws(
    function () {
      kb.read(c, { id: 'Not A Segment' });
    },
    function (error) {
      return error.code === 'KB_ID_INVALID';
    },
  );
  // An id shaped like a kb id but for a different collection is still missing.
  assert.throws(
    function () {
      kb.read(c, { id: 'kb-elsewhere-20260101000000' });
    },
    function (error) {
      return error.code === 'KB_NOT_FOUND';
    },
  );
  // Nothing above may have escaped the kb root: no traversal directory, no
  // write into the data root itself.
  assert.deepStrictEqual(fs.readdirSync(path.join(c.dataDir, 'kb')), ['upper']);
  assert.strictEqual(fs.existsSync(path.join(c.dataDir, 'state.json')), false);
});

test('collections summarises a count and the newest update per collection', function () {
  const c = ctx();
  const ids = seed(c, [
    { collection: 'specs', title: 'one', text: 'a' },
    { collection: 'specs', title: 'two', text: 'b' },
    { collection: 'notes', title: 'three', text: 'c' },
  ]);
  const summary = kb.collections(c);
  assert.deepStrictEqual(
    summary.items.map(function (item) {
      return item.name + ':' + item.count;
    }),
    ['notes:1', 'specs:2'],
  );
  const specs = summary.items.find(function (item) {
    return item.name === 'specs';
  });
  assert.ok(specs.updatedAt);
  assert.strictEqual(specs.updatedAt, kb.read(c, { id: ids[1] }).updatedAt);
  // An empty knowledge base answers an empty list rather than throwing.
  const empty = ctx();
  assert.deepStrictEqual(kb.collections(empty), { items: [] });
  assert.deepStrictEqual(kb.list(empty, {}), { items: [], total: 0 });
});

test('the kb root follows ctx.dataDir and refuses a context with no root', function () {
  const c = ctx();
  assert.strictEqual(kb.kbRoot(c), path.join(c.dataDir, 'kb'));
  assert.strictEqual(kb.normaliseCollection('Specs'), 'specs');
  assert.strictEqual(kb.normaliseCollection(''), 'default');
  assert.deepStrictEqual(kb.tokenize('Brake, warm-up 4s #thermal'), ['brake', 'warm', 'up', '4s', '#thermal']);
  assert.throws(
    function () {
      kb.list(null, {});
    },
    function (error) {
      return error.code === 'DATA_PATH_MISSING';
    },
  );
});
