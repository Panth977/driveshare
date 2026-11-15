// Folder listings kept in IndexedDB: a folder you opened before shows at once (also after a reload
// or on the TV), and Drive is asked again in the background; the view updates only if it changed.
import type { DFile, DriveApi } from './gdrive.ts';

const DB = 'driveshare-cache';
let opening: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('children');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { opening = null; reject(r.error); };
  });
  return opening;
}
async function get(id: string): Promise<{ at: number; files: DFile[] } | undefined> {
  const db = await idb().catch(() => null);
  if (!db) return undefined;
  return new Promise((resolve) => {
    const q = db.transaction('children').objectStore('children').get(id);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => resolve(undefined);
  });
}
async function put(id: string, files: DFile[]): Promise<void> {
  const db = await idb().catch(() => null);
  if (!db) return;
  db.transaction('children', 'readwrite').objectStore('children').put({ at: Date.now(), files }, id);
}

// The same listings in memory too, for this page's life: going back to a folder (or into the
// viewer and out again) draws at once, without even waiting for IndexedDB.
const memo = new Map<string, DFile[]>();
const memoAt = new Map<string, number>();
const FRESH_MS = 60_000;
const memoKey = (id: string, orderBy?: string) => (orderBy ? `${id}|${orderBy}` : id);
/** The listing in memory right now, if any (to draw before anything async). */
export const peek = (id: string, opts: { orderBy?: string } = {}): DFile[] | undefined => memo.get(memoKey(id, opts.orderBy));
/** Folder details seen lately (name, parents), so the viewer does not ask Drive each time. */
export const folderMeta = new Map<string, DFile>();

const sig = (l: DFile[]) => l.map((f) => `${f.id}:${f.name}:${f.modifiedTime}:${f.starred ? 1 : 0}:${f.appProperties?.dsPlay ?? ''}`).join('|');

/**
 * Children of a folder: the cached copy right away (if any), then `onFresh` with Drive's answer
 * when it differs. Without a cached copy it waits for Drive.
 */
export async function children(drive: DriveApi, id: string, onFresh: (files: DFile[]) => void, opts: { orderBy?: string } = {}): Promise<DFile[]> {
  const key = memoKey(id, opts.orderBy);
  const inMemory = memo.get(key);
  // Asked Drive less than a minute ago: that answer is fresh enough (stepping in and out).
  if (inMemory && Date.now() - (memoAt.get(key) ?? 0) < FRESH_MS) return inMemory;
  const cached = inMemory ? { at: 0, files: inMemory } : drive.demo ? undefined : await get(key);
  const fresh = drive.children(id, opts).then((files) => {
    memo.set(key, files);
    memoAt.set(key, Date.now());
    for (const f of files) if (f.mimeType === 'application/vnd.google-apps.folder') folderMeta.set(f.id, f);
    if (!drive.demo) void put(key, files);
    if (cached && sig(cached.files) !== sig(files)) onFresh(files);
    return files;
  });
  if (cached) { fresh.catch(() => {}); return cached.files; }
  return fresh;
}

/** Forget a folder's copy (after we changed it ourselves). */
export async function forget(id: string): Promise<void> {
  for (const k of [...memo.keys()]) if (k === id || k.startsWith(`${id}|`)) memo.delete(k);
  const db = await idb().catch(() => null);
  if (!db) return;
  db.transaction('children', 'readwrite').objectStore('children').delete(id);
}

/** A file changed (binned, starred, renamed): keep the in-memory listings that show it right. */
export function noteUpdate(f: DFile, patch: Partial<DFile>): void {
  for (const [k, l] of memo) {
    if (!l.some((x) => x.id === f.id)) continue;
    memo.set(k, patch.trashed ? l.filter((x) => x.id !== f.id) : l.map((x) => (x.id === f.id ? { ...x, ...patch } : x)));
  }
  // Back from the bin: its folder's listing is asked again next time.
  if (patch.trashed === false) for (const p of f.parents ?? []) for (const k of [...memo.keys()]) if (k === p || k.startsWith(`${p}|`)) memo.delete(k);
}

/** Store a listing we just fetched ourselves. */
export const remember = (id: string, files: DFile[]) => { memo.set(id, files); return put(id, files); };
