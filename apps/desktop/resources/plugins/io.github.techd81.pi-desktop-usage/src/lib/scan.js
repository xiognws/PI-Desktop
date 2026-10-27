"use strict";

/**
 * Session-file discovery and incremental scanning.
 *
 * One pass never reads a byte twice: every file keeps a byte `offset` cursor
 * plus the `size`/`mtimeMs` it was read at, so a warm pass only stats the files
 * and reads the appended tail. A file that shrank, was rewritten or was
 * replaced is re-read from the start, after its old records are dropped (no
 * stale duplicates).
 *
 * A pass always carries a time budget: the panel bridge times out after 30 s, so
 * a cold scan of a few hundred megabytes returns `budgetExhausted: true`
 * instead of blocking the UI, and the view simply asks again. Cursors advance
 * inside a file too, so an interrupted pass resumes where it stopped rather
 * than restarting the same big file forever.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");

const MAX_DEPTH = 3;
const FLUSH_EVERY = 20;
const DEFAULT_BUDGET_MS = 12000;
/** How much of a file head is hashed to tell "appended" from "replaced". */
const HEAD_BYTES = 256;
const STOP_CHECK_LINES = 512;

/**
 * @param {string} root
 * @param {string[]} [failed] paths this pass could not list or refused to follow
 * @returns {Promise<Array<{ path: string, size: number, mtimeMs: number }>>}
 */
async function listSessionFiles(root, failed = []) {
  /** @type {Array<{ path: string, size: number, mtimeMs: number }>} */
  const out = [];
  await walk(root, 0, out, failed);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * @param {string} dir
 * @param {number} depth
 * @param {Array<{ path: string, size: number, mtimeMs: number }>} out
 * @param {string[]} failed
 */
async function walk(dir, depth, out, failed) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory must not look like an empty one: the caller marks
    // the pass as partial so sessions inside it are not retired.
    failed.push(dir);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Links are never followed (they could point outside the session root),
      // but they are not silently dropped either: a session tree that became a
      // junction would otherwise be retired as "deleted" and zero the totals.
      failed.push(full);
      continue;
    }
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(full, depth + 1, out, failed);
      else failed.push(full);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const stat = await fs.stat(full);
      out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A file that disappears between readdir and stat is simply not scanned.
    }
  }
}

/**
 * Session identity inferred from the file name, used only when the header line
 * is unavailable (a session that was never flushed, or an already-consumed file).
 *
 * @param {string} filePath
 * @param {string} source
 * @returns {string}
 */
function sessionIdFromPath(filePath, source) {
  const base = path.basename(filePath).replace(/\.jsonl$/i, "");
  if (source === "cli") {
    const index = base.lastIndexOf("_");
    if (index !== -1) {
      const tail = base.slice(index + 1);
      if (/^[0-9a-f-]{8,}$/i.test(tail)) return tail;
    }
  }
  return base;
}

/**
 * Identity of the first bytes of a file.
 *
 * Size and mtime cannot tell an append apart from a replacement: a session file
 * copied back from a backup, rewritten by the host or restored on another
 * machine can be both newer and larger while its content no longer continues
 * the cursor. Hashing the head costs one small read per changed file and makes
 * "is this still the same file?" answerable.
 *
 * @param {string} filePath
 * @returns {Promise<string | null>} `null` when the file cannot be read
 */
async function headFingerprint(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return createHash("sha1").update(buffer.subarray(0, bytesRead)).digest("hex");
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Read every complete line from `startOffset` to end of file.
 *
 * The trailing partial line (a write in progress) is deliberately left out: the
 * returned offset points just past the last consumed newline, so the next pass
 * reparses that line once it is whole.
 *
 * Lines are split on the `0x0a` byte before decoding. Re-encoding a decoded
 * string would report a different byte length for invalid UTF-8 (every bad byte
 * becomes a three-byte replacement character) and drift the cursor into the
 * middle of a record.
 *
 * @param {string} filePath
 * @param {number} startOffset
 * @param {(line: string) => void} onLine
 * @param {(error: unknown) => void} [onError]
 * @param {(() => boolean)} [shouldStop] polled between lines, so a huge file
 *   still saves its progress when the pass runs out of time
 * @returns {Promise<{ offset: number, stopped: boolean }>} the next cursor
 */
function readFrom(filePath, startOffset, onLine, onError, shouldStop) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { start: startOffset, highWaterMark: 1 << 20 });
    let pending = Buffer.alloc(0);
    let consumed = 0;
    // Counted across chunks: a long-line file never reaches the threshold inside
    // a single chunk, which would make the budget check unreachable.
    let sinceCheck = 0;
    let settled = false;
    let stopped = false;

    const deliver = (lineBuffer) => {
      const line = lineBuffer.toString("utf8").replace(/\r$/, "");
      try {
        onLine(line);
      } catch (error) {
        onError?.(error);
      }
    };

    const finish = (wasStopped) => {
      if (settled) return;
      settled = true;
      resolve({ offset: startOffset + consumed, stopped: wasStopped });
    };

    stream.on("data", (chunk) => {
      if (settled) return;
      const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const buffer = pending.length === 0 ? piece : Buffer.concat([pending, piece]);
      let lineStart = 0;
      let index;
      while ((index = buffer.indexOf(0x0a, lineStart)) !== -1) {
        deliver(buffer.subarray(lineStart, index));
        consumed += index + 1 - lineStart;
        lineStart = index + 1;
        sinceCheck += 1;
        if (sinceCheck >= STOP_CHECK_LINES) {
          sinceCheck = 0;
          if (shouldStop?.()) {
            stopped = true;
            break;
          }
        }
      }
      pending = stopped ? Buffer.alloc(0) : buffer.subarray(lineStart);
      if (stopped) {
        stream.destroy();
        finish(true);
      }
    });
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.on("end", () => finish(false));
    stream.on("close", () => {
      if (stopped) finish(true);
    });
  });
}

/**
 * Scan one file, appending whatever it has produced since the last pass.
 *
 * @param {{
 *   file: { path: string, size: number, mtimeMs: number },
 *   source: string,
 *   adapter: { safeParse: (line: string) => unknown, parseHeader: (parsed: unknown) => { sessionId: string, projectPath: string | null } | null, parseEntry: (parsed: unknown, ctx: any) => any[] },
 *   store: import("./store.js").RecordStore,
 *   shouldStop?: () => boolean,
 * }} options
 * @returns {Promise<{ skipped: boolean, appended: number, errors: number, stopped: boolean }>}
 */
async function scanFile({ file, source, adapter, store, shouldStop }) {
  const key = `${source}|${file.path}`;
  const previous = store.fileState(key);

  if (
    previous &&
    previous.size === file.size &&
    previous.mtimeMs === file.mtimeMs &&
    previous.incomplete !== true
  ) {
    return { skipped: true, appended: 0, errors: 0, stopped: false };
  }

  let startOffset = 0;
  let sessionId = "";
  let projectPath = null;
  /** @type {string | null} */
  let dropSessionId = null;
  const head = await headFingerprint(file.path);

  if (previous) {
    // A matching head is the only proof that the bytes before the cursor still
    // belong to this content; size alone would treat a longer replacement as an
    // append and keep records that describe nothing on disk any more.
    const appendable =
      previous.offset > 0 &&
      file.size >= previous.offset &&
      head !== null &&
      typeof previous.head === "string" &&
      previous.head === head;
    if (appendable) {
      startOffset = previous.offset;
      sessionId = previous.sessionId ?? "";
      projectPath = previous.projectPath ?? null;
    } else if (previous.sessionId && !store.sessionStillReferenced(source, previous.sessionId, key)) {
      // Truncated or replaced. The old records are dropped only after the
      // replacement has been read: a failed read would otherwise leave the cache
      // holding neither the old content nor the new one.
      dropSessionId = previous.sessionId;
    }
  }

  let isFirstLine = startOffset === 0;
  let appended = 0;
  let errors = 0;
  const fallbackTimestampMs = file.mtimeMs;
  const context = () => ({
    sessionId: sessionId || sessionIdFromPath(file.path, source),
    projectPath,
    fallbackTimestampMs,
  });

  /** @type {import("../lib/normalize.js").UsageRecord[]} */
  const collected = [];

  const outcome = await readFrom(
    file.path,
    startOffset,
    (line) => {
      if (line.trim() === "") return;
      const parsed = adapter.safeParse(line);
      if (parsed === null) {
        errors += 1;
        return;
      }
      if (isFirstLine) {
        isFirstLine = false;
        const header = adapter.parseHeader(parsed);
        if (header) {
          sessionId = header.sessionId;
          if (header.projectPath) projectPath = header.projectPath;
          return;
        }
      }
      const records = adapter.parseEntry(parsed, context());
      if (records.length > 0) {
        for (const record of records) collected.push(record);
        appended += records.length;
      }
    },
    () => {
      errors += 1;
    },
    shouldStop,
  );

  // The read succeeded, so the replacement content is in hand: only now is it
  // safe to drop what the previous content contributed.
  if (dropSessionId) store.removeSession(source, dropSessionId);
  if (collected.length > 0) store.addRecords(collected);

  if (!sessionId) sessionId = sessionIdFromPath(file.path, source);
  // `size` records the consumed cursor, not the file length: while the last line
  // is still unterminated (or the pass stopped early) the two differ, so the
  // next pass continues from exactly here.
  store.setFileState(key, {
    source,
    size: outcome.offset,
    mtimeMs: file.mtimeMs,
    offset: outcome.offset,
    sessionId,
    projectPath,
    head,
    incomplete: outcome.stopped,
  });

  return { skipped: false, appended, errors, stopped: outcome.stopped };
}

/**
 * Scan one session root.
 *
 * @param {{
 *   root: string,
 *   source: string,
 *   adapter: any,
 *   store: import("./store.js").RecordStore,
 *   budgetMs?: number,
 *   startedAt?: number,
 *   shouldStop?: () => boolean,
 * }} options
 * @returns {Promise<{ root: string, source: string, totalFiles: number, scannedFiles: number, skippedFiles: number, appendedRecords: number, partial: boolean, budgetExhausted: boolean, errors: Array<{ path: string, reason: string }> }>}
 */
async function scanRoot({
  root,
  source,
  adapter,
  store,
  budgetMs = DEFAULT_BUDGET_MS,
  startedAt = Date.now(),
  shouldStop,
}) {
  const unreadableDirs = [];
  const files = await listSessionFiles(root, unreadableDirs);
  const result = {
    root,
    source,
    totalFiles: files.length,
    scannedFiles: 0,
    skippedFiles: 0,
    appendedRecords: 0,
    // `partial` means content exists that this pass could not read at all: the
    // only safe reaction is to keep what is cached, so retirement is skipped.
    partial: unreadableDirs.length > 0,
    // `budgetExhausted` means the pass simply ran out of time and a later pass
    // will finish the job. Keeping them apart stops a permanently unreadable
    // directory from turning every refresh into twelve identical full passes.
    budgetExhausted: false,
    errors: unreadableDirs.map((dir) => ({ path: dir, reason: "unreadable directory" })),
  };

  const outOfTime = () => Date.now() - startedAt >= budgetMs;
  const stopNow = () => Boolean(shouldStop?.()) || outOfTime();

  const seen = new Set();
  let sinceFlush = 0;

  for (const file of files) {
    if (stopNow()) {
      result.budgetExhausted = true;
      break;
    }
    seen.add(`${source}|${file.path}`);
    try {
      const outcome = await scanFile({ file, source, adapter, store, shouldStop: stopNow });
      if (outcome.skipped) {
        result.skippedFiles += 1;
      } else {
        result.scannedFiles += 1;
        result.appendedRecords += outcome.appended;
      }
      if (outcome.errors > 0) {
        result.errors.push({
          path: file.path,
          reason: `${outcome.errors} unreadable line(s)`,
        });
      }
      if (outcome.stopped) {
        result.budgetExhausted = true;
        break;
      }
    } catch (error) {
      result.errors.push({
        path: file.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    sinceFlush += 1;
    if (sinceFlush >= FLUSH_EVERY) {
      await store.flush();
      sinceFlush = 0;
    }
  }

  // Retiring means "this file is provably gone". A path under a directory this
  // pass could not list is not provably gone, but that must not freeze the rest:
  // a single unreadable or linked directory would otherwise keep every deleted
  // session's records in the totals for good.
  if (!result.budgetExhausted) {
    const prefix = `${source}|`;
    const blocked = (stalePath) =>
      unreadableDirs.some((dir) => stalePath === dir || stalePath.startsWith(`${dir}${path.sep}`));
    for (const key of [...store.files.keys()]) {
      if (!key.startsWith(prefix) || seen.has(key)) continue;
      if (blocked(key.slice(prefix.length))) continue;
      const stale = store.fileState(key);
      // One session can span several files: only drop its records when no
      // surviving file still claims it.
      if (stale?.sessionId && !store.sessionStillReferenced(source, stale.sessionId, key)) {
        store.removeSession(source, stale.sessionId);
      }
      store.files.delete(key);
      store.dirtyState = true;
    }
  }

  await store.flush();
  return result;
}

module.exports = {
  DEFAULT_BUDGET_MS,
  HEAD_BYTES,
  listSessionFiles,
  sessionIdFromPath,
  headFingerprint,
  readFrom,
  scanFile,
  scanRoot,
};
