// A small Google Drive v3 REST client: only the calls DriveShare makes. `fetch` is injectable
// so the tests run it against an in-memory Drive (test/fake-drive.ts).
import { FOLDER_MIME } from '../../shared.ts';

export type Fetch = typeof fetch;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  parents?: string[];
  owners?: { emailAddress?: string }[];
  appProperties?: Record<string, string>;
  trashed?: boolean;
}
export interface Permission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
  pendingOwner?: boolean;
}

export class DriveError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string) {
    super(message);
    this.name = 'DriveError';
  }
}

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,mimeType,size,parents,owners(emailAddress),appProperties,trashed';

export class Drive {
  constructor(private readonly token: string, private readonly f: Fetch = fetch) {}

  /** One Drive call; rate limits and server errors are retried with backoff (Drive asks for that). */
  private async call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, url, body, headers);
      } catch (e) {
        const retry = e instanceof DriveError && (e.status === 429 || e.status >= 500 || (e.status === 403 && /rateLimit/i.test(e.reason ?? '')));
        if (!retry || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, Math.min(16_000, 500 * 2 ** attempt) + Math.random() * 300));
      }
    }
  }

  private async once<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.f(url, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = json?.error;
      throw new DriveError(res.status, e?.message ?? `Drive ${res.status}`, e?.errors?.[0]?.reason);
    }
    return json as T;
  }

  get(id: string): Promise<DriveFile> {
    return this.call('GET', `${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`);
  }

  async list(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let page: string | undefined;
    do {
      const u = new URL(`${API}/files`);
      u.searchParams.set('q', q);
      u.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
      u.searchParams.set('pageSize', '1000');
      u.searchParams.set('spaces', 'drive');
      if (page) u.searchParams.set('pageToken', page);
      const r = await this.call<{ files: DriveFile[]; nextPageToken?: string }>('GET', u.toString());
      out.push(...r.files);
      page = r.nextPageToken;
    } while (page);
    return out;
  }

  /**
   * Everything under a folder (any depth), folders included. One level at a time, and each Drive
   * query asks for the children of up to `batch` folders at once (`'a' in parents or 'b' in parents …`),
   * `parallel` queries at a time: a tree of 1,000 folders costs ~25 calls, not 1,000.
   */
  async walk(folderId: string, opts: { maxFolders?: number; batch?: number; parallel?: number; deadline?: number } = {}): Promise<DriveFile[]> {
    const { maxFolders = 20_000, batch = 40, parallel = 4, deadline = Infinity } = opts;
    const all: DriveFile[] = [];
    const seen = new Set([folderId]);
    const got = new Set<string>();
    let level = [folderId];
    let folders = 0;
    while (level.length && folders < maxFolders) {
      if (Date.now() > deadline) throw new DriveError(408, 'Folder walk ran out of time');
      folders += level.length;
      const groups: string[][] = [];
      for (let i = 0; i < level.length; i += batch) groups.push(level.slice(i, i + batch));
      const next: string[] = [];
      await pool(groups, parallel, async (ids) => {
        const kids = await this.list(`(${ids.map((id) => `'${id}' in parents`).join(' or ')}) and trashed = false`);
        for (const k of kids) {
          if (got.has(k.id)) continue; // a file with two parents in the tree comes back twice
          got.add(k.id);
          all.push(k);
          if (k.mimeType === FOLDER_MIME && !seen.has(k.id)) { seen.add(k.id); next.push(k.id); }
        }
      });
      level = next;
    }
    return all;
  }

  createFolder(name: string, parent?: string, appProperties?: Record<string, string>): Promise<DriveFile> {
    return this.call('POST', `${API}/files?fields=${FILE_FIELDS}`, { name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}), ...(appProperties ? { appProperties } : {}) });
  }

  update(id: string, patch: Partial<Pick<DriveFile, 'name' | 'trashed'>>): Promise<DriveFile> {
    return this.call('PATCH', `${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`, patch);
  }

  permissions(id: string): Promise<Permission[]> {
    return this.call<{ permissions: Permission[] }>('GET', `${API}/files/${encodeURIComponent(id)}/permissions?fields=permissions(id,type,role,emailAddress,pendingOwner)`).then((r) => r.permissions ?? []);
  }

  addPermission(id: string, p: { type: 'user' | 'anyone'; role: 'reader' | 'writer'; emailAddress?: string; allowFileDiscovery?: boolean }, opts: { notify?: boolean; message?: string } = {}): Promise<Permission> {
    const u = new URL(`${API}/files/${encodeURIComponent(id)}/permissions`);
    u.searchParams.set('fields', 'id,type,role,emailAddress,pendingOwner');
    if (p.type === 'user') u.searchParams.set('sendNotificationEmail', String(!!opts.notify));
    if (opts.notify && opts.message) u.searchParams.set('emailMessage', opts.message);
    return this.call('POST', u.toString(), p);
  }

  updatePermission(id: string, permissionId: string, patch: { role: string; pendingOwner?: boolean }, transferOwnership = false): Promise<Permission> {
    const u = new URL(`${API}/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`);
    u.searchParams.set('fields', 'id,type,role,emailAddress,pendingOwner');
    if (transferOwnership) u.searchParams.set('transferOwnership', 'true');
    return this.call('PATCH', u.toString(), patch);
  }

  deletePermission(id: string, permissionId: string): Promise<void> {
    return this.call('DELETE', `${API}/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`);
  }

  /**
   * Open a resumable upload in this account's Drive and return its session URL. The browser at
   * `origin` sends the bytes there itself (Drive answers its CORS because the session was opened
   * with that Origin); the URL is the only credential it gets.
   */
  async startResumable(meta: { name: string; parents: string[]; mimeType?: string; description?: string; appProperties?: Record<string, string> }, size: number, origin: string): Promise<string> {
    const res = await this.f(`${UPLOAD}/files?uploadType=resumable&fields=id,size`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        ...(meta.mimeType ? { 'x-upload-content-type': meta.mimeType } : {}),
        origin,
      },
      body: JSON.stringify(meta),
    });
    const url = res.headers.get('location');
    if (!res.ok || !url) {
      const e = await res.json().catch(() => ({}));
      throw new DriveError(res.status, (e as { error?: { message?: string } }).error?.message ?? `Drive ${res.status}`);
    }
    return url;
  }
}

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;
export const sizeOf = (f: DriveFile) => Number(f.size ?? 0);

/** Run `fn` over `items`, at most `n` at a time. */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}
