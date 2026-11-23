/**
 * Legacy pi JSONL sessions, served from Electron main.
 *
 * The four `native.session.*` surfaces — `list`, `search`, `get`, `fork` — read
 * a store the Rust kernel does not own: pi's own JSONL session tree under
 * `<agent dir>/sessions` (plus any `sessionDir` a settings file configures), one
 * file per session, projected into the app as ids of the form `native-pi:<hash>`.
 *
 * Under the Node sidecar they are answered by
 * `packages/agent-runtime/src/native-pi-session.ts`. The kernel keeps no
 * pi-format store, so main answers them itself: "the kernel has no reader for
 * this" must not mean the user's existing conversations cannot be listed or
 * opened. The data is still on disk and this module is the path to it.
 *
 * This is a read-only mirror of that reference implementation, not a second
 * vocabulary: the same store locations, the same file-identity rules, the same
 * stable ids, the same projection, paging, fork layout and error codes. It
 * deliberately does not import `@earendil-works/pi-coding-agent`: the agent SDK
 * belongs to the runtime, main bundles none of it, and pulling `SessionManager`
 * plus the provider stack into main to read JSONL would make the thin
 * orchestrator the second agent runtime. The tree walk and projections are
 * therefore implemented here from the on-disk format, each rule citing the
 * reference it mirrors.
 *
 * Nothing here touches host-core's session table: this module only reads pi
 * session files and, on fork, creates one new child JSONL beside its parent.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  resolveAgentDataHome,
  type SessionDetail,
  type SessionSearchPage,
  type SessionSummary,
  type ThinkingLevel,
  type UiMessage,
} from "@pi-workspace/shared";

/** Session ids this module serves; identical to the sidecar's prefix. */
export const NATIVE_PI_SESSION_PREFIX = "native-pi:";

/** Header version the current format writes; older files are read-only. */
const CURRENT_SESSION_VERSION = 3;

/**
 * One parsed line of a session file. The format is a header line
 * (`type: "session"`) followed by tree entries linked by `parentId`; unknown
 * entry types from a newer writer are preserved and ignored, exactly as the
 * reference does.
 */
type PiEntry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  version?: number;
  cwd?: string;
  name?: string;
  summary?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  content?: unknown;
  display?: boolean;
  message?: {
    role?: string;
    content?: unknown;
    provider?: string;
    model?: string;
    stopReason?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    details?: unknown;
  };
  [key: string]: unknown;
};

/** One session file plus the identity facts a caller must re-check before writing. */
type SessionFile = {
  path: string;
  bytes: Buffer;
  hash: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  nonEmpty: boolean;
  validJsonl: boolean;
  trailingNewline: boolean;
  entries: PiEntry[];
  header: PiEntry | undefined;
};

type NativeSessionRecord = {
  id: string;
  path: string;
  nativeId: string;
  cwd: string;
};

/** Read-only reasons; the set and the vocabulary are the sidecar's own. */
export type NativePiReadOnlyReason =
  | "busy"
  | "changed-externally"
  | "invalid-session"
  | "legacy-format"
  | "missing-cwd"
  | "missing-trailing-newline"
  | "provider-unavailable"
  | "project-untrusted";

const MAX_NATIVE_PROJECT_PATHS = 500;
const MAX_SEARCH_QUERY = 500;

function searchContains(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function searchExcerpt(text: string, query: string, budget = 180): string {
  const characters = Array.from(text);
  if (characters.length <= budget) return text;
  const match = text.toLowerCase().indexOf(query.toLowerCase());
  const start = match < 0 ? 0 : Math.max(0, match - Math.floor(budget / 3));
  const end = Math.min(characters.length, start + budget);
  return `${start > 0 ? "…" : ""}${characters.slice(start, end).join("")}${end < characters.length ? "…" : ""}`;
}

/**
 * The public id of a session file. Content-addressed by `(path, header id)` so
 * the same conversation keeps one id across refreshes — this hash is the
 * sidecar's, byte for byte, or a session the user already has open would change
 * identity when main starts answering instead of the kernel.
 */
function stableId(path: string, nativeId: string): string {
  return `${NATIVE_PI_SESSION_PREFIX}${createHash("sha256")
    .update(`${path}\0${nativeId}`)
    .digest("base64url")
    .slice(0, 24)}`;
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function normalizeProjectPaths(paths: readonly string[] | undefined): string[] {
  if (!paths) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of paths) {
    if (typeof value !== "string") continue;
    const path = value.trim();
    // A remote project has no local `sessionDir` to honor.
    if (!path || path.startsWith("remote-project:") || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
    if (normalized.length >= MAX_NATIVE_PROJECT_PATHS) break;
  }
  return normalized;
}

function hashFileBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read one session file. `validJsonl` and the leaf rule mirror the sidecar's
 * `nativePiSnapshot`: the first parsed line must be the session header, and the
 * leaf is the last entry carrying an id.
 */
function readSessionFile(path: string): SessionFile {
  const stats = statSync(path);
  const bytes = readFileSync(path);
  const entries: PiEntry[] = [];
  let validJsonl = true;
  let parsedLines = 0;
  const text = bytes.toString("utf8");
  for (const line of text.trimEnd().split("\n")) {
    if (!line.trim()) continue;
    let entry: PiEntry;
    try {
      entry = JSON.parse(line) as PiEntry;
    } catch {
      validJsonl = false;
      continue;
    }
    if (parsedLines === 0 && entry?.type !== "session") validJsonl = false;
    parsedLines += 1;
    entries.push(entry);
  }
  return {
    path,
    bytes,
    hash: hashFileBytes(bytes),
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    birthtimeMs: stats.birthtimeMs,
    nonEmpty: bytes.length > 0,
    validJsonl,
    trailingNewline: bytes.at(-1) === 0x0a,
    entries,
    header: entries.find((entry) => entry.type === "session"),
  };
}

/** Tree index: entries by id, plus the leaf the format appends onto. */
function indexEntries(entries: readonly PiEntry[]): {
  byId: Map<string, PiEntry>;
  leafId: string | null;
} {
  const byId = new Map<string, PiEntry>();
  let leafId: string | null = null;
  for (const entry of entries) {
    if (entry.type === "session" || typeof entry.id !== "string") continue;
    byId.set(entry.id, entry);
    leafId = entry.id;
  }
  return { byId, leafId };
}

/** Root-to-`fromId` path, following `parentId` (the reference's `getBranch`). */
function branchPath(
  byId: Map<string, PiEntry>,
  fromId: string | null | undefined,
): PiEntry[] {
  const path: PiEntry[] = [];
  let current = fromId ? byId.get(fromId) : undefined;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

/**
 * Model and thinking level the branch carries (the reference's
 * `getSessionContextSettings`): a later assistant message wins over an earlier
 * `model_change`.
 */
function contextSettings(path: readonly PiEntry[]): {
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
} {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message?.role === "assistant" &&
        typeof entry.message.provider === "string" && typeof entry.message.model === "string") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return { thinkingLevel, model };
}

function thinkingLevel(value: string): ThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "off";
}

function textContent(content: unknown): { text: string; thinking?: string } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const text: string[] = [];
  const thinking: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (Reflect.get(block, "type") === "text" && typeof Reflect.get(block, "text") === "string") {
      text.push(Reflect.get(block, "text"));
    }
    if (Reflect.get(block, "type") === "thinking" && typeof Reflect.get(block, "thinking") === "string") {
      thinking.push(Reflect.get(block, "thinking"));
    }
  }
  return { text: text.join("\n"), ...(thinking.length ? { thinking: thinking.join("\n") } : {}) };
}

/** One message entry as the transcript renders it (the reference's `uiMessage`). */
function uiMessage(entry: PiEntry): UiMessage | undefined {
  const message = entry.message;
  if (!message) return undefined;
  const content = textContent(message.content);
  const createdAt = typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString();
  if (message.role === "user") {
    return { id: entry.id ?? "", role: "user", content: content.text, createdAt, status: "complete" };
  }
  if (message.role === "assistant") {
    return {
      id: entry.id ?? "",
      role: "assistant",
      content: content.text,
      ...(content.thinking ? { thinking: content.thinking } : {}),
      createdAt,
      status: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "complete",
      ...(typeof message.model === "string" ? { modelId: message.model } : {}),
      ...(typeof message.provider === "string" ? { providerId: message.provider } : {}),
    };
  }
  if (message.role === "toolResult") {
    return {
      id: entry.id ?? "",
      role: "tool",
      content: content.text,
      createdAt,
      status: "complete",
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      toolName: typeof message.toolName === "string" ? message.toolName : undefined,
      toolResult: message.details ?? message.content,
      toolStatus: message.isError ? "error" : "success",
      isError: message.isError === true,
    };
  }
  return undefined;
}

/**
 * Visible transcript of one branch. Compaction and branch-summary entries render
 * as system rows; a `custom_message` only when the writer asked for display.
 */
function visibleMessages(path: readonly PiEntry[]): UiMessage[] {
  const messages: UiMessage[] = [];
  for (const entry of path) {
    if (entry.type === "message") {
      const projected = uiMessage(entry);
      if (projected) messages.push(projected);
    } else if (entry.type === "custom_message" && entry.display) {
      messages.push({
        id: entry.id ?? "",
        role: "system",
        content: textContent(entry.content).text,
        createdAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString(),
        status: "complete",
      });
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      messages.push({
        id: entry.id ?? "",
        role: "system",
        content: typeof entry.summary === "string" ? entry.summary : "",
        createdAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString(),
        status: "complete",
      });
    }
  }
  return messages;
}

function walkJsonl(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files;
}

/** A configured `sessionDir` is flat: pi writes `*.jsonl` directly in it. */
function topLevelJsonl(dir: string): string[] {
  try {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
    }
    return files;
  } catch {
    return [];
  }
}

/** `sessionDir` from one settings file; unreadable settings contribute nothing. */
function rawSessionDir(cwd: string, agentDir: string): string | undefined {
  const path = join(cwd, ".pi", "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { sessionDir?: unknown };
    return typeof parsed?.sessionDir === "string" && parsed.sessionDir.trim()
      ? parsed.sessionDir.trim()
      : undefined;
  } catch (error) {
    console.warn("[native-pi] settings unreadable", path, error);
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function errorWithCode(message: string, errorCode: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode });
}

const FORK_ERROR_CODES = new Set([
  "AGENT_BUSY",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "NATIVE_PI_SESSION_BUSY",
  "NATIVE_PI_SESSION_CHANGED",
  "NATIVE_PI_INVALID_SESSION",
  "NATIVE_PI_LEGACY_FORMAT",
  "NATIVE_PI_MISSING_TRAILING_NEWLINE",
  "NATIVE_PI_MISSING_CWD",
]);

export type NativeSessionStoreOptions = {
  agentDir?: string;
  sessionRoot?: string;
};

/**
 * The legacy pi session store, read and forked from the main process.
 *
 * `list()` is the only method that populates the id → file map; `get()`/`fork()`
 * resolve through it and re-scan once when an unknown id may simply be a session
 * created since the last refresh.
 */
export class NativeSessionStore {
  private readonly agentDir: string;
  private readonly root: string;
  private readonly records = new Map<string, NativeSessionRecord>();
  /** Real directories that already admitted a file; open and fork keep them. */
  private readonly admittedRoots: string[] = [];

  constructor(options: NativeSessionStoreOptions = {}) {
    this.agentDir = resolve(options.agentDir ?? join(defaultAgentDataHome(), "agent"));
    this.root = resolve(options.sessionRoot ?? join(this.agentDir, "sessions"));
  }

  /**
   * Extra session directories from settings: a global absolute `sessionDir`
   * (relative values stay project-scoped) and each local project's own value.
   */
  private configuredSessionDirs(projectPaths: readonly string[]): string[] {
    const dirs: string[] = [];
    const seen = new Set<string>();
    const add = (dir: string | undefined) => {
      if (!dir) return;
      const resolved = resolve(dir);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      dirs.push(resolved);
    };
    const global = rawSessionDir(this.agentDir, this.agentDir);
    if (global && isAbsolute(global)) add(global);
    for (const projectPath of projectPaths) {
      const raw = rawSessionDir(projectPath, this.agentDir);
      if (!raw) continue;
      add(isAbsolute(raw) ? raw : resolve(projectPath, raw));
    }
    return dirs;
  }

  private sessionRoots(): string[] {
    const roots: string[] = [];
    const add = (dir: string) => {
      try {
        const real = realpathSync(dir);
        if (!roots.includes(real)) roots.push(real);
      } catch {
        // A missing directory contributes no files and no containment root.
      }
    };
    add(this.root);
    for (const dir of this.admittedRoots) add(dir);
    return roots;
  }

  async list(options?: { projectPaths?: readonly string[] }): Promise<SessionSummary[]> {
    const projectPaths = normalizeProjectPaths(options?.projectPaths);
    let defaultRoot: string | undefined;
    try {
      defaultRoot = realpathSync(this.root);
    } catch {
      defaultRoot = undefined;
    }
    const extraRoots: string[] = [];
    for (const dir of this.configuredSessionDirs(projectPaths)) {
      try {
        const real = realpathSync(dir);
        if (defaultRoot && (real === defaultRoot || inside(defaultRoot, real))) continue;
        if (!extraRoots.includes(real)) extraRoots.push(real);
      } catch {
        // The configured directory does not exist yet.
      }
    }
    if (!defaultRoot && extraRoots.length === 0) return [];
    const allowed = [...(defaultRoot ? [defaultRoot] : []), ...extraRoots];
    for (const root of allowed) {
      if (!this.admittedRoots.includes(root)) this.admittedRoots.push(root);
    }
    const seenCandidates = new Set<string>();
    const candidates = [
      ...(defaultRoot ? walkJsonl(defaultRoot) : []),
      ...extraRoots.flatMap((dir) => topLevelJsonl(dir)),
    ].filter((candidate) => {
      if (seenCandidates.has(candidate)) return false;
      seenCandidates.add(candidate);
      return true;
    });

    const summaries: SessionSummary[] = [];
    for (const candidate of candidates) {
      try {
        const path = realpathSync(candidate);
        if (!allowed.some((root) => inside(root, path)) || lstatSync(path).isSymbolicLink()) continue;
        const file = readSessionFile(path);
        const header = file.header;
        if (!header || typeof header.id !== "string") continue;
        const cwd = typeof header.cwd === "string" ? header.cwd : "";
        const id = stableId(path, header.id);
        this.records.set(id, { id, path, nativeId: header.id, cwd });
        summaries.push(this.summarize(id, path, header, file, cwd));
      } catch {
        // A file that cannot be read contributes no row; the next refresh retries.
      }
    }

    // One native id is one conversation: a copied file (backup, manual copy)
    // must not become a second session. Newest write wins, ties fall to the
    // smallest path — a total order, so the winner cannot follow directory
    // enumeration. The sidecar's extra "an open runtime keeps its file" rank
    // has no counterpart here: main opens no runtime.
    const byRecency = [...summaries].sort(
      (a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
        (this.records.get(a.id)?.path ?? a.id).localeCompare(this.records.get(b.id)?.path ?? b.id),
    );
    const emitted = new Set<string>();
    const winners: SessionSummary[] = [];
    for (const summary of byRecency) {
      const record = this.records.get(summary.id);
      if (!record) continue;
      if (emitted.has(record.nativeId) || winners.some((winner) => winner.id === summary.id)) continue;
      emitted.add(record.nativeId);
      winners.push(summary);
    }
    // Drop ids the scan no longer sees, so lookups cannot route to a dead file.
    const live = new Set(winners.map((summary) => summary.id));
    for (const id of [...this.records.keys()]) if (!live.has(id)) this.records.delete(id);
    return winners.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async search(
    query: string,
    options?: { projectPaths?: readonly string[] },
  ): Promise<SessionSearchPage> {
    const normalized = query.trim();
    if (!normalized) return { hits: [], nextOffset: null };
    if (normalized.length > MAX_SEARCH_QUERY) throw new Error("query exceeds 500 characters");

    const sessions = await this.list(options);
    const hits: SessionSearchPage["hits"] = [];
    for (const session of sessions) {
      const record = this.records.get(session.id);
      if (!record) continue;
      try {
        const file = readSessionFile(record.path);
        this.validateIdentity(record, file.header);
        const { byId, leafId } = indexEntries(file.entries);
        const messages = visibleMessages(branchPath(byId, leafId)).filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            searchContains(message.content, normalized),
        );
        const metadataMatch =
          searchContains(session.title, normalized) || searchContains(record.cwd, normalized);
        if (!metadataMatch && messages.length === 0) continue;
        hits.push({
          session,
          projectName: null,
          metadataMatch,
          messageCount: messages.length,
          matches: messages
            .sort(
              (left, right) =>
                right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
            )
            .slice(0, 2)
            .map((message) => ({
              messageId: message.id,
              role: message.role as "user" | "assistant",
              createdAt: message.createdAt,
              snippet: searchExcerpt(message.content, normalized),
            })),
        });
      } catch {
        // A file changing under discovery is omitted from this read-only
        // projection; the next refresh retries it from a fresh snapshot.
      }
    }
    hits.sort(
      (left, right) =>
        String(right.session.updatedAt).localeCompare(String(left.session.updatedAt)) ||
        left.session.id.localeCompare(right.session.id),
    );
    return { hits, nextOffset: null };
  }

  async get(
    id: string,
    options: {
      messageBefore?: number;
      messageAround?: string;
      messageLimit?: number;
      contentLimit?: number;
    } = {},
  ): Promise<SessionDetail> {
    const record = await this.resolveRecord(id);
    const file = readSessionFile(record.path);
    this.validateIdentity(record, file.header);
    const { byId, leafId } = indexEntries(file.entries);
    const path = branchPath(byId, leafId);
    const all = visibleMessages(path);
    const limit = Math.max(1, Math.min(options.messageLimit ?? 100, 500));
    const around = options.messageAround?.trim();
    const aroundIndex = around ? all.findIndex((message) => message.id === around) : -1;
    const start = aroundIndex >= 0
      ? Math.max(0, aroundIndex - Math.floor(limit / 2))
      : Math.max(0, Math.min(options.messageBefore ?? all.length, all.length) - limit);
    const before = aroundIndex >= 0
      ? Math.min(all.length, start + limit)
      : Math.min(options.messageBefore ?? all.length, all.length);
    const messages = all.slice(start, before).map((message) => ({
      ...message,
      content:
        options.contentLimit && message.id !== around
          ? message.content.slice(0, options.contentLimit)
          : message.content,
    }));
    const context = contextSettings(path);
    const reason = this.structuralReason(file);
    return {
      id,
      title: this.sessionName(file) ?? record.nativeId,
      messageCount: all.length,
      ...(record.cwd && existsSync(record.cwd) ? { projectPath: record.cwd } : {}),
      ...(context.model ? { providerId: context.model.provider, modelId: context.model.modelId } : {}),
      mode: "agent",
      thinkingLevel: thinkingLevel(context.thinkingLevel),
      permissionMode: "inherit",
      source: "pi-native",
      capabilities: { canPrompt: !reason, canStop: false, canRefresh: true },
      ...(reason ? { readOnlyReason: reason } : {}),
      createdAt: this.createdAt(file),
      updatedAt: path.at(-1)?.timestamp ?? new Date(file.mtimeMs).toISOString(),
      messages,
      messageStart: start,
      ...(aroundIndex >= 0 ? { messageEnd: before, hasMoreAfter: before < all.length } : {}),
      hasMoreBefore: start > 0,
    } as SessionDetail;
  }

  /**
   * Branch a legacy session into a new child JSONL file beside its parent.
   *
   * Branch semantics follow the reference (`createBranchedSession`): the child
   * carries the root-to-anchor path with `label` entries dropped and the path
   * re-chained, a fresh session id, `parentSession` pointing at the source file,
   * the source's saved model/thinking level when the anchored branch lost them,
   * and one `session_info` entry for the title. The parent file is never
   * modified. Publication is a private staging file (`wx`, 0600) plus a
   * same-directory hardlink, so a failed fork never exposes a partial child and
   * never overwrites an existing file.
   */
  async fork(input: {
    id: string;
    title?: string;
    throughMessageId?: string;
  }): Promise<SessionDetail> {
    try {
      return await this.forkInternal(input);
    } catch (error) {
      const code = (error as { errorCode?: string })?.errorCode;
      if (code && FORK_ERROR_CODES.has(code)) throw error;
      // Raw fs messages carry absolute paths; they must not cross the preload
      // boundary. Keep the original for the local log only.
      console.error("[native-pi] fork failed:", error);
      throw errorWithCode("Native Pi fork could not create the child session", "NATIVE_PI_FORK_IO_ERROR");
    }
  }

  private async forkInternal(input: {
    id: string;
    title?: string;
    throughMessageId?: string;
  }): Promise<SessionDetail> {
    const record = await this.resolveRecord(input.id);
    const before = readSessionFile(record.path);
    this.validateIdentity(record, before.header);
    const structural = this.structuralReason(before);
    if (structural) {
      throw errorWithCode(
        `Native Pi session is read-only: ${structural}`,
        `NATIVE_PI_${structural.toUpperCase().replaceAll("-", "_")}`,
      );
    }
    if (!this.leaseAcquirable(record.path)) {
      throw errorWithCode("Native Pi session is already open for writing", "NATIVE_PI_SESSION_BUSY");
    }
    const requestedTitle =
      typeof input.title === "string" ? input.title.trim().replace(/\s+/g, " ").slice(0, 200) : "";
    const throughMessageId = typeof input.throughMessageId === "string" ? input.throughMessageId.trim() : "";

    const { byId, leafId } = indexEntries(before.entries);
    const sourcePath = branchPath(byId, leafId);
    const parentContext = contextSettings(sourcePath);
    const firstUser = sourcePath.find(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    );
    const defaultTitle =
      this.sessionName(before) ||
      (firstUser ? textContent(firstUser.message?.content).text.trim().slice(0, 80) : "") ||
      record.nativeId;

    let anchorId: string;
    if (throughMessageId) {
      const anchor = byId.get(throughMessageId);
      if (!anchor || anchor.type !== "message" || !sourcePath.some((entry) => entry.id === throughMessageId)) {
        throw errorWithCode("Fork anchor is not a message on the active branch", "INVALID_ARGUMENT");
      }
      anchorId = throughMessageId;
    } else {
      if (!leafId) throw errorWithCode("Native Pi session has no branch to fork", "INVALID_ARGUMENT");
      anchorId = leafId;
    }

    const directory = realpathSync(dirname(record.path));
    const roots = this.sessionRoots();
    if (!roots.some((root) => inside(root, directory))) {
      throw errorWithCode("Native Pi session path is outside the allowed root", "PERMISSION_DENIED");
    }

    // Root-to-anchor path, `label` entries dropped and the rest re-chained. A
    // label keeps its slot only by being skipped: the entry after it inherits
    // the parent the label had, so the retained path has no orphan.
    const anchorPath = branchPath(byId, anchorId);
    const childEntries: PiEntry[] = [];
    let pathParentId: string | null = null;
    for (const entry of anchorPath) {
      if (entry.type === "label") continue;
      childEntries.push({ ...entry, parentId: pathParentId });
      pathParentId = typeof entry.id === "string" ? entry.id : pathParentId;
    }
    if (childEntries.length === 0) {
      throw errorWithCode("Native Pi session has no branch to fork", "INVALID_ARGUMENT");
    }
    const childId = randomUUID();
    const timestamp = new Date().toISOString();
    const appendEntry = (entry: PiEntry) => {
      const appended = {
        ...entry,
        id: randomUUID().slice(0, 8),
        parentId: pathParentId,
        timestamp: new Date().toISOString(),
      };
      childEntries.push(appended);
      pathParentId = appended.id;
      return appended;
    };
    // An anchored branch that carries no model entry continues from the source
    // session's own saved model; never a Desktop provider fallback.
    const childContext = contextSettings(childEntries);
    if (!childContext.model && parentContext.model) {
      appendEntry({
        type: "model_change",
        provider: parentContext.model.provider,
        modelId: parentContext.model.modelId,
      });
    }
    if (
      !childEntries.some((entry) => entry.type === "thinking_level_change") &&
      parentContext.thinkingLevel !== "off"
    ) {
      appendEntry({ type: "thinking_level_change", thinkingLevel: parentContext.thinkingLevel });
    }
    appendEntry({ type: "session_info", name: requestedTitle || defaultTitle });

    const header: PiEntry = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: childId,
      timestamp,
      cwd: record.cwd,
      parentSession: record.path,
    };
    const fileEntries = [header, ...childEntries];
    const payload = Buffer.from(
      fileEntries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      "utf8",
    );
    const stamp = timestamp.replace(/[:.]/g, "-");
    const childPath = join(directory, `${stamp}_${childId}.jsonl`);
    const tempPath = join(directory, `.${childId}.${randomUUID()}.tmp`);

    let staged: { path: string; dev: number; ino: number } | undefined;
    let published: { path: string; dev: number; ino: number } | undefined;
    try {
      const fd = openSync(tempPath, "wx", 0o600);
      try {
        const stats = fstatSync(fd);
        staged = { path: tempPath, dev: stats.dev, ino: stats.ino };
        writeFileSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Re-check the source right before publication: bytes that drifted while
      // the child was built fail the fork closed instead of forking a branch
      // the user never saw.
      const after = readSessionFile(record.path);
      if (after.dev !== before.dev || after.ino !== before.ino || after.hash !== before.hash ||
          realpathSync(record.path) !== record.path || realpathSync(dirname(record.path)) !== directory) {
        throw errorWithCode(
          "Native Pi session changed while forking; reload before continuing",
          "NATIVE_PI_SESSION_CHANGED",
        );
      }
      // No-clobber publication: a foreign file at the final path makes `link`
      // fail and is never removed.
      linkSync(tempPath, childPath);
      published = { path: childPath, dev: staged.dev, ino: staged.ino };
      unlinkSync(tempPath);
      staged = undefined;
      const written = readSessionFile(childPath);
      const writtenHeader = written.header;
      if (!writtenHeader || writtenHeader.id !== childId || written.bytes.at(-1) !== 0x0a) {
        throw errorWithCode("Native Pi fork produced an invalid session file", "NATIVE_PI_INVALID_SESSION");
      }
      const resolvedChild = realpathSync(childPath);
      if (resolvedChild !== childPath || !roots.some((root) => inside(root, resolvedChild))) {
        throw errorWithCode("Native Pi fork path is outside the session root", "PERMISSION_DENIED");
      }
      const childRecord: NativeSessionRecord = {
        id: stableId(resolvedChild, childId),
        path: resolvedChild,
        nativeId: childId,
        cwd: typeof writtenHeader.cwd === "string" ? writtenHeader.cwd : record.cwd,
      };
      this.records.set(childRecord.id, childRecord);
      const childTree = indexEntries(written.entries);
      const childBranch = branchPath(childTree.byId, childTree.leafId);
      const childContext = contextSettings(childBranch);
      const childReason = this.structuralReason(written);
      return {
        id: childRecord.id,
        title: requestedTitle || defaultTitle,
        messageCount: childBranch.filter((entry) => entry.type === "message").length,
        ...(childRecord.cwd && existsSync(childRecord.cwd) ? { projectPath: childRecord.cwd } : {}),
        ...(childContext.model
          ? { providerId: childContext.model.provider, modelId: childContext.model.modelId }
          : {}),
        mode: "agent",
        thinkingLevel: thinkingLevel(childContext.thinkingLevel),
        permissionMode: "inherit",
        source: "pi-native",
        capabilities: { canPrompt: !childReason, canStop: false, canRefresh: true },
        ...(childReason ? { readOnlyReason: childReason } : {}),
        createdAt: this.createdAt(written),
        updatedAt: new Date(written.mtimeMs).toISOString(),
        messages: visibleMessages(childBranch),
        messageStart: 0,
        hasMoreBefore: false,
      } as SessionDetail;
    } catch (error) {
      if (staged) {
        try { unlinkSync(staged.path); } catch { /* uncertain ownership keeps bytes on disk */ }
      }
      if (published) {
        try { unlinkSync(published.path); } catch { /* same rule: never delete unproven bytes */ }
      }
      throw error;
    }
  }

  /** Id → file, re-scanning once so a session created since the last list opens. */
  private async resolveRecord(id: string): Promise<NativeSessionRecord> {
    if (!id.startsWith(NATIVE_PI_SESSION_PREFIX)) throw new Error("not a native Pi session");
    const record = this.records.get(id);
    if (!record) {
      await this.list();
      const refreshed = this.records.get(id);
      if (!refreshed) {
        throw errorWithCode("Native Pi session not found; refresh sessions and try again", "NOT_FOUND");
      }
      return this.contained(refreshed);
    }
    return this.contained(record);
  }

  /** Re-resolve a record's path and prove it is still inside an allowed root. */
  private contained(record: NativeSessionRecord): NativeSessionRecord {
    let path: string;
    try {
      path = realpathSync(record.path);
    } catch {
      throw errorWithCode("Native Pi session not found; refresh sessions and try again", "NOT_FOUND");
    }
    if (!this.sessionRoots().some((root) => inside(root, path)) || lstatSync(path).isSymbolicLink()) {
      throw errorWithCode("Native Pi session path is outside the allowed root", "PERMISSION_DENIED");
    }
    return { ...record, path };
  }

  private validateIdentity(record: NativeSessionRecord, header: PiEntry | undefined): void {
    if (!header || header.type !== "session" || header.id !== record.nativeId || header.cwd !== record.cwd) {
      throw errorWithCode(
        "Native Pi session identity changed; refresh before continuing",
        "NATIVE_PI_SESSION_CHANGED",
      );
    }
  }

  /** Structural read-only reasons, in the reference's fixed check order. */
  private structuralReason(file: SessionFile): NativePiReadOnlyReason | undefined {
    if (!file.nonEmpty || !file.validJsonl || !file.header || file.header.type !== "session") {
      return "invalid-session";
    }
    if (file.header.version !== CURRENT_SESSION_VERSION) return "legacy-format";
    if (!file.trailingNewline) return "missing-trailing-newline";
    const cwd = typeof file.header.cwd === "string" ? file.header.cwd : "";
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return "missing-cwd";
    return undefined;
  }

  /**
   * True when no live writer holds this session. The lease file is the same
   * cooperative lock the sidecar takes (`<path>.pi-desktop.lock`): a missing
   * lock is free, a lock from a dead process on this host is reclaimable, and
   * anything else — another host, a live pid, unreadable bytes — is busy.
   */
  private leaseAcquirable(path: string): boolean {
    const lockPath = `${path}.pi-desktop.lock`;
    if (!existsSync(lockPath)) return true;
    try {
      const record = JSON.parse(readFileSync(lockPath, "utf8")) as {
        pid?: number;
        hostname?: string;
        target?: unknown;
      };
      return record?.hostname === hostname() && !isAlive(Number(record?.pid)) && Boolean(record?.target);
    } catch {
      return false;
    }
  }

  /** Latest `session_info` name anywhere in the file (the reference's rule). */
  private sessionName(file: SessionFile): string | undefined {
    for (let index = file.entries.length - 1; index >= 0; index -= 1) {
      const entry = file.entries[index];
      if (entry.type === "session_info") {
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        return name || undefined;
      }
    }
    return undefined;
  }

  private createdAt(file: SessionFile): string {
    const timestamp = file.header?.timestamp;
    if (typeof timestamp === "string") return timestamp;
    return new Date(Number.isFinite(file.birthtimeMs) ? file.birthtimeMs : file.mtimeMs).toISOString();
  }

  /** One listed row, from the same facts `get()` projects. */
  private summarize(
    id: string,
    path: string,
    header: PiEntry,
    file: SessionFile,
    cwd: string,
  ): SessionSummary {
    const { byId, leafId } = indexEntries(file.entries);
    const path_ = branchPath(byId, leafId);
    const firstUser = path_.find((entry) => entry.type === "message" && entry.message?.role === "user");
    const context = contextSettings(path_);
    const createdAt = this.createdAt(file);
    const reason = this.structuralReason(file) ?? (this.leaseAcquirable(path) ? undefined : "busy");
    return {
      id,
      title:
        this.sessionName(file) ??
        (firstUser ? textContent(firstUser.message?.content).text.slice(0, 80) : header.id ?? ""),
      messageCount: path_.filter((entry) => entry.type === "message").length,
      ...(cwd && existsSync(cwd) ? { projectPath: cwd } : {}),
      ...(context.model ? { providerId: context.model.provider, modelId: context.model.modelId } : {}),
      mode: "agent",
      thinkingLevel: thinkingLevel(context.thinkingLevel),
      permissionMode: "inherit",
      source: "pi-native",
      capabilities: { canPrompt: !reason, canStop: false, canRefresh: true },
      ...(reason ? { readOnlyReason: reason } : {}),
      updatedAt: path_.at(-1)?.timestamp ?? createdAt,
      createdAt,
    } as SessionSummary;
  }
}

function defaultAgentDataHome(): string {
  return resolveAgentDataHome({ env: process.env, platform: process.platform, homeDir: homedir() });
}

const stores = new Map<string, NativeSessionStore>();

/** The store for this app's agent data root, shared by every caller. */
export function nativeSessionStore(options: NativeSessionStoreOptions = {}): NativeSessionStore {
  const agentDir = resolve(options.agentDir ?? join(defaultAgentDataHome(), "agent"));
  const sessionRoot = resolve(options.sessionRoot ?? join(agentDir, "sessions"));
  const key = `${agentDir}\0${sessionRoot}`;
  let store = stores.get(key);
  if (!store) {
    store = new NativeSessionStore({ agentDir, sessionRoot });
    stores.set(key, store);
  }
  return store;
}

/**
 * A `sidecar.call`-shaped client for exactly these four methods.
 *
 * Main's session list, global search, open and fork call one method name
 * whichever runtime answered the agent; this object keeps that call shape while
 * the four legacy-store surfaces are answered in-process, so a kernel build does
 * not report the user's existing sessions as an unsupported surface.
 */
export function nativeSessionClient(store: NativeSessionStore = nativeSessionStore()): {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
} {
  const call = async (method: string, params?: unknown): Promise<unknown> => {
    const input = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "native.session.list":
        return { sessions: await store.list({ projectPaths: input.projectPaths as string[] | undefined }) };
      case "native.session.search":
        return store.search(String(input.query ?? ""), {
          projectPaths: input.projectPaths as string[] | undefined,
        });
      case "native.session.get":
        return {
          session: await store.get(String(input.id ?? ""), {
            ...(typeof input.messageBefore === "number" ? { messageBefore: input.messageBefore } : {}),
            ...(typeof input.messageAround === "string" ? { messageAround: input.messageAround } : {}),
            ...(typeof input.messageLimit === "number" ? { messageLimit: input.messageLimit } : {}),
            ...(typeof input.contentLimit === "number" ? { contentLimit: input.contentLimit } : {}),
          }),
        };
      case "native.session.fork":
        return {
          session: await store.fork({
            id: String(input.id ?? ""),
            ...(typeof input.title === "string" ? { title: input.title } : {}),
            ...(typeof input.throughMessageId === "string" ? { throughMessageId: input.throughMessageId } : {}),
          }),
        };
      default:
        throw errorWithCode(`${method} is not a legacy pi session method`, "UNSUPPORTED");
    }
  };
  return { call: call as <T = unknown>(method: string, params?: unknown) => Promise<T> };
}
