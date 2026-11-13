// Uploads and folder syncs into Drive, built to run for days over folders with millions of files.
//
// How it stays fast and light:
//  - The local folder is read one directory at a time (lib/localfs.ts), never as one big list.
//  - Each local directory is compared with its Drive folder (one Drive listing per folder): files
//    already there (same name and size) are skipped, new ones are queued, files whose size changed
//    are queued as a new version of the same Drive file. Nothing in Drive is ever deleted.
//  - The upload queue is bounded: reading the folder waits while 300 files are waiting to go.
//  - Small files (≤ 5 MB) go in one request; big ones as resumable uploads whose sessions are kept
//    in IndexedDB, so a stopped file goes on from the last byte Drive has.
//  - Drive limits how fast one account may write. When it says "slow down", every worker waits
//    (backing off up to a minute) and fewer files go at once; when things go well it speeds up again.
//  - Progress lives in plain counters; the page is told about them a few times a second.
//  - A folder whose files are all in Drive is written down (IndexedDB). After a reload or a crash the
//    same job resumes (the folder picker's handle is saved with it) and skips those folders without
//    asking Drive again.
import { sendFile } from './upload.ts';
import { FOLDER_MIME, bytesOf, isRateLimit, isTransient, type DFile, type DriveApi } from './gdrive.ts';
import { sizes } from './sizes.svelte.ts';
import { fromHandle, allowRead, type LocalDir, type LocalFile } from './localfs.ts';

const SMALL = 5 * 1024 * 1024;
const QUEUE_MAX = 300;
const COMPARE_WORKERS = 4;
const MAX_PARALLEL = 8;
const SESSION_MS = 6 * 24 * 3600 * 1000;

// ── IndexedDB: jobs, finished folders, resumable sessions ──────────────────

let dbp: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('driveshare-transfer', 1);
    r.onupgradeneeded = () => { for (const s of ['jobs', 'done', 'sessions']) r.result.createObjectStore(s); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error); };
  });
  return dbp;
}
async function kget<T>(store: string, key: string): Promise<T | undefined> {
  const db = await idb().catch(() => null);
  if (!db) return undefined;
  return new Promise((res) => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result as T); q.onerror = () => res(undefined); });
}
async function kput(store: string, key: string, value: unknown): Promise<void> {
  const db = await idb().catch(() => null);
  if (!db) return;
  return new Promise((res) => { const t = db.transaction(store, 'readwrite'); if (value === undefined) t.objectStore(store).delete(key); else t.objectStore(store).put(value, key); t.oncomplete = () => res(); t.onerror = () => res(); });
}
async function kall<T>(store: string): Promise<T[]> {
  const db = await idb().catch(() => null);
  if (!db) return [];
  return new Promise((res) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result as T[]); q.onerror = () => res([]); });
}
async function kdropPrefix(store: string, prefix: string): Promise<void> {
  const db = await idb().catch(() => null);
  if (!db) return;
  return new Promise((res) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
    t.oncomplete = () => res(); t.onerror = () => res();
  });
}

// ── what the page sees ───────────────────────────────────────────────────

export interface Stats {
  phase: 'comparing' | 'sending' | 'paused' | 'done' | 'stopped' | 'failed';
  folders: number;
  foldersSkipped: number;
  files: number;
  bytes: number;
  same: number;
  missing: number;
  changed: number;
  uploaded: number;
  failed: number;
  toSendBytes: number;
  sentBytes: number;
  parallel: number;
  waitUntil: number;
  startedAt: number;
}

export interface JobInfo {
  id: string;
  kind: 'sync' | 'upload';
  targetId: string;
  targetName: string;
  localName: string;
  createdAt: number;
  updatedAt: number;
  stats?: Stats;
  handle?: FileSystemDirectoryHandle;
}

export interface View extends Stats {
  job: JobInfo;
  speed: number;
  current: { path: string; size: number; sent: number }[];
  failures: { path: string; error: string }[];
  recent: string[];
  queued: number;
  walking: boolean;
}

// ── internals ──────────────────────────────────────────────────────────

interface Dir {
  path: string;
  name: string;
  local: LocalDir | null;
  parent: Dir | null;
  /** Drive folder id, null when it does not exist (yet), or a promise while it is being made. */
  driveId: string | null | Promise<string>;
  waiting: number;
  listed: boolean;
  bad: boolean;
  doneMarked: boolean;
}

interface Task { dir: Dir; file: File; name: string; replace?: string; tries: number; notBefore: number }

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const pathOf = (d: Dir, name: string) => (d.path ? `${d.path}/${name}` : name);

class Run {
  stats: Stats;
  private stack: Dir[] = [];
  private queue: Task[] = [];
  private spaceWaiters: (() => void)[] = [];
  private workWaiters: (() => void)[] = [];
  private walkersBusy = 0;
  private active = new Map<Task, { sent: number }>();
  private parallel = 4;
  private okStreak = 0;
  private backoff = 0;
  stopped = false;
  /** Finished (or stopped): every loop ends. */
  ended = false;
  paused = false;
  failures: { path: string; error: string; task?: Task }[] = [];
  recent: string[] = [];
  root!: Dir;
  private resolveEnd!: () => void;
  readonly finished = new Promise<void>((r) => (this.resolveEnd = r));
  private finish() { this.ended = true; this.wakeSenders(); for (const w of this.spaceWaiters.splice(0)) w(); this.resolveEnd(); }

  constructor(readonly drive: DriveApi, readonly job: JobInfo, private readonly local: LocalDir) {
    // Counters are for this run; folders finished by earlier runs show as "done before".
    this.stats = { phase: 'comparing', folders: 0, foldersSkipped: 0, files: 0, bytes: 0, same: 0, missing: 0, changed: 0, uploaded: 0, failed: 0, toSendBytes: 0, sentBytes: 0, parallel: 4, waitUntil: 0, startedAt: Date.now() };
  }

  get walking() { return this.stack.length > 0 || this.walkersBusy > 0; }
  get queued() { return this.queue.length; }
  current() { return [...this.active].map(([t, p]) => ({ path: pathOf(t.dir, t.name), size: t.file.size, sent: p.sent })); }

  async start(): Promise<void> {
    // The root: for a sync it is the target folder itself; for an upload a folder named like the
    // local one inside the target (found, or made when the first file needs it).
    if (this.job.kind === 'sync' || !this.local.name) {
      this.root = this.dirNode('', '', this.local, null, this.job.targetId);
    } else {
      const kids = await this.drive.children(this.job.targetId);
      const have = kids.find((f) => f.mimeType === FOLDER_MIME && f.name === this.local.name);
      const holder = this.dirNode('', '', null, null, this.job.targetId);
      holder.listed = true;
      this.root = this.dirNode(this.local.name, this.local.name, this.local, holder, have?.id ?? null);
      holder.waiting = 1;
    }
    this.stack.push(this.root);
    for (let i = 0; i < COMPARE_WORKERS; i++) void this.walker();
    for (let i = 0; i < MAX_PARALLEL; i++) void this.sender(i);
    await this.finished;
  }

  private dirNode(path: string, name: string, local: LocalDir | null, parent: Dir | null, driveId: string | null): Dir {
    return { path, name, local, parent, driveId, waiting: 0, listed: false, bad: false, doneMarked: false };
  }

  // ── compare ──

  private async walker(): Promise<void> {
    while (!this.ended) {
      const d = this.stack.pop();
      if (!d) {
        if (this.walkersBusy === 0) { this.wakeSenders(); return; }
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      this.walkersBusy++;
      try { await this.compare(d); } catch (e) {
        d.bad = true;
        this.fail(pathOf(d, '') || d.name || '(folder)', `Could not read this folder: ${(e as Error).message}`);
      } finally {
        d.listed = true;
        this.walkersBusy--;
        this.settle(d);
      }
    }
  }

  private async compare(d: Dir): Promise<void> {
    if (await kget('done', `${this.job.id}|${d.path}`)) { this.stats.foldersSkipped++; return; }
    this.stats.folders++;
    // What Drive has in this folder (nothing to ask when the folder is not there yet).
    const id = d.driveId instanceof Promise ? await d.driveId : d.driveId;
    const have = new Map<string, DFile[]>();
    if (id) for (const f of await this.listAll(id)) have.set(f.name, [...(have.get(f.name) ?? []), f]);
    let batch: LocalFile[] = [];
    const flush = async () => {
      const files = await Promise.all(batch.map((e) => e.file().catch(() => null)));
      for (let k = 0; k < batch.length; k++) {
        const file = files[k];
        if (!file) { this.fail(pathOf(d, batch[k]!.name), 'Could not read the file'); continue; }
        this.stats.files++;
        this.stats.bytes += file.size;
        const kids = (have.get(file.name) ?? []).filter((f) => f.mimeType !== FOLDER_MIME);
        if (kids.some((f) => bytesOf(f) === file.size || f.mimeType.startsWith('application/vnd.google-apps'))) { this.stats.same++; continue; }
        if (kids.length) this.stats.changed++; else this.stats.missing++;
        this.stats.toSendBytes += file.size;
        await this.enqueue({ dir: d, file, name: file.name, ...(kids[0] ? { replace: kids[0].id } : {}), tries: 0, notBefore: 0 });
      }
      batch = [];
    };
    for await (const e of d.local!.entries()) {
      if (this.stopped) return;
      if (e.kind === 'file') {
        batch.push(e);
        if (batch.length >= 200) await flush();
      } else {
        const existing = have.get(e.name)?.find((f) => f.mimeType === FOLDER_MIME);
        const child = this.dirNode(pathOf(d, e.name), e.name, e, d, existing?.id ?? (id ? null : null));
        d.waiting++;
        this.stack.push(child);
      }
    }
    await flush();
  }

  private async listAll(folderId: string): Promise<DFile[]> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.drive.children(folderId); } catch (e) {
        if (!isTransient(e) || attempt > 6) throw e;
        await this.slowDown(e);
      }
    }
  }

  private async enqueue(t: Task): Promise<void> {
    t.dir.waiting++;
    while (this.queue.length >= QUEUE_MAX && !this.ended) await new Promise<void>((r) => this.spaceWaiters.push(r));
    this.queue.push(t);
    this.wakeSenders();
  }

  private wakeSenders() { for (const w of this.workWaiters.splice(0)) w(); }

  // ── send ──

  private async sender(slot: number): Promise<void> {
    while (!this.ended) {
      if (this.paused || slot >= this.parallel || Date.now() < this.stats.waitUntil) { await new Promise((r) => setTimeout(r, 500)); continue; }
      const now = Date.now();
      const k = this.queue.findIndex((t) => t.notBefore <= now);
      if (k < 0) {
        if (!this.walking && !this.queue.length) return this.maybeFinish();
        await new Promise<void>((r) => { this.workWaiters.push(r); setTimeout(r, 1000); });
        continue;
      }
      const t = this.queue.splice(k, 1)[0]!;
      this.spaceWaiters.shift()?.();
      await this.send(t);
    }
  }

  private async send(t: Task): Promise<void> {
    const progress = { sent: 0 };
    this.active.set(t, progress);
    const controller = new AbortController();
    const stopCheck = setInterval(() => { if (this.stopped || this.paused) controller.abort(); }, 500);
    try {
      const folder = await this.folderOf(t.dir);
      const meta = { name: t.name, parents: [folder], ...(t.file.type ? { mimeType: t.file.type } : {}), ...(t.file.lastModified ? { modifiedTime: new Date(t.file.lastModified).toISOString() } : {}) };
      let made: { id?: string };
      if (t.file.size <= SMALL) {
        made = await this.drive.uploadSmall(meta, t.file, t.replace, controller.signal);
        progress.sent = t.file.size;
      } else {
        made = await this.sendLarge(t, folder, meta, progress, controller.signal);
      }
      this.stats.uploaded++;
      this.stats.sentBytes += t.file.size;
      this.recent = [pathOf(t.dir, t.name), ...this.recent].slice(0, 6);
      if (made.id) sizes.local({ id: made.id, name: t.name, mimeType: t.file.type || 'application/octet-stream', size: String(t.file.size), parents: [folder] });
      this.okStreak++;
      if (this.okStreak >= 25) { if (this.parallel < MAX_PARALLEL) this.parallel++; this.okStreak = 0; this.backoff = Math.max(0, this.backoff - 1); }
      this.stats.parallel = this.parallel;
      this.done(t);
    } catch (e) {
      if (t.file.size > SMALL) this.stats.sentBytes -= progress.sent;
      if ((e as Error).name === 'AbortError' && (this.stopped || this.paused)) { this.queue.unshift(t); return; }
      if (isRateLimit(e)) { await this.slowDown(e); t.notBefore = 0; this.queue.unshift(t); return; }
      if (isTransient(e) && t.tries < 8) {
        t.tries++;
        t.notBefore = Date.now() + Math.min(120_000, 2000 * 2 ** t.tries);
        this.queue.push(t);
        return;
      }
      this.fail(pathOf(t.dir, t.name), (e as Error).message, t);
      t.dir.bad = true;
      this.done(t);
    } finally {
      clearInterval(stopCheck);
      this.active.delete(t);
    }
  }

  private async sendLarge(t: Task, folder: string, meta: { name: string; parents: string[]; mimeType?: string; modifiedTime?: string }, progress: { sent: number }, signal: AbortSignal): Promise<{ id?: string }> {
    const key = `${folder}/${t.name}:${t.file.size}:${t.file.lastModified}`;
    const saved = await kget<{ url: string; at: number }>('sessions', key);
    let url = saved && Date.now() - saved.at < SESSION_MS ? saved.url : '';
    const resumed = !!url;
    if (!url) {
      url = await this.drive.startUpload(meta, t.file.size, t.replace);
      await kput('sessions', key, { url, at: Date.now() });
    }
    const before = progress.sent;
    let r: { id?: string };
    try {
      r = await sendFile(url, t.file, (n) => { this.stats.sentBytes += n - progress.sent; progress.sent = n; }, signal, resumed);
    } catch (e) {
      if (!resumed || !/expired|answered 4/.test((e as Error).message)) throw e;
      this.stats.sentBytes -= progress.sent - before;
      progress.sent = 0;
      url = await this.drive.startUpload(meta, t.file.size, t.replace);
      await kput('sessions', key, { url, at: Date.now() });
      r = await sendFile(url, t.file, (n) => { this.stats.sentBytes += n - progress.sent; progress.sent = n; }, signal);
    }
    // Counted again by the caller for the whole file.
    this.stats.sentBytes -= progress.sent;
    await kput('sessions', key, undefined);
    return r;
  }

  /** The Drive folder for a local directory, made the first time a file needs it. */
  private folderOf(d: Dir): Promise<string> {
    if (typeof d.driveId === 'string') return Promise.resolve(d.driveId);
    if (d.driveId instanceof Promise) return d.driveId;
    const p = (async () => {
      const parent = await this.folderOf(d.parent!);
      // Someone (another tab, an earlier run) may have made it meanwhile.
      const found = (await this.listAll(parent)).find((f) => f.mimeType === FOLDER_MIME && f.name === d.name);
      const id = found?.id ?? (await this.drive.createFolder(d.name, parent)).id;
      if (!found) sizes.local({ id, name: d.name, mimeType: FOLDER_MIME, parents: [parent] });
      d.driveId = id;
      return id;
    })();
    d.driveId = p;
    p.catch(() => { d.driveId = null; });
    return p;
  }

  /**
   * Drive said "slow down". Several files in flight usually hear it at once: count that as one
   * event. The pause grows when it keeps happening (1 s, 2 s, 4 s … up to a minute) and shrinks
   * again after a quiet half minute; one fewer file goes at a time each time.
   */
  private lastLimit = 0;
  private async slowDown(e: unknown): Promise<void> {
    void e;
    const now = Date.now();
    if (now < this.stats.waitUntil) { await new Promise((r) => setTimeout(r, this.stats.waitUntil - now)); return; }
    if (now - this.lastLimit > 30_000) this.backoff = 0;
    this.lastLimit = now;
    this.okStreak = 0;
    this.parallel = Math.max(1, this.parallel - 1);
    this.stats.parallel = this.parallel;
    const wait = Math.min(60_000, 1000 * 2 ** this.backoff) + Math.random() * 500;
    this.backoff = Math.min(6, this.backoff + 1);
    this.stats.waitUntil = now + wait;
    await new Promise((r) => setTimeout(r, wait));
  }

  // ── bookkeeping ──

  private fail(path: string, error: string, task?: Task) {
    this.stats.failed++;
    if (this.failures.length < 500) this.failures.push({ path, error, ...(task ? { task } : {}) });
  }

  private done(t: Task) {
    t.dir.waiting--;
    this.settle(t.dir);
  }

  /** A folder whose files and subfolders are all handled is written down, then its parent is told. */
  private settle(d: Dir) {
    if (!d.listed || d.waiting > 0 || d.doneMarked) return;
    d.doneMarked = true;
    if (!d.bad) void kput('done', `${this.job.id}|${d.path}`, 1);
    const p = d.parent;
    if (p) {
      if (d.bad) p.bad = true;
      p.waiting--;
      this.settle(p);
    } else {
      this.maybeFinish();
    }
  }

  private maybeFinish() {
    if (!this.ended && this.root?.doneMarked && !this.queue.length && !this.active.size) {
      this.stats.phase = 'done';
      this.finish();
    }
  }

  stop() { this.stopped = true; this.stats.phase = 'stopped'; this.finish(); }

  retryFailed() {
    const again = this.failures.filter((f) => f.task);
    this.failures = this.failures.filter((f) => !f.task);
    this.stats.failed -= again.length;
    for (const f of again) {
      const t = f.task!;
      t.tries = 0; t.notBefore = 0;
      t.dir.waiting++;
      this.queue.push(t);
    }
    this.wakeSenders();
  }
}

// ── the public side ─────────────────────────────────────────────────────

class Transfers {
  view = $state.raw<View | null>(null);
  /** An unfinished job from an earlier visit (resume it with one click). */
  saved = $state.raw<JobInfo | null>(null);
  error = $state('');
  onFinished: (() => void) | null = null;

  private run: Run | null = null;
  private waiting: { drive: DriveApi; job: JobInfo; local: LocalDir }[] = [];
  private tick: ReturnType<typeof setInterval> | null = null;
  private lastSent = 0;
  private lastAt = 0;
  private speed = 0;
  private lastSave = 0;
  private lock: { release(): Promise<void> } | null = null;

  constructor() {
    void kall<JobInfo>('jobs').then((jobs) => { this.saved = jobs.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null; });
    addEventListener('beforeunload', (e) => { if (this.run && !this.run.stopped && this.view?.phase !== 'done') e.preventDefault(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.run) void this.keepAwake(); });
  }

  get busy() { return !!this.run; }

  /** Sync `local`'s contents into the Drive folder `targetId`. */
  sync(drive: DriveApi, targetId: string, targetName: string, local: LocalDir, handle?: FileSystemDirectoryHandle) {
    this.enqueue(drive, this.jobFor('sync', targetId, targetName, local.name, handle), local);
  }

  /**
   * The same folder into the same place as the unfinished job carries that job on (its finished
   * folders are skipped), whether it comes from Resume, the picker or a drop.
   */
  private jobFor(kind: 'sync' | 'upload', targetId: string, targetName: string, localName: string, handle?: FileSystemDirectoryHandle): JobInfo {
    const s = this.saved;
    if (s && s.kind === kind && s.targetId === targetId && s.localName === localName) {
      this.saved = null;
      return { ...s, targetName, updatedAt: Date.now(), ...(handle ? { handle } : {}) };
    }
    return { id: newId(), kind, targetId, targetName, localName, createdAt: Date.now(), updatedAt: Date.now(), ...(handle ? { handle } : {}) };
  }

  /** Upload `local` (as a folder of the same name, or loose files when it has no name) into `targetId`. */
  upload(drive: DriveApi, targetId: string, targetName: string, local: LocalDir, handle?: FileSystemDirectoryHandle) {
    this.enqueue(drive, this.jobFor('upload', targetId, targetName, local.name || 'files', handle), local);
  }

  /** Carry on the saved job (needs a click: the browser asks again for read access to the folder). */
  async resumeSaved(drive: DriveApi): Promise<boolean> {
    const job = this.saved;
    if (!job?.handle) return false;
    if (!(await allowRead(job.handle))) { this.error = 'The browser did not give access to the folder.'; return false; }
    this.saved = null;
    this.enqueue(drive, job, fromHandle(job.handle));
    return true;
  }

  async forgetSaved(): Promise<void> {
    const j = this.saved;
    this.saved = null;
    if (j) { await kput('jobs', j.id, undefined); await kdropPrefix('done', `${j.id}|`); }
  }

  private enqueue(drive: DriveApi, job: JobInfo, local: LocalDir) {
    if (this.saved?.id === job.id) this.saved = null;
    this.waiting.push({ drive, job, local });
    if (!this.run) void this.next();
  }

  private async next(): Promise<void> {
    const w = this.waiting.shift();
    if (!w) return;
    const run = new Run(w.drive, w.job, w.local);
    this.run = run;
    this.error = '';
    await kput('jobs', w.job.id, { ...w.job, updatedAt: Date.now() });
    this.lastSent = 0; this.lastAt = 0; this.speed = 0;
    this.tick ??= setInterval(() => this.publish(), 400);
    void this.keepAwake();
    try {
      await run.start();
    } catch (e) {
      run.stats.phase = 'failed';
      this.error = (e as Error).message;
    }
    this.publish();
    if (run.stats.phase === 'done' && !run.failures.length) {
      await kput('jobs', w.job.id, undefined);
      await kdropPrefix('done', `${w.job.id}|`);
    } else {
      await kput('jobs', w.job.id, { ...w.job, updatedAt: Date.now(), stats: { ...run.stats } });
    }
    this.run = null;
    if (this.tick && !this.waiting.length) { clearInterval(this.tick); this.tick = null; }
    void this.lock?.release().catch(() => {});
    this.lock = null;
    this.onFinished?.();
    void this.next();
  }

  private publish() {
    const r = this.run;
    if (!r) return;
    const now = performance.now();
    if (this.lastAt) {
      const v = Math.max(0, (r.stats.sentBytes - this.lastSent) / ((now - this.lastAt) / 1000));
      this.speed = this.speed ? this.speed * 0.85 + v * 0.15 : v;
    }
    this.lastSent = r.stats.sentBytes;
    this.lastAt = now;
    if (r.stats.phase !== 'done' && r.stats.phase !== 'failed' && r.stats.phase !== 'stopped') r.stats.phase = r.stopped ? 'stopped' : r.paused ? 'paused' : r.walking ? 'comparing' : 'sending';
    this.view = {
      ...r.stats, job: r.job, speed: this.speed, current: r.current(), queued: r.queued, walking: r.walking,
      failures: r.failures.slice(-100).map(({ path, error }) => ({ path, error })), recent: [...r.recent],
    };
    if (Date.now() - this.lastSave > 10_000) {
      this.lastSave = Date.now();
      void kput('jobs', r.job.id, { ...r.job, updatedAt: Date.now(), stats: { ...r.stats } });
    }
  }

  private async keepAwake() {
    try {
      if (!this.lock) this.lock = await (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
    } catch { /* not allowed (tab hidden, or no support) */ }
  }

  pause() { if (this.run) { this.run.paused = true; this.publish(); } }
  resume() { if (this.run) { this.run.paused = false; this.publish(); } }
  retryFailed() { this.run?.retryFailed(); }

  /** Stop now. The job stays saved: syncing the same folder again (or Resume) carries on. */
  stop() {
    const r = this.run;
    if (!r) return;
    this.waiting = [];
    r.stop();
  }

  close() { if (!this.run) this.view = null; }
}

export const transfers = new Transfers();
