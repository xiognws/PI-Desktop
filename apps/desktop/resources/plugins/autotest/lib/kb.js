'use strict';
/**
 * Knowledge base. One entry is one JSON file plus an optional human-readable
 * markdown twin under `<dataDir>/kb/<collection>/`, so the store stays
 * inspectable with a file manager and needs no database, no server and no
 * embedding service.
 *
 * Two properties this module is built around:
 *  - nothing leaves the collection unless its id and its collection name pass
 *    the same literal whitelist the plan store uses, so a crafted id cannot
 *    address a file outside the kb root;
 *  - every read is deterministic: list, search and collections all order by an
 *    explicit key, so the same directory answers the same bytes.
 */

const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');

const ROOT_DIR = 'kb';
const DEFAULT_COLLECTION = 'default';

/** The same whitelist lib/store.js applies to a plan id: a name, never a path. */
const SEGMENT_RE = /^[a-z0-9._-]+$/;
const COLLECTION_MAX = 64;
const ID_MAX = 160;

/** A hit wider than the old 600-char default excerpt still needs a bound. */
const EXCERPT_RADIUS = 60;
const DEFAULT_LIMIT = 50;
const DEFAULT_K = 10;

/** BM25 constants. Fixed, so a score is reproducible to the digit. */
const K1 = 1.2;
const B = 0.75;

/** field weight, saturation (matches per document) and the overshoot length penalty. */
const FIELD_WEIGHT = { title: 3, tags: 2.5, text: 1 };
const SATURATION = { title: 3, tags: 4, text: 6 };
/**
 * How hard a long body is discounted, as a fraction of its own relevance.
 *
 * This is a multiplier, not a subtraction. An absolute subtraction looked
 * reasonable and was wrong: in a small corpus idf is tiny (one document gives
 * log(1 + 0.5/1.5) = 0.288), so a 21-token body cost 0.2 * log(22) = 0.618 and
 * a document that genuinely matched the query scored negative and was dropped
 * by the `score <= 0` filter below. A hit that exists must never be hidden by
 * the length of the field it was found in.
 */
const LENGTH_PENALTY = 0.35;

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

/**
 * Validate one path segment.
 *
 * `..` is rejected before the pattern is even consulted: it would pass a
 * naive [a-z0-9._-] test, and a directory walk inside a knowledge base is the
 * one failure that cannot be undone by a later write.
 */
function segment(value, code, max, label) {
  const text = value == null ? '' : String(value);
  if (!text || text.length > max || text.indexOf('..') !== -1 || !SEGMENT_RE.test(text)) {
    throw fail('invalid ' + label + ': ' + String(value), code);
  }
  return text;
}

function checkId(id) {
  return segment(id, 'KB_ID_INVALID', ID_MAX, 'kb id');
}

function normaliseCollection(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_COLLECTION;
  const text = String(value).trim().toLowerCase();
  return segment(text, 'KB_COLLECTION_INVALID', COLLECTION_MAX, 'kb collection');
}

function kbRoot(ctx) {
  return path.join(store.dataRootLike(ctx), ROOT_DIR);
}

function collectionDir(ctx, collection) {
  const name = normaliseCollection(collection);
  return { name: name, dir: path.join(kbRoot(ctx), name) };
}

function entryFile(ctx, id) {
  const wanted = checkId(id);
  const carried = /^kb-([a-z0-9._-]+)-[0-9]{14}$/.exec(wanted);
  if (!carried) {
    throw fail('kb id must look like kb-<slug>-<yyyymmddHHMMSS>: ' + wanted, 'KB_ID_INVALID');
  }
  const location = locate(ctx, wanted);
  return path.join(location.dir, wanted + '.json');
}

/**
 * Find the collection that owns one id by reading the entry itself.
 *
 * The id carries no collection, and a caller that only names the id must not be
 * forced to remember where it filed it. Scanning the collections in name order
 * keeps the answer deterministic when the same id was written twice.
 */
function locate(ctx, id) {
  const wanted = checkId(id);
  const names = collectionNames(ctx);
  for (const name of names) {
    const dir = path.join(kbRoot(ctx), name);
    if (fs.existsSync(path.join(dir, wanted + '.json'))) return { name: name, dir: dir };
  }
  const error = fail('kb entry not found: ' + wanted, 'KB_NOT_FOUND');
  error.id = wanted;
  throw error;
}

function collectionNames(ctx) {
  const root = kbRoot(ctx);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(function (entry) {
      return entry.isDirectory() && SEGMENT_RE.test(entry.name) && entry.name.indexOf('..') === -1;
    })
    .map(function (entry) {
      return entry.name;
    })
    .sort();
}

/** Normalise one stored document. A hand-edited file must not crash a reader. */
function normaliseEntry(raw, fallbackCollection) {
  const text = String((raw && raw.text) || '');
  return {
    id: String((raw && raw.id) || ''),
    collection: String((raw && raw.collection) || fallbackCollection || DEFAULT_COLLECTION),
    title: String((raw && raw.title) || ''),
    tags: Array.isArray(raw && raw.tags) ? raw.tags.map(String) : [],
    source: raw && raw.source && typeof raw.source === 'object' ? { kind: String(raw.source.kind || ''), ref: String(raw.source.ref || '') } : null,
    text: text,
    createdAt: (raw && raw.createdAt) || null,
    updatedAt: (raw && raw.updatedAt) || null,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function readEntryFile(file, collection) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normaliseEntry(raw, collection);
}

/** The markdown twin: a title, the tags, the source and the raw body. */
function renderMarkdown(entry) {
  const lines = ['# ' + (entry.title || entry.id), ''];
  if (entry.tags.length) lines.push('Tags: ' + entry.tags.join(', '), '');
  if (entry.source) lines.push('Source: ' + entry.source.kind + ' ' + entry.source.ref, '');
  lines.push('Id: ' + entry.id, 'Collection: ' + entry.collection, 'Updated: ' + String(entry.updatedAt || ''), '');
  lines.push(entry.text, '');
  return lines.join('\n');
}

function writeAtomic(file, body) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

/** Strip a corpus down to comparable terms. Letters, digits, CJK and # only. */
function tokenize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff#]+/)
    .filter(function (token) {
      return token.length > 0;
    });
}

function nowMs() {
  const clock = globalThis.performance;
  return clock && typeof clock.now === 'function' ? clock.now() : Date.now();
}

/* ------------------------------------------------------------------ write */

/**
 * Create or update one entry.
 *
 * An update is addressed by id alone and keeps the original collection unless
 * the caller asks to move it, so a panel that edits a row never has to know how
 * entries are filed. createdAt survives every update; updatedAt never goes
 * backwards, because two writes inside the same millisecond would otherwise
 * make the deterministic order depend on which one landed last.
 */
function write(ctx, input) {
  const args = input || {};
  const title = String(args.title == null ? '' : args.title).trim();
  const text = String(args.text == null ? '' : args.text);
  if (!title && !text.trim()) {
    throw fail('a kb entry needs a title or a text body', 'KB_ENTRY_EMPTY');
  }
  const tags = Array.isArray(args.tags)
    ? args.tags
        .map(function (tag) {
          return String(tag).trim();
        })
        .filter(Boolean)
    : [];
  const source = args.source && typeof args.source === 'object'
    ? { kind: String(args.source.kind || 'text'), ref: String(args.source.ref == null ? '' : args.source.ref) }
    : null;

  const stampText = stamp();
  let id;
  let collection;
  let previous = null;
  if (args.id) {
    id = checkId(args.id);
    const at = locate(ctx, id);
    previous = readEntryFile(path.join(at.dir, id + '.json'), at.name);
    collection = args.collection ? normaliseCollection(args.collection) : previous.collection || at.name;
  } else {
    id = 'kb-' + store.slug(title || text.slice(0, 40)) + '-' + stampText;
    collection = normaliseCollection(args.collection);
    const at = collectionDir(ctx, collection);
    if (fs.existsSync(path.join(at.dir, id + '.json'))) {
      throw fail('a kb entry with this id already exists: ' + id, 'KB_ID_CONFLICT');
    }
  }

  const now = nowIso();
  const createdAt = previous && previous.createdAt ? previous.createdAt : now;
  let updatedAt = now;
  if (previous && previous.updatedAt && nowMs(now) <= nowMs(previous.updatedAt)) {
    // Same millisecond (or a clock that stepped back): keep the ordering strict
    // and readable rather than letting two writes tie.
    updatedAt = nowIso(nowMs(previous.updatedAt) + 1);
  }
  const entry = {
    id: id,
    collection: collection,
    title: title || id,
    tags: tags,
    source: source,
    text: text,
    createdAt: createdAt,
    updatedAt: updatedAt,
  };
  entry.bytes = Buffer.byteLength(text, 'utf8');

  const at = collectionDir(ctx, collection);
  fs.mkdirSync(at.dir, { recursive: true });
  writeAtomic(path.join(at.dir, id + '.json'), JSON.stringify(entry, null, 2));
  writeAtomic(path.join(at.dir, id + '.md'), renderMarkdown(entry));
  if (args.id && previous && previous.collection && previous.collection !== collection) {
    // A move leaves the markdown twin behind otherwise, and collections() would
    // count the entry twice.
    removeFiles(ctx, id, previous.collection);
  }
  return { id: id, collection: collection, createdAt: createdAt, updatedAt: updatedAt, bytes: entry.bytes };
}

function removeFiles(ctx, id, collection) {
  const at = collectionDir(ctx, collection);
  ['json', 'md'].forEach(function (extension) {
    const file = path.join(at.dir, id + '.' + extension);
    if (fs.existsSync(file)) fs.rmSync(file);
  });
  pruneDir(at.dir);
  return { id: id, collection: at.name };
}

/**
 * Remove a collection directory that no longer holds a JSON entry.
 *
 * A move deletes the old twin files, and an empty directory would keep showing
 * up in collections() with a count of zero — a phantom collection the panel can
 * list but never open. The directory is removed only when it holds no `.json`
 * file; anything else a user put there is left alone.
 */
function pruneDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return false;
  }
  if (names.some(function (name) { return /\.json$/.test(name); })) return false;
  try {
    fs.rmdirSync(dir);
    return true;
  } catch (error) {
    // Not empty, or held open by another reader. A phantom row is cosmetic;
    // deleting a directory a user owns would not be.
    return false;
  }
}

/* ------------------------------------------------------------------- read */

/** One full entry, or KB_NOT_FOUND. */
function read(ctx, input) {
  const args = input || {};
  const id = checkId(args.id);
  const at = locate(ctx, id);
  return readEntryFile(path.join(at.dir, id + '.json'), at.name);
}

function matchQuery(entry, needle) {
  if (!needle) return true;
  const haystack = [entry.title, entry.tags.join(' '), entry.text].join('\n').toLowerCase();
  return haystack.indexOf(needle) !== -1;
}

/**
 * A deterministic page of the collection.
 *
 * Ordering is updatedAt descending then id ascending, so a caller that reads
 * the same directory twice gets the same page and a paginated panel cannot skip
 * or repeat a row between polls.
 */
function list(ctx, input) {
  const args = input || {};
  const collection = args.collection ? normaliseCollection(args.collection) : null;
  const query = args.query == null ? '' : String(args.query).trim().toLowerCase();
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : DEFAULT_LIMIT;
  const names = collection ? [collection] : collectionNames(ctx);
  const items = [];
  names.forEach(function (name) {
    const dir = path.join(kbRoot(ctx), name);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function (file) {
      if (!/\.json$/.test(file)) return;
      try {
        const entry = readEntryFile(path.join(dir, file), name);
        if (matchQuery(entry, query)) items.push(entry);
      } catch (error) {
        // A half-written or hand-edited entry is skipped, not fatal: one broken
        // file must not make the whole knowledge base unreadable.
      }
    });
  });
  items.sort(byRecency);
  return { items: items.slice(0, limit), total: items.length };
}

function byRecency(a, b) {
  const left = String(a.updatedAt || '');
  const right = String(b.updatedAt || '');
  if (left !== right) return right.localeCompare(left);
  return String(a.id).localeCompare(String(b.id));
}

/** Delete both the entry and its markdown twin. */
function remove(ctx, input) {
  const args = input || {};
  const id = checkId(args.id);
  const at = locate(ctx, id);
  removeFiles(ctx, id, at.name);
  return { id: id, collection: at.name, removed: true };
}

function collections(ctx) {
  const names = collectionNames(ctx);
  const items = names.map(function (name) {
    const page = list(ctx, { collection: name, limit: Number.MAX_SAFE_INTEGER });
    let updatedAt = null;
    page.items.forEach(function (entry) {
      const value = String(entry.updatedAt || '');
      if (!updatedAt || value > updatedAt) updatedAt = value;
    });
    return { name: name, count: page.total, updatedAt: updatedAt };
  });
  return { items: items };
}

/* ----------------------------------------------------------------- search */

/** The window of ~60 characters either side of the first hit inside one field. */
function excerptOf(field, index, needle) {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(field.length, index + needle.length + EXCERPT_RADIUS);
  const body = field.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + body + (end < field.length ? '…' : '');
}

/**
 * Per field: how many distinct query terms appear, and where the first one does.
 *
 * Counting distinct terms rather than raw occurrences is what makes the excerpt
 * and the score agree: a body that repeats one word twenty times scores once,
 * and the excerpt still quotes the first real hit.
 */
function fieldStats(entry, terms) {
  const fields = { title: entry.title, tags: entry.tags.join(' '), text: entry.text };
  const counts = { title: 0, tags: 0, text: 0 };
  const occurrences = { title: -1, tags: -1, text: -1 };
  Object.keys(fields).forEach(function (name) {
    const haystack = String(fields[name] || '').toLowerCase();
    const tokens = tokenize(haystack);
    terms.forEach(function (term) {
      let first = -1;
      for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index] !== term) continue;
        counts[name] += 1;
        // tokenize drops the offsets, so the position is recovered by finding
        // the term in the raw field; a failing indexOf only costs the excerpt.
        first = haystack.indexOf(term);
        break;
      }
      if (first !== -1 && occurrences[name] === -1) occurrences[name] = first;
    });
  });
  return { fields: fields, counts: counts, occurrences: occurrences };
}

/** Which field the excerpt should quote: the best-weighted hit, ties by earli. */
function bestField(counts) {
  const order = ['title', 'tags', 'text'];
  let best = null;
  order.forEach(function (name) {
    if (counts[name] > 0 && !best) best = name;
  });
  return best;
}

/**
 * Deterministic search.
 *
 * BM25 supplies the term frequency and document length part of the score; the
 * field weight and the saturation cap are this module's own, because a short
 * title that says the word is worth more than the same word buried in a long
 * body, and a body that repeats it twenty times must not win by volume alone.
 * Ties break on updatedAt descending, then id ascending.
 */
function search(ctx, input) {
  const args = input || {};
  const query = String(args.query == null ? '' : args.query).trim();
  const k = Number.isFinite(Number(args.k)) && Number(args.k) > 0 ? Math.floor(Number(args.k)) : DEFAULT_K;
  const names = args.collection ? [normaliseCollection(args.collection)] : collectionNames(ctx);
  const started = nowMs();
  const documents = [];
  names.forEach(function (name) {
    const dir = path.join(kbRoot(ctx), name);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function (file) {
      if (!/\.json$/.test(file)) return;
      try {
        documents.push(readEntryFile(path.join(dir, file), name));
      } catch (error) {
        /* one unreadable entry must not hide the rest of the corpus */
      }
    });
  });

  const terms = Array.from(new Set(tokenize(query)));
  const hits = [];
  if (terms.length) {
    // The document frequency that keeps a term everyone writes from dominating.
    const documentFrequency = {};
    terms.forEach(function (term) {
      documentFrequency[term] = 0;
    });
    const lengths = documents.map(function (entry) {
      return tokenize(entry.title + ' ' + entry.tags.join(' ') + ' ' + entry.text).length;
    });
    const average = lengths.length ? lengths.reduce(function (sum, value) {
      return sum + value;
    }, 0) / lengths.length : 0;
    documents.forEach(function (entry, position) {
      const stats = fieldStats(entry, terms);
      terms.forEach(function (term) {
        if (stats.counts.title + stats.counts.tags + stats.counts.text > 0) documentFrequency[term] += 1;
      });
      const length = lengths[position] || 0;
      const norm = average > 0 ? 1 - B + B * (length / average) : 1;
      let score = 0;
      Object.keys(FIELD_WEIGHT).forEach(function (name) {
        terms.forEach(function (term) {
          const counted = stats.counts[name];
          if (!counted) return;
          const idf = Math.log(1 + (documents.length - documentFrequency[term] + 0.5) / (documentFrequency[term] + 0.5));
          const saturated = Math.min(counted, SATURATION[name]);
          score += FIELD_WEIGHT[name] * idf * ((saturated * (K1 + 1)) / (saturated + K1 * norm));
        });
      });
      if (score <= 0) return;
      // Scale towards 1 as the body approaches the corpus average, and towards
      // 1 - LENGTH_PENALTY for a body far longer than its peers.
      const overshoot = average > 0 ? Math.log(1 + length) / Math.log(1 + average) : 1;
      score *= Math.max(1 - LENGTH_PENALTY, Math.min(1, 1 / Math.max(1, overshoot)));
      const field = bestField(stats.counts) || 'text';
      hits.push({
        id: entry.id,
        title: entry.title,
        collection: entry.collection,
        score: Math.round(score * 1e6) / 1e6,
        excerpt: excerptOf(String(stats.fields[field] || ''), Math.max(0, stats.occurrences[field]), query),
        matched: field,
      });
    });
    hits.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  const page = hits.slice(0, k);
  return {
    query: query,
    terms: terms,
    hits: page,
    total: hits.length,
    corpus: documents.length,
    tookMs: Math.round((nowMs() - started) * 1000) / 1000,
  };
}

module.exports = {
  ROOT_DIR,
  DEFAULT_COLLECTION,
  EXCERPT_RADIUS,
  kbRoot,
  collectionDir,
  checkId,
  normaliseCollection,
  tokenize,
  list,
  read,
  write,
  remove,
  search,
  collections,
};
