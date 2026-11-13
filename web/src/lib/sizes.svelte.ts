// Folder sizes and counts for the whole Drive. Drive itself never says how big a folder is, so we
// list every file once (1,000 per call), keep a compact copy in IndexedDB, and from then on only
// read Drive's change feed. Totals are summed bottom-up in the browser.
import { FOLDER_MIME, type DFile, type DriveApi } from './gdrive.ts';

/** One entry: [parent id or '', size in bytes, 1 = folder]. Names are not needed for sums. */
type Entry = [string, number, 0 | 1];

export interface Totals { bytes: number; files: number; folders: number }

const INDEX_FIELDS = 'id,mimeType,size,quotaBytesUsed,parents';
const DB = 'driveshare-index';
const VERSION = 1;

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const q = db.transaction('kv').objectStore('kv').get(key);
    q.onsuccess = () => resolve(q.result as T | undefined);
    q.onerror = () => reject(q.error);
  });
}
async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

const entryOf = (f: DFile): Entry => [f.parents?.[0] ?? '', Number(f.size ?? f.quotaBytesUsed ?? 0), f.mimeType === FOLDER_MIME ? 1 : 0];

class SizeIndex {
  /** 'idle' → 'scanning' (first full listing) → 'ready'; 'updating' while reading changes. */
  state = $state<'idle' | 'scanning' | 'ready' | 'updating' | 'error'>('idle');
  scanned = $state(0);
  error = $state('');
  /** Bumped whenever totals change, so views re-read them. */
  version = $state(0);
  builtAt = $state(0);

  private entries = new Map<string, Entry>();
  private totals = new Map<string, Totals>();
  private changeToken = '';
  private owner = '';
  private drive: DriveApi | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Load the cached index (or build it), then follow Drive's changes every minute. */
  async start(drive: DriveApi, owner: string): Promise<void> {
    if (this.drive === drive && this.owner === owner && this.state !== 'error') return;
    this.drive = drive;
    this.owner = owner;
    try {
      const saved = await kvGet<{ owner: string; token: string; at: number; entries: [string, Entry][] }>('index').catch(() => undefined);
      if (saved && saved.owner === owner && saved.token && !drive.demo) {
        this.entries = new Map(saved.entries);
        this.changeToken = saved.token;
        this.builtAt = saved.at;
        this.sum();
        this.state = 'ready';
        await this.update();
      } else {
        await this.rebuild();
      }
    } catch (e) {
      this.state = 'error';
      this.error = (e as Error).message;
    }
    this.timer ??= setInterval(() => { if (this.state === 'ready') void this.update(); }, 60_000);
  }

  /** List the whole Drive again. */
  async rebuild(): Promise<void> {
    const d = this.drive;
    if (!d) return;
    this.state = 'scanning';
    this.scanned = 0;
    this.error = '';
    const token = await d.startPageToken();
    const next = new Map<string, Entry>();
    await d.everything((files) => {
      for (const f of files) next.set(f.id, entryOf(f));
      this.scanned = next.size;
    }, INDEX_FIELDS);
    this.entries = next;
    this.changeToken = token;
    this.builtAt = Date.now();
    this.sum();
    this.state = 'ready';
    await this.save();
  }

  /** Read Drive's change feed since last time and fold it in. */
  async update(): Promise<void> {
    const d = this.drive;
    if (!d || !this.changeToken || d.demo) return;
    this.state = 'updating';
    try {
      const r = await d.changes(this.changeToken, INDEX_FIELDS);
      for (const c of r.changes) {
        if (c.removed || !c.file || c.file.trashed) this.entries.delete(c.fileId);
        else this.entries.set(c.fileId, entryOf(c.file));
      }
      this.changeToken = r.next;
      if (r.changes.length) { this.sum(); await this.save(); }
    } catch (e) {
      // An expired change token means the copy is too old: list everything again.
      if ((e as { status?: number }).status === 410 || (e as { status?: number }).status === 404) return this.rebuild();
      this.error = (e as Error).message;
    }
    this.state = 'ready';
  }

  /** Apply a change we made ourselves right away (trash, upload, new folder), before the feed shows it. */
  local(f: DFile | { id: string; removed: true }): void {
    if ('removed' in f) this.entries.delete(f.id);
    else this.entries.set(f.id, entryOf(f));
    this.sum();
  }

  private async save() {
    await kvSet('index', { owner: this.owner, token: this.changeToken, at: this.builtAt, entries: [...this.entries] }).catch(() => {});
  }

  private sum() {
    const t = new Map<string, Totals>();
    const get = (id: string) => { let x = t.get(id); if (!x) t.set(id, (x = { bytes: 0, files: 0, folders: 0 })); return x; };
    for (const [id, [, size, folder]] of this.entries) {
      // Walk up the parents (guarding against loops) and add this item to each.
      let p = this.entries.get(id)?.[0];
      const seen = new Set<string>([id]);
      while (p && !seen.has(p)) {
        seen.add(p);
        const x = get(p);
        if (folder) x.folders++; else { x.files++; x.bytes += size; }
        p = this.entries.get(p)?.[0];
      }
    }
    this.totals = t;
    this.version++;
  }

  of(folderId: string): Totals | undefined {
    void this.version;
    if (this.state === 'idle' || this.state === 'scanning') return undefined;
    return this.totals.get(folderId) ?? { bytes: 0, files: 0, folders: 0 };
  }

  get count(): number { void this.version; return this.entries.size; }
}

export const sizes = new SizeIndex();
