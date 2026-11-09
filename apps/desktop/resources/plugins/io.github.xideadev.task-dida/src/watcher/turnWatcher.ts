import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { AlertType } from '../audio/player';

export interface TurnEvent {
  id?: string;
  kind: 'task.completed' | 'task.failed';
  turnId: string;
  sessionId: string;
  sessionTitle: string;
  createdAt: number;
}

export class TurnWatcher {
  private dbPath: string;
  private lastProcessedTimestamp: number;
  private isChecking = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private onAlertCallback: (type: AlertType, event: TurnEvent) => void;
  private processedIds = new Set<string>();
  private maxCachedIds = 200;

  constructor(onAlert: (type: AlertType, event: TurnEvent) => void) {
    this.onAlertCallback = onAlert;
    const homeDir = os.homedir();
    // Resolve the host data directory the same way the desktop app does:
    // PI_DESKTOP_DATA_DIR wins, then <home>/.piworkspace, then the legacy <home>/.pi-desktop profile.
    const candidates = [process.env.PI_DESKTOP_DATA_DIR, path.join(homeDir, '.piworkspace'), path.join(homeDir, '.pi-desktop')]
      .map((dir) => (dir || '').trim())
      .filter((dir) => dir.length > 0)
      .map((dir) => path.join(dir, 'pi.sqlite'))
      .filter((candidate) => {
        try {
          return fs.existsSync(candidate);
        } catch {
          return false;
        }
      });
    // Nothing found yet: keep the first candidate so the poller can pick it up once the host creates it.
    this.dbPath = candidates[0] || path.join(process.env.PI_DESKTOP_DATA_DIR || path.join(homeDir, '.piworkspace'), 'pi.sqlite');
    // Start from current time to prevent historical alerts upon startup
    this.lastProcessedTimestamp = Date.now();
  }

  public start() {
    if (!fs.existsSync(this.dbPath)) {
      // A missing file here is expected on first launch: the host creates pi.sqlite after
      // plugin activation, and the 500ms poller below picks it up as soon as it appears.
      const searched = [process.env.PI_DESKTOP_DATA_DIR, path.join(os.homedir(), '.piworkspace'), path.join(os.homedir(), '.pi-desktop')]
        .filter((dir) => dir && dir.trim().length > 0)
        .map((dir) => path.join(dir, 'pi.sqlite'));
      console.info('[SoundAlert] pi.sqlite not created yet, polling:', searched.join(' | '));
    }


    // 1. Directory file watcher to capture immediate WAL / DB flushes
    const homeDir = os.homedir();
    const dir = path.dirname(this.dbPath);
    try {
      // Watch the first directory that actually exists: the chosen data dir may not be
      // created yet at plugin-activation time, and an ENOENT here would disable live updates.
      const watchCandidates = [dir, path.join(homeDir, '.piworkspace'), path.join(homeDir, '.pi-desktop')];
      const watchDir = watchCandidates.find((candidate) => fs.existsSync(candidate)) || dir;
      this.fileWatcher = fs.watch(watchDir, (eventType, filename) => {
        if (filename && (filename.includes('pi.sqlite') || filename.includes('pi.sqlite-wal'))) {
          this.checkNewNotifications();
        }
      });
    } catch (err) {
      console.warn('[SoundAlert] FS watcher unavailable, fallbacking to interval polling:', err);
    }

    // 2. Continuous fallback interval polling (500ms) for high reliability
    this.pollInterval = setInterval(() => {
      this.checkNewNotifications();
    }, 500);

    // Initial check
    this.checkNewNotifications();
  }

  public stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  private checkNewNotifications() {
    if (this.isChecking || !fs.existsSync(this.dbPath)) return;
    this.isChecking = true;

    const safeTs = Number.isFinite(this.lastProcessedTimestamp)
      ? Math.floor(this.lastProcessedTimestamp)
      : Date.now();

    // Strategy 1 (Preferred): Node 22+ native node:sqlite DatabaseSync (cross-platform, zero child-process overhead)
    try {
      // Dynamic require to prevent errors on environments without node:sqlite
      const sqliteModule = require('node:sqlite');
      if (sqliteModule && typeof sqliteModule.DatabaseSync === 'function') {
        const db = new sqliteModule.DatabaseSync(this.dbPath, { readOnly: true });
        const stmt = db.prepare(
          `SELECT id, kind, session_id, session_title, turn_id, created_at FROM notifications WHERE created_at >= ? ORDER BY created_at ASC;`
        );
        const rows = stmt.all(safeTs) as Array<{
          id: string;
          kind: string;
          session_id: string;
          session_title: string;
          turn_id: string;
          created_at: number;
        }>;
        db.close();

        this.processRows(rows.map(r => ({
          id: r.id,
          kind: r.kind as any,
          sessionId: r.session_id,
          sessionTitle: r.session_title,
          turnId: r.turn_id,
          createdAt: Number(r.created_at)
        })));
        this.isChecking = false;
        return;
      }
    } catch (nodeSqliteErr) {
      // Fallback to Strategy 2 if node:sqlite throws or is not available
    }

    // Strategy 2: sqlite3 CLI with native -json formatting (avoids all pipe/delimiter collision issues)
    const query = `SELECT id, kind, session_id, session_title, turn_id, created_at FROM notifications WHERE created_at >= ${safeTs} ORDER BY created_at ASC;`;

    execFile('sqlite3', ['-json', this.dbPath, query], { timeout: 1500 }, (err, stdout) => {
      this.isChecking = false;
      if (err || !stdout || !stdout.trim()) {
        return;
      }

      try {
        const rows = JSON.parse(stdout.trim());
        if (Array.isArray(rows)) {
          this.processRows(rows.map((r: any) => ({
            id: r.id,
            kind: r.kind,
            sessionId: r.session_id,
            sessionTitle: r.session_title,
            turnId: r.turn_id,
            createdAt: Number(r.created_at)
          })));
        }
      } catch (parseErr) {
        console.error('[SoundAlert] Failed to parse notifications json:', parseErr);
      }
    });
  }

  private processRows(rows: TurnEvent[]) {
    for (const event of rows) {
      if (!event.id || this.processedIds.has(event.id)) {
        continue;
      }

      // Add to processed ID set with LRU-style bounded eviction
      this.processedIds.add(event.id);
      if (this.processedIds.size > this.maxCachedIds) {
        const first = this.processedIds.values().next().value;
        if (first) this.processedIds.delete(first);
      }

      if (event.createdAt >= this.lastProcessedTimestamp) {
        this.lastProcessedTimestamp = event.createdAt;
      }

      const alertType: AlertType = event.kind === 'task.failed' ? 'error' : 'complete';
      this.onAlertCallback(alertType, event);
    }
  }
}
