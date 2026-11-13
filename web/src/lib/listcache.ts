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

const sig = (l: DFile[]) => l.map((f) => `${f.id}:${f.name}:${f.modifiedTime}:${f.starred ? 1 : 0}`).join('|');

/**
 * Children of a folder: the cached copy right away (if any), then `onFresh` with Drive's answer
 * when it differs. Without a cached copy it waits for Drive.
 */
export async function children(drive: DriveApi, id: string, onFresh: (files: DFile[]) => void, opts: { orderBy?: string } = {}): Promise<DFile[]> {
  const key = opts.orderBy ? `${id}|${opts.orderBy}` : id;
  const cached = drive.demo ? undefined : await get(key);
  const fresh = drive.children(id, opts).then((files) => {
    void put(key, files);
    if (cached && sig(cached.files) !== sig(files)) onFresh(files);
    return files;
  });
  if (cached) { fresh.catch(() => {}); return cached.files; }
  return fresh;
}

/** Forget a folder's copy (after we changed it ourselves). */
export async function forget(id: string): Promise<void> {
  const db = await idb().catch(() => null);
  if (!db) return;
  db.transaction('children', 'readwrite').objectStore('children').delete(id);
}

/** Store a listing we just fetched ourselves. */
export const remember = (id: string, files: DFile[]) => put(id, files);
