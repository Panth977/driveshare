// Local folders, read one directory at a time. A folder with a million files is never turned into
// one big list: the transfer engine asks for one directory's entries, compares them, and moves on.
//
// Three sources, one shape:
//  - a FileSystemDirectoryHandle (Chrome/Edge: the folder picker, or a drop): best. It can be saved
//    in IndexedDB, so a sync that runs for days carries on after a reload with one click.
//  - a FileSystemDirectoryEntry (a drop in other browsers).
//  - a FileList from <input webkitdirectory> (fallback): grouped into directories once.

export interface LocalFile { kind: 'file'; name: string; file(): Promise<File> }
export interface LocalDir { kind: 'dir'; name: string; entries(): AsyncGenerator<LocalFile | LocalDir> }
export type LocalEntry = LocalFile | LocalDir;

/** Files we never upload. */
export const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*|\.localized|Icon\r)$/i;

// ── File System Access API ──────────────────────────────────────────────────

interface DirHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export function fromHandle(h: FileSystemDirectoryHandle): LocalDir {
  const d = h as DirHandle;
  return {
    kind: 'dir',
    name: d.name,
    async *entries() {
      for await (const [name, child] of d.entries()) {
        if (JUNK.test(name)) continue;
        if (child.kind === 'file') yield { kind: 'file', name, file: () => (child as FileSystemFileHandle).getFile() };
        else yield fromHandle(child as FileSystemDirectoryHandle);
      }
    },
  };
}

export const canPickFolder = () => typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/** The folder picker (Chrome/Edge). Null when cancelled. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as unknown as { showDirectoryPicker(o?: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'driveshare-sync', mode: 'read' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}

/** Read permission for a saved handle (asks the user when needed; must run in a click). */
export async function allowRead(h: FileSystemDirectoryHandle): Promise<boolean> {
  const d = h as DirHandle;
  if (!d.queryPermission) return true;
  if ((await d.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await d.requestPermission?.({ mode: 'read' })) === 'granted';
}

// ── drops ───────────────────────────────────────────────────────────────────

/** What was dropped: handles where the browser gives them, entries otherwise. */
export async function fromDrop(dt: DataTransfer): Promise<{ dirs: { dir: LocalDir; handle?: FileSystemDirectoryHandle }[]; files: File[] }> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const out: { dirs: { dir: LocalDir; handle?: FileSystemDirectoryHandle }[]; files: File[] } = { dirs: [], files: [] };
  // Ask for every handle/entry synchronously first: the DataTransfer is emptied after the first await.
  const handles = items.map((i) => (i as DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.() ?? null);
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const files = items.map((i) => i.getAsFile());
  for (let k = 0; k < items.length; k++) {
    const h = await handles[k]?.catch(() => null);
    if (h?.kind === 'directory') { out.dirs.push({ dir: fromHandle(h as FileSystemDirectoryHandle), handle: h as FileSystemDirectoryHandle }); continue; }
    const e = entries[k];
    if (e?.isDirectory) { out.dirs.push({ dir: fromEntry(e as FileSystemDirectoryEntry) }); continue; }
    const f = files[k];
    if (f && !JUNK.test(f.name)) out.files.push(f);
  }
  return out;
}

function fromEntry(e: FileSystemDirectoryEntry): LocalDir {
  return {
    kind: 'dir',
    name: e.name,
    async *entries() {
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) return;
        for (const c of batch) {
          if (JUNK.test(c.name)) continue;
          if (c.isFile) yield { kind: 'file', name: c.name, file: () => new Promise<File>((res, rej) => (c as FileSystemFileEntry).file(res, rej)) };
          else if (c.isDirectory) yield fromEntry(c as FileSystemDirectoryEntry);
        }
      }
    },
  };
}

// ── <input webkitdirectory> fallback ────────────────────────────────────────

interface Node { name: string; files: File[]; dirs: Map<string, Node> }

/** Group a FileList by directory (one pass), then serve it like a folder. */
export function fromFileList(list: FileList | File[]): LocalDir | null {
  const files = [...list];
  if (!files.length) return null;
  const root: Node = { name: (files[0]!.webkitRelativePath || files[0]!.name).split('/')[0] ?? 'folder', files: [], dirs: new Map() };
  for (const f of files) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    parts.shift();
    const name = parts.pop() ?? f.name;
    if (JUNK.test(name)) continue;
    let n = root;
    for (const p of parts) {
      let c = n.dirs.get(p);
      if (!c) n.dirs.set(p, (c = { name: p, files: [], dirs: new Map() }));
      n = c;
    }
    n.files.push(f);
  }
  const wrap = (n: Node): LocalDir => ({
    kind: 'dir',
    name: n.name,
    async *entries() {
      for (const f of n.files) yield { kind: 'file', name: f.name, file: async () => f };
      for (const c of n.dirs.values()) yield wrap(c);
    },
  });
  return wrap(root);
}

/** Loose files (the Files button) as a folder with no name. */
export function fromFiles(files: File[]): LocalDir {
  return {
    kind: 'dir',
    name: '',
    async *entries() { for (const f of files) if (!JUNK.test(f.name)) yield { kind: 'file', name: f.name, file: async () => f }; },
  };
}
