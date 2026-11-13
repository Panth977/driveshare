// Folder and file uploads into the owner's Drive, straight from the browser to Google.
//
// Stopping half way is normal (a closed tab, a lost connection, a sleeping laptop). Drop the same
// folder again and it carries on: files already in Drive (same name and size, same place) are
// skipped, and a file that was half sent goes on from the last byte Drive has, using the resumable
// session saved in IndexedDB (Drive keeps those for a week).
import { sendFile } from './upload.ts';
import { FOLDER_MIME, bytesOf, type DFile, type DriveApi } from './gdrive.ts';
import { sizes } from './sizes.svelte.ts';

export interface Job {
  key: string;
  name: string;
  /** Folder path inside what was dropped ('' for a loose file). */
  dir: string;
  size: number;
  sent: number;
  state: 'waiting' | 'checking' | 'sending' | 'done' | 'skipped' | 'failed' | 'cancelled';
  resumed?: boolean;
  /** Bytes Drive already had when a half-sent file carried on. */
  resumedFrom?: number;
  error?: string;
  file: File;
  parent: string;
  abort?: AbortController;
  /** Sync found this file in Drive with a different size: upload the new contents into it. */
  replace?: string;
}

/** A folder sync: the local folder's contents compared with a Drive folder, then what differs uploaded. */
export interface SyncRun {
  local: string;
  target: string;
  targetId: string;
  phase: 'comparing' | 'uploading' | 'done' | 'failed';
  files: number;
  bytes: number;
  compared: number;
  same: number;
  missing: number;
  changed: number;
  toSend: number;
  error?: string;
}

export interface Picked { file: File; path: string }

const DB = 'driveshare-uploads';
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sessions');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function sessionGet(key: string): Promise<{ url: string; at: number } | undefined> {
  const db = await idb();
  return new Promise((resolve) => {
    const q = db.transaction('sessions').objectStore('sessions').get(key);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => resolve(undefined);
  });
}
async function sessionSet(key: string, v: { url: string; at: number } | null): Promise<void> {
  const db = await idb();
  return new Promise((resolve) => {
    const t = db.transaction('sessions', 'readwrite');
    if (v) t.objectStore('sessions').put(v, key); else t.objectStore('sessions').delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => resolve();
  });
}
const SESSION_MS = 6 * 24 * 3600 * 1000;

/** Everything in a drop: files and whole folders (with their paths), via the entries API. */
export async function readDrop(dt: DataTransfer): Promise<Picked[]> {
  const out: Picked[] = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c, `${prefix}${e.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

export const fromInput = (files: FileList | null): Picked[] => [...(files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));

const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/i;

class Uploader {
  jobs = $state<Job[]>([]);
  open = $state(false);
  paused = $state(false);
  /** Bytes per second, smoothed. */
  speed = $state(0);
  error = $state('');
  private drive: DriveApi | null = null;
  private running = 0;
  private readonly PARALLEL = 3;
  /** folderId → its children (by name), so each folder is listed once per batch. */
  private listing = new Map<string, Promise<Map<string, DFile[]>>>();
  private folderMade = new Map<string, Promise<string>>();
  private lastBytes = 0;
  private lastAt = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  onFinished: (() => void) | null = null;
  /** The sync in progress (or the last one), shown at the top of the upload panel. */
  sync = $state<SyncRun | null>(null);

  get totals() {
    let size = 0, sent = 0, done = 0, skipped = 0, failed = 0, active = 0;
    for (const j of this.jobs) {
      size += j.size;
      sent += j.state === 'skipped' || j.state === 'done' ? j.size : j.sent;
      if (j.state === 'done') done++;
      else if (j.state === 'skipped') skipped++;
      else if (j.state === 'failed') failed++;
      else if (j.state !== 'cancelled') active++;
    }
    return { size, sent, done, skipped, failed, active, count: this.jobs.length };
  }

  /** Queue files (with relative paths) for the folder `parent`. */
  async add(drive: DriveApi, parent: string, picked: Picked[]): Promise<void> {
    this.drive = drive;
    this.open = true;
    this.error = '';
    const list = picked.filter((p) => !JUNK.test(p.path));
    for (const p of list) {
      const parts = p.path.split('/').filter(Boolean);
      const name = parts.pop() ?? p.file.name;
      const dir = parts.join('/');
      const key = `${parent}/${dir}/${name}:${p.file.size}:${p.file.lastModified}`;
      if (this.jobs.some((j) => j.key === key && j.state !== 'failed' && j.state !== 'cancelled')) continue;
      this.jobs.push({ key, name, dir, size: p.file.size, sent: 0, state: 'waiting', file: p.file, parent });
    }
    this.tick ??= setInterval(() => this.measure(), 1000);
    this.pump();
  }

  private measure() {
    const sent = this.totals.sent;
    const now = performance.now();
    if (this.lastAt) {
      const v = Math.max(0, (sent - this.lastBytes) / ((now - this.lastAt) / 1000));
      this.speed = this.speed ? this.speed * 0.7 + v * 0.3 : v;
    }
    this.lastBytes = sent;
    this.lastAt = now;
    if (!this.totals.active && this.tick) { clearInterval(this.tick); this.tick = null; this.speed = 0; this.lastAt = 0; }
    if (this.sync?.phase === 'uploading' && !this.jobs.some((j) => j.parent === this.sync!.targetId && ['waiting', 'checking', 'sending'].includes(j.state))) this.sync.phase = 'done';
  }

  private pump() {
    if (this.paused) return;
    while (this.running < this.PARALLEL) {
      const j = this.jobs.find((x) => x.state === 'waiting');
      if (!j) {
        if (!this.running) { this.listing.clear(); this.onFinished?.(); }
        return;
      }
      this.running++;
      j.state = 'checking';
      void this.run(j).finally(() => { this.running--; this.pump(); });
    }
  }

  private children(folderId: string): Promise<Map<string, DFile[]>> {
    let p = this.listing.get(folderId);
    if (!p) {
      p = this.drive!.children(folderId).then((files) => {
        const m = new Map<string, DFile[]>();
        for (const f of files) m.set(f.name, [...(m.get(f.name) ?? []), f]);
        return m;
      });
      p.catch(() => this.listing.delete(folderId));
      this.listing.set(folderId, p);
    }
    return p;
  }

  /** The Drive folder for `dir` under `parent`, made if it is not there (reusing one with that name). */
  private folderFor(parent: string, dir: string): Promise<string> {
    if (!dir) return Promise.resolve(parent);
    const key = `${parent}/${dir}`;
    let p = this.folderMade.get(key);
    if (!p) {
      p = (async () => {
        const parts = dir.split('/');
        const name = parts.pop()!;
        const up = await this.folderFor(parent, parts.join('/'));
        const kids = await this.children(up);
        const have = kids.get(name)?.find((f) => f.mimeType === FOLDER_MIME);
        if (have) return have.id;
        const made = await this.drive!.createFolder(name, up);
        kids.set(name, [...(kids.get(name) ?? []), made]);
        sizes.local(made);
        return made.id;
      })();
      p.catch(() => this.folderMade.delete(key));
      this.folderMade.set(key, p);
    }
    return p;
  }

  private async run(j: Job) {
    const d = this.drive!;
    j.abort = new AbortController();
    try {
      const folder = await this.folderFor(j.parent, j.dir);
      const same = (await this.children(folder)).get(j.name)?.find((f) => f.mimeType !== FOLDER_MIME && bytesOf(f) === j.size);
      if (same) { j.state = 'skipped'; j.sent = j.size; return; }
      const meta = {
        name: j.name, parents: [folder],
        ...(j.file.type ? { mimeType: j.file.type } : {}),
        ...(j.file.lastModified ? { modifiedTime: new Date(j.file.lastModified).toISOString() } : {}),
      };
      j.state = 'sending';
      const skey = `${folder}/${j.name}:${j.size}:${j.file.lastModified}`;
      const saved = await sessionGet(skey);
      let url = saved && Date.now() - saved.at < SESSION_MS ? saved.url : '';
      if (url) j.resumed = true;
      else {
        url = await d.startUpload(meta, j.size, j.replace);
        await sessionSet(skey, { url, at: Date.now() });
      }
      let r;
      try {
        r = await sendFile(url, j.file, (n) => (j.sent = n), j.abort.signal, j.resumed, (from) => (j.resumedFrom = from));
      } catch (e) {
        if (!j.resumed || /expired|answered 4/.test((e as Error).message) === false) throw e;
        // The saved session is gone: start this file over once.
        j.resumed = false;
        j.sent = 0;
        url = await d.startUpload(meta, j.size, j.replace);
        await sessionSet(skey, { url, at: Date.now() });
        r = await sendFile(url, j.file, (n) => (j.sent = n), j.abort.signal);
      }
      await sessionSet(skey, null);
      j.state = 'done';
      j.sent = j.size;
      if (r.id) sizes.local({ id: r.id, name: j.name, mimeType: j.file.type || 'application/octet-stream', size: String(j.size), parents: [folder] });
    } catch (e) {
      if ((e as Error).name === 'AbortError') { j.state = 'cancelled'; return; }
      j.state = 'failed';
      j.error = (e as Error).message;
    }
  }

  /**
   * Sync a local folder into the Drive folder `targetId`: its contents (not the folder itself) are
   * compared with what is in Drive, folder by folder. New files are uploaded, files whose size
   * changed get their new contents as a new revision, files already there are left alone.
   * Nothing in Drive is deleted. Stopping and syncing again carries on (resumable sessions).
   */
  async syncFolder(drive: DriveApi, targetId: string, target: string, picked: Picked[]): Promise<void> {
    this.drive = drive;
    this.open = true;
    this.listing.clear();
    const list = picked.filter((p) => !JUNK.test(p.path)).map((p) => {
      const parts = p.path.split('/').filter(Boolean);
      if (parts.length > 1) parts.shift(); // the picked folder's own name
      const name = parts.pop() ?? p.file.name;
      return { file: p.file, dir: parts.join('/'), name };
    });
    const local = picked[0]?.path.split('/')[0] ?? 'folder';
    const run: SyncRun = { local, target, targetId, phase: 'comparing', files: list.length, bytes: list.reduce((n, x) => n + x.file.size, 0), compared: 0, same: 0, missing: 0, changed: 0, toSend: 0 };
    this.sync = run;
    const r = this.sync!;
    try {
      // Compare, one Drive listing per folder, several folders at once.
      const dirs = [...new Set(list.map((x) => x.dir))];
      const found = new Map<string, Map<string, DFile[]> | null>();
      let next = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (next < dirs.length) {
          const dir = dirs[next++]!;
          const id = await this.findFolder(targetId, dir);
          found.set(dir, id ? await this.children(id) : null);
        }
      }));
      const queue: { file: File; dir: string; name: string; replace?: string }[] = [];
      for (const x of list) {
        const kids = found.get(x.dir)?.get(x.name)?.filter((f) => f.mimeType !== FOLDER_MIME) ?? [];
        r.compared++;
        if (!kids.length) { r.missing++; queue.push(x); continue; }
        // Google Docs have no size: never overwrite those.
        if (kids.some((f) => bytesOf(f) === x.file.size || f.mimeType.startsWith('application/vnd.google-apps'))) { r.same++; continue; }
        r.changed++;
        queue.push({ ...x, replace: kids[0]!.id });
      }
      r.toSend = queue.reduce((n, x) => n + x.file.size, 0);
      r.phase = queue.length ? 'uploading' : 'done';
      for (const x of queue) {
        const key = `${targetId}/${x.dir}/${x.name}:${x.file.size}:${x.file.lastModified}`;
        if (this.jobs.some((j) => j.key === key && j.state !== 'failed' && j.state !== 'cancelled')) continue;
        this.jobs.push({ key, name: x.name, dir: x.dir, size: x.file.size, sent: 0, state: 'waiting', file: x.file, parent: targetId, ...(x.replace ? { replace: x.replace } : {}) });
      }
      this.tick ??= setInterval(() => this.measure(), 1000);
      this.pump();
    } catch (e) {
      r.phase = 'failed';
      r.error = (e as Error).message;
    }
  }

  /** The existing Drive folder for `dir` under `parent`, or null (sync compares before it creates anything). */
  private async findFolder(parent: string, dir: string): Promise<string | null> {
    let id = parent;
    for (const name of dir ? dir.split('/') : []) {
      const f = (await this.children(id)).get(name)?.find((x) => x.mimeType === FOLDER_MIME);
      if (!f) return null;
      id = f.id;
    }
    return id;
  }

  pause() {
    this.paused = true;
    for (const j of this.jobs) if (j.state === 'sending' || j.state === 'checking') { j.abort?.abort(); }
    // Aborted jobs land as cancelled; put them back in the queue so Resume picks them up (from the saved session).
    queueMicrotask(() => setTimeout(() => { for (const j of this.jobs) if (j.state === 'cancelled') { j.state = 'waiting'; } }, 50));
  }
  resume() { this.paused = false; this.pump(); }
  retry(j?: Job) {
    for (const x of j ? [j] : this.jobs) if (x.state === 'failed' || x.state === 'cancelled') { x.state = 'waiting'; x.error = undefined; }
    this.pump();
  }
  cancel(j: Job) { if (j.state === 'waiting') j.state = 'cancelled'; else j.abort?.abort(); }
  cancelAll() { for (const j of this.jobs) this.cancel(j); }
  clear() {
    this.jobs = this.jobs.filter((j) => j.state === 'waiting' || j.state === 'sending' || j.state === 'checking');
    if (this.sync && this.sync.phase !== 'comparing' && this.sync.phase !== 'uploading') this.sync = null;
    if (!this.jobs.length && !this.sync) this.open = false;
  }
}

export const uploader = new Uploader();
