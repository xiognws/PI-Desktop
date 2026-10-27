"use strict";

/**
 * Deterministic record cache.
 *
 * Two files inside the plugin data directory:
 * - `state.json`   per-session-file scanning cursor (`size`, `mtimeMs`, byte
 *                  `offset`, discovered session id and project path)
 * - `records.jsonl` one normalized record per line, keyed by `record.id`
 *
 * Why a JSONL append log instead of one big JSON: a scan touches hundreds of
 * files and appends a few thousand records; rewriting a multi-megabyte array on
 * every pass would dominate the runtime. Appends are cheap, and the in-memory
 * map keeps reads O(1) per record id, so a rescanned file can never double
 * count (the same id simply overwrites).
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { createReadStream } = require("node:fs");

const STATE_SCHEMA = 1;

class RecordStore {
  /**
   * @param {{ dir: string }} options
   */
  constructor({ dir }) {
    this.dir = dir;
    this.statePath = path.join(dir, "state.json");
    this.recordsPath = path.join(dir, "records.jsonl");
    /** @type {Map<string, import("../lib/normalize.js").UsageRecord>} */
    this.records = new Map();
    /** @type {Map<string, { source: string, size: number, mtimeMs: number, offset: number, sessionId: string | null, projectPath: string | null, head?: string | null, incomplete?: boolean }>} */
    this.files = new Map();
    /** `${source}\\0${sessionId}` → record ids, so dropping one session is O(k). */
    this.bySession = new Map();
    /** @type {import("../lib/normalize.js").UsageRecord[]} */
    this.pendingAppends = [];
    this.dirtyState = false;
    this.needsRewrite = false;
    this.loaded = false;
    this.loadedAt = 0;
    this.invalidLines = 0;
  }

  /**
   * Read the cache from disk once; afterwards the in-memory maps are the truth.
   * A damaged or outdated cache is discarded (safe: the sessions are the source
   * of truth and a rescan rebuilds everything).
   */
  async load() {
    if (this.loaded) return this;
    await fs.mkdir(this.dir, { recursive: true });
    await this.#loadState();
    await this.#loadRecords();
    this.loaded = true;
    this.loadedAt = Date.now();
    return this;
  }

  async #loadState() {
    let raw;
    try {
      raw = await fs.readFile(this.statePath, "utf8");
    } catch {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || parsed.schema !== STATE_SCHEMA || typeof parsed.files !== "object" || !parsed.files) return;
    for (const [key, value] of Object.entries(parsed.files)) {
      if (!value || typeof value !== "object") continue;
      this.files.set(key, {
        source: typeof value.source === "string" ? value.source : "",
        size: Number(value.size) || 0,
        mtimeMs: Number(value.mtimeMs) || 0,
        offset: Number(value.offset) || 0,
        sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
        projectPath: typeof value.projectPath === "string" ? value.projectPath : null,
        head: typeof value.head === "string" ? value.head : null,
        incomplete: value.incomplete === true,
      });
    }
    this.scannedAt = Number(parsed.scannedAt) || 0;
  }

  async #loadRecords() {
    await new Promise((resolve) => {
      const stream = createReadStream(this.recordsPath, { encoding: "utf8" });
      let pending = "";
      const handle = (line) => {
        if (!line.trim()) return;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          // A damaged line is dropped, and the log is rewritten on the next flush
          // so a later batch cannot be glued onto a torn fragment.
          this.invalidLines += 1;
          this.needsRewrite = true;
          return;
        }
        if (!record || typeof record.id !== "string") return;
        this.records.set(record.id, record);
        this.#index(record);
      };
      stream.on("data", (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          handle(line);
        }
      });
      stream.on("error", () => {
        // The log is missing or unreadable: drop the cursors so the next scan
        // rebuilds it instead of treating every session file as unchanged.
        this.files.clear();
        this.dirtyState = true;
        resolve();
      });
      stream.on("end", () => {
        // A trailing partial line is the only expected "damage" here.
        if (pending.trim()) handle(pending);
        resolve();
      });
    });
  }

  get size() {
    return this.records.size;
  }

  /** @returns {import("../lib/normalize.js").UsageRecord[]} */
  all() {
    return [...this.records.values()];
  }

  /**
   * @param {string} key
   * @returns {{ source: string, size: number, mtimeMs: number, offset: number, sessionId: string | null, projectPath: string | null, head?: string | null, incomplete?: boolean } | undefined}
   */
  fileState(key) {
    return this.files.get(key);
  }

  /**
   * @param {string} key
   * @param {{ source: string, size: number, mtimeMs: number, offset: number, sessionId: string | null, projectPath: string | null, head?: string | null, incomplete?: boolean }} value
   */
  setFileState(key, value) {
    this.files.set(key, value);
    this.dirtyState = true;
  }

  /**
   * @param {import("../lib/normalize.js").UsageRecord} record
   */
  #index(record) {
    if (typeof record.sessionId !== "string" || record.sessionId === "") return;
    const key = `${record.source}\u0000${record.sessionId}`;
    let ids = this.bySession.get(key);
    if (!ids) {
      ids = new Set();
      this.bySession.set(key, ids);
    }
    ids.add(record.id);
  }

  /**
   * True when another cached file still claims the same session. One session can
   * span several files (a copied directory, a resumed session), so dropping the
   * records of a truncated file must not erase the sibling's contribution.
   *
   * @param {string} source
   * @param {string} sessionId
   * @param {string} exceptKey
   * @returns {boolean}
   */
  sessionStillReferenced(source, sessionId, exceptKey) {
    if (!sessionId) return false;
    for (const [key, value] of this.files) {
      if (key === exceptKey) continue;
      if (value.sessionId !== sessionId) continue;
      if (value.source === source || key.startsWith(`${source}|`)) return true;
    }
    return false;
  }

  /**
   * Drop every cached state entry belonging to a source (used by `rebuild`).
   * @param {string} source
   */
  forgetSource(source) {
    for (const [key, value] of [...this.files]) {
      if (key.startsWith(`${source}|`) || value.source === source) this.files.delete(key);
    }
    this.dirtyState = true;
  }

  /**
   * Remove every record of one session (the file was truncated or replaced).
   * @param {string} source
   * @param {string} sessionId
   */
  removeSession(source, sessionId) {
    if (!sessionId) return;
    const indexKey = `${source}\u0000${sessionId}`;
    let changed = false;
    const ids = this.bySession.get(indexKey);
    if (ids) {
      for (const id of ids) {
        if (this.records.delete(id)) changed = true;
      }
      this.bySession.delete(indexKey);
    }
    // A record queued but not yet flushed would otherwise come back from the log.
    if (this.pendingAppends.length > 0) {
      const kept = this.pendingAppends.filter(
        (record) => record.source !== source || record.sessionId !== sessionId,
      );
      if (kept.length !== this.pendingAppends.length) {
        this.pendingAppends = kept;
        changed = true;
      }
    }
    if (changed) this.needsRewrite = true;
  }

  /**
   * @param {import("../lib/normalize.js").UsageRecord[]} records
   */
  addRecords(records) {
    for (const record of records) {
      if (!record || typeof record.id !== "string") continue;
      this.records.set(record.id, record);
      this.#index(record);
      this.pendingAppends.push(record);
    }
  }


  /**
   * Persist pending records and the scanning cursor.
   * @param {{ scannedAt?: number }} [options]
   */
  async flush(options = {}) {
    await fs.mkdir(this.dir, { recursive: true });

    if (this.needsRewrite) {
      // The queue is taken before the first await: anything added meanwhile lands
      // in the fresh array and is written by the next flush instead of vanishing.
      this.pendingAppends = [];
      this.needsRewrite = false;
      const lines = this.all().map((record) => JSON.stringify(record));
      await writeFileAtomic(this.recordsPath, lines.length ? `${lines.join("\n")}\n` : "");
    } else if (this.pendingAppends.length > 0) {
      const batch = this.pendingAppends;
      this.pendingAppends = [];
      const lines = batch.map((record) => JSON.stringify(record));
      await fs.appendFile(this.recordsPath, `${lines.join("\n")}\n`, "utf8");
    }

    if (this.dirtyState || options.scannedAt !== undefined) {
      if (options.scannedAt !== undefined) this.scannedAt = options.scannedAt;
      const files = {};
      for (const [key, value] of this.files) files[key] = value;
      await writeFileAtomic(
        this.statePath,
        `${JSON.stringify({ schema: STATE_SCHEMA, scannedAt: this.scannedAt ?? 0, files })}\n`,
      );
      this.dirtyState = false;
    }
  }

  /** Wipe both cache files and every in-memory entry. */
  async reset() {
    this.records.clear();
    this.files.clear();
    this.bySession.clear();
    this.pendingAppends = [];
    this.needsRewrite = false;
    this.dirtyState = true;
    this.scannedAt = 0;
    await fs.rm(this.recordsPath, { force: true });
    await this.flush();
  }
}

/**
 * Write a file through a temporary sibling, so an interrupted write leaves the
 * previous content intact instead of a half-written JSON document.
 *
 * @param {string} target
 * @param {string} contents
 */
async function writeFileAtomic(target, contents) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    // A rename that an antivirus or indexer interrupts must not leave the
    // temporary file behind in the plugin data directory.
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { RecordStore, STATE_SCHEMA, writeFileAtomic };
