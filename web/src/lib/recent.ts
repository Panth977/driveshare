// Folders you looked through lately (this browser only): the "Recent" place on the TV and in My
// Drive. Each one remembers the file you were on, so opening it carries on from there.
import { FOLDER_MIME, type DFile } from './gdrive.ts';

export interface RecentFolder {
  id: string;
  name: string;
  /** When it was last viewed (ms). */
  at: number;
  /** The file on screen when you left (for its picture, and to carry on from it). */
  file?: Pick<DFile, 'id' | 'name' | 'mimeType' | 'thumbnailLink' | 'modifiedTime'>;
  deep?: boolean;
}

const KEY = 'ds.recentFolders';
const MAX = 40;

export function recentFolders(): RecentFolder[] {
  try {
    const now = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RecentFolder[] | null;
    if (now) return now;
    // The viewer's older short list (names only).
    const old = JSON.parse(localStorage.getItem('ds.v.recent') ?? '[]') as { id: string; name: string }[];
    return old.map((r, i) => ({ id: r.id, name: r.name, at: Date.now() - i * 1000 }));
  } catch { return []; }
}

/** Note that `folder` is being viewed, on `file`. */
export function noteFolder(folder: { id: string; name: string }, file?: DFile, deep?: boolean): void {
  const rest = recentFolders().filter((r) => r.id !== folder.id);
  const prev = recentFolders().find((r) => r.id === folder.id);
  const f = file ? { id: file.id, name: file.name, mimeType: file.mimeType, ...(file.thumbnailLink ? { thumbnailLink: file.thumbnailLink } : {}), ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}) } : prev?.file;
  const entry: RecentFolder = { id: folder.id, name: folder.name, at: Date.now(), ...(f ? { file: f } : {}), ...(deep ? { deep } : {}) };
  try { localStorage.setItem(KEY, JSON.stringify([entry, ...rest].slice(0, MAX))); } catch { /* full */ }
}

export function forgetFolder(id: string): void {
  try { localStorage.setItem(KEY, JSON.stringify(recentFolders().filter((r) => r.id !== id))); } catch { /* ignore */ }
}

/** Recent folders as folder entries for a file grid (newest first); `recent` holds the details. */
export function recentAsFiles(): (DFile & { recent: RecentFolder })[] {
  return recentFolders().map((r) => ({ id: r.id, name: r.name, mimeType: FOLDER_MIME, modifiedTime: new Date(r.at).toISOString(), recent: r }));
}
