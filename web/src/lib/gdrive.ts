// The owner's whole Drive, straight from the browser. The backend only mints a short-lived access
// token (driveAccess); every list, preview, comment and upload goes from here to Google directly,
// so a 5 TB Drive costs the functions one call an hour.
import { FOLDER_MIME } from '@driveshare/backend/shared';
import { auth, driveAccess, errorText } from './icebase.ts';

export { FOLDER_MIME };

export interface DFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  quotaBytesUsed?: string;
  parents?: string[];
  modifiedTime?: string;
  createdTime?: string;
  thumbnailLink?: string;
  hasThumbnail?: boolean;
  iconLink?: string;
  starred?: boolean;
  shared?: boolean;
  ownedByMe?: boolean;
  webViewLink?: string;
  trashed?: boolean;
  imageMediaMetadata?: { width?: number; height?: number; time?: string; cameraModel?: string };
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string };
}

export interface DComment {
  id: string;
  content: string;
  createdTime: string;
  resolved?: boolean;
  author?: { displayName?: string; photoLink?: string; me?: boolean };
}

export interface DPermission { id: string; type: string; role: string; emailAddress?: string }

export interface Quota { limit?: string; usage?: string; usageInDrive?: string; usageInDriveTrash?: string }

export const FIELDS = 'id,name,mimeType,size,quotaBytesUsed,parents,modifiedTime,createdTime,thumbnailLink,hasThumbnail,iconLink,starred,shared,ownedByMe,webViewLink,imageMediaMetadata(width,height,time,cameraModel),videoMediaMetadata(width,height,durationMillis)';

export class DriveFail extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string) {
    super(message);
    this.name = 'DriveFail';
  }
}

/** What the views need from Drive. RestDrive talks to Google; DemoDrive (dev only) fakes it for screenshots. */
export interface DriveApi {
  readonly demo?: boolean;
  token(): Promise<string>;
  about(): Promise<{ email: string; quota: Quota }>;
  children(folderId: string, opts?: { orderBy?: string }): Promise<DFile[]>;
  query(q: string, opts?: { orderBy?: string; max?: number }): Promise<DFile[]>;
  get(id: string): Promise<DFile>;
  /** Every non-trashed file and folder you can see, page by page (for the size index). */
  everything(onPage: (files: DFile[]) => void, fields: string): Promise<void>;
  startPageToken(): Promise<string>;
  /** One page of Drive's change feed; `done` when `next` is the token to start from next time. */
  changes(pageToken: string, fields: string): Promise<{ changes: { fileId: string; removed?: boolean; file?: DFile }[]; next: string; done: boolean }>;
  createFolder(name: string, parent: string): Promise<DFile>;
  update(id: string, patch: { name?: string; trashed?: boolean; starred?: boolean }): Promise<DFile>;
  comments(id: string): Promise<DComment[]>;
  addComment(id: string, content: string): Promise<DComment>;
  permissions(id: string): Promise<DPermission[]>;
  shareAnyone(id: string): Promise<string>;
  unshareAnyone(id: string): Promise<void>;
  /** Open a resumable upload; the browser then PUTs chunks to the URL it returns. */
  /** `replace`: put new contents into this existing file (a new revision) instead of making a file. */
  startUpload(meta: { name: string; parents: string[]; mimeType?: string; modifiedTime?: string }, size: number, replace?: string): Promise<string>;
  /** A blob: or http URL that shows the file's bytes (images, PDFs). */
  mediaUrl(f: DFile): Promise<string>;
  /** A URL a <video>/<audio> element can stream with Range requests. */
  streamUrl(f: DFile): string;
}

const API = 'https://www.googleapis.com/drive/v3';
const TOKEN_KEY = 'ds.driveToken';
function readSavedToken(uid: string): { value: string; until: number; email: string } | null {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null') as { uid: string; value: string; until: number; email: string } | null;
    return t && uid && t.uid === uid && Date.now() < t.until ? t : null;
  } catch { return null; }
}
export const forgetDriveToken = () => localStorage.removeItem(TOKEN_KEY);
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class RestDrive implements DriveApi {
  private tok: { value: string; until: number } | null = null;
  private pending: Promise<string> | null = null;
  email = '';

  constructor() {
    setTokenSource((fresh) => { if (fresh) this.dropToken(); return this.token(); });
  }

  /**
   * The owner's Google access token. Kept in localStorage until it expires (about an hour), so
   * reloading the page or opening a new tab costs no function call: one call an hour at most.
   */
  async token(): Promise<string> {
    if (this.tok && Date.now() < this.tok.until) return this.tok.value;
    const uid = auth.currentUser?.uid ?? '';
    const saved = readSavedToken(uid);
    if (saved) {
      this.tok = { value: saved.value, until: saved.until };
      this.email = saved.email;
      postToken(saved.value);
      return saved.value;
    }
    this.pending ??= driveAccess({}).then((r) => {
      this.tok = { value: r.accessToken, until: r.expiresAt };
      this.email = r.email;
      localStorage.setItem(TOKEN_KEY, JSON.stringify({ uid, value: r.accessToken, until: r.expiresAt, email: r.email }));
      postToken(r.accessToken);
      return r.accessToken;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  /** Google said the token is bad (revoked, or the clock lied): forget it and ask again. */
  private dropToken() { this.tok = null; localStorage.removeItem(TOKEN_KEY); }

  private async call<T>(method: string, url: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as T;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = (json as { error?: { message?: string; errors?: { reason?: string }[] } }).error;
      const reason = e?.errors?.[0]?.reason;
      if (res.status === 401 && attempt < 1) { this.dropToken(); return this.call(method, url, body, attempt + 1); }
      if ((res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit/i.test(reason ?? ''))) && attempt < 5) {
        await new Promise((r) => setTimeout(r, Math.min(16_000, 600 * 2 ** attempt) + Math.random() * 300));
        return this.call(method, url, body, attempt + 1);
      }
      throw new DriveFail(res.status, e?.message ?? `Drive answered ${res.status}`, reason);
    }
    return json as T;
  }

  async about() {
    const r = await this.call<{ user?: { emailAddress?: string }; storageQuota?: Quota }>('GET', `${API}/about?fields=user(emailAddress),storageQuota`);
    return { email: r.user?.emailAddress ?? '', quota: r.storageQuota ?? {} };
  }

  async query(q: string, opts: { orderBy?: string; max?: number } = {}): Promise<DFile[]> {
    const out: DFile[] = [];
    let page: string | undefined;
    do {
      const u = new URL(`${API}/files`);
      u.searchParams.set('q', q);
      u.searchParams.set('fields', `nextPageToken,files(${FIELDS})`);
      u.searchParams.set('pageSize', String(Math.min(1000, opts.max ?? 1000)));
      u.searchParams.set('orderBy', opts.orderBy ?? 'folder,name_natural');
      u.searchParams.set('spaces', 'drive');
      if (page) u.searchParams.set('pageToken', page);
      const r = await this.call<{ files: DFile[]; nextPageToken?: string }>('GET', u.toString());
      out.push(...r.files);
      page = r.nextPageToken;
    } while (page && out.length < (opts.max ?? Infinity));
    return out;
  }

  children(folderId: string, opts: { orderBy?: string } = {}) {
    return this.query(`'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`, opts);
  }

  get(id: string) {
    return this.call<DFile>('GET', `${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`);
  }

  /**
   * Drive pages one query at a time (~1,000 items in 2-3 s), so a big Drive is listed as many
   * queries at once: split by kind and by modified date, each slice paging on its own, 8 at a time.
   */
  async everything(onPage: (files: DFile[]) => void, fields: string): Promise<void> {
    const kinds = [
      `mimeType = '${FOLDER_MIME}'`, `mimeType = 'image/jpeg'`, `mimeType contains 'image/' and mimeType != 'image/jpeg'`,
      `mimeType contains 'video/'`, `mimeType contains 'application/'`,
      `not mimeType contains 'image/' and not mimeType contains 'video/' and not mimeType contains 'application/'`,
    ];
    const cuts = ['2014', '2017', '2019', '2021', '2023', '2024', '2025', '2026'].map((y) => `${y}-01-01T00:00:00`);
    const dates = [`modifiedTime < '${cuts[0]}'`, ...cuts.slice(1).map((c, i) => `modifiedTime >= '${cuts[i]}' and modifiedTime < '${c}'`), `modifiedTime >= '${cuts.at(-1)}'`];
    const slices = kinds.flatMap((k) => dates.map((d) => `${k} and ${d}`));
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < slices.length) {
        const slice = slices[next++]!;
        let page: string | undefined;
        do {
          const u = new URL(`${API}/files`);
          u.searchParams.set('q', `trashed = false and ${slice}`);
          u.searchParams.set('fields', `nextPageToken,files(${fields})`);
          u.searchParams.set('pageSize', '1000');
          u.searchParams.set('spaces', 'drive');
          if (page) u.searchParams.set('pageToken', page);
          const r = await this.call<{ files: DFile[]; nextPageToken?: string }>('GET', u.toString());
          onPage(r.files);
          page = r.nextPageToken;
        } while (page);
      }
    }));
  }

  async startPageToken() {
    return (await this.call<{ startPageToken: string }>('GET', `${API}/changes/startPageToken`)).startPageToken;
  }

  async changes(pageToken: string, fields: string) {
    const u = new URL(`${API}/changes`);
    u.searchParams.set('pageToken', pageToken);
    u.searchParams.set('pageSize', '1000');
    u.searchParams.set('spaces', 'drive');
    u.searchParams.set('includeRemoved', 'true');
    u.searchParams.set('fields', `nextPageToken,newStartPageToken,changes(fileId,removed,file(${fields},trashed))`);
    const r = await this.call<{ changes: { fileId: string; removed?: boolean; file?: DFile }[]; nextPageToken?: string; newStartPageToken?: string }>('GET', u.toString());
    return { changes: r.changes ?? [], next: (r.newStartPageToken ?? r.nextPageToken)!, done: !!r.newStartPageToken };
  }

  createFolder(name: string, parent: string) {
    return this.call<DFile>('POST', `${API}/files?fields=${FIELDS}`, { name, mimeType: FOLDER_MIME, parents: [parent] });
  }

  update(id: string, patch: { name?: string; trashed?: boolean; starred?: boolean }) {
    return this.call<DFile>('PATCH', `${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`, patch);
  }

  async comments(id: string) {
    const r = await this.call<{ comments: DComment[] }>('GET', `${API}/files/${encodeURIComponent(id)}/comments?pageSize=100&fields=comments(id,content,createdTime,resolved,author(displayName,photoLink,me))`);
    return r.comments ?? [];
  }

  addComment(id: string, content: string) {
    return this.call<DComment>('POST', `${API}/files/${encodeURIComponent(id)}/comments?fields=id,content,createdTime,resolved,author(displayName,photoLink,me)`, { content });
  }

  async permissions(id: string) {
    return (await this.call<{ permissions: DPermission[] }>('GET', `${API}/files/${encodeURIComponent(id)}/permissions?fields=permissions(id,type,role,emailAddress)`)).permissions ?? [];
  }

  async shareAnyone(id: string): Promise<string> {
    const has = (await this.permissions(id)).some((p) => p.type === 'anyone');
    if (!has) await this.call('POST', `${API}/files/${encodeURIComponent(id)}/permissions?fields=id`, { type: 'anyone', role: 'reader', allowFileDiscovery: false });
    const f = await this.call<{ webViewLink?: string }>('GET', `${API}/files/${encodeURIComponent(id)}?fields=webViewLink`);
    return f.webViewLink ?? `https://drive.google.com/file/d/${id}/view`;
  }

  async unshareAnyone(id: string): Promise<void> {
    for (const p of (await this.permissions(id)).filter((p) => p.type === 'anyone')) {
      await this.call('DELETE', `${API}/files/${encodeURIComponent(id)}/permissions/${p.id}`);
    }
  }

  async startUpload(meta: { name: string; parents: string[]; mimeType?: string; modifiedTime?: string }, size: number, replace?: string): Promise<string> {
    // A new revision keeps the file's id, place, links and comments; parents may not be sent then.
    const body = replace ? { ...(meta.modifiedTime ? { modifiedTime: meta.modifiedTime } : {}) } : meta;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(replace ? `${UPLOAD}/files/${encodeURIComponent(replace)}?uploadType=resumable&fields=id,name,size,parents` : `${UPLOAD}/files?uploadType=resumable&fields=id,name,size,parents`, {
        method: replace ? 'PATCH' : 'POST',
        headers: {
          authorization: `Bearer ${await this.token()}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(size),
          ...(meta.mimeType ? { 'x-upload-content-type': meta.mimeType } : {}),
        },
        body: JSON.stringify(body),
      });
      const url = res.headers.get('location');
      if (res.ok && url) return url;
      if (res.status === 401 && attempt < 1) { this.dropToken(); continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise((r) => setTimeout(r, 800 * 2 ** attempt)); continue; }
      const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new DriveFail(res.status, e.error?.message ?? `Drive answered ${res.status}`);
    }
  }

  async mediaUrl(f: DFile): Promise<string> {
    // With the media worker in charge, originals come through its cache (fetched once, kept).
    if (navigator.serviceWorker?.controller) { await this.token(); return originalUrl(f); }
    const res = await fetch(`${API}/files/${encodeURIComponent(f.id)}?alt=media`, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (!res.ok) throw new DriveFail(res.status, `Could not load ${f.name} (${res.status})`);
    return URL.createObjectURL(await res.blob());
  }

  streamUrl(f: DFile): string {
    return `/__media/${encodeURIComponent(f.id)}?size=${bytesOf(f)}`;
  }
}

// ─── the media service worker: lets <video> stream Drive files with our token ─────────────

let swReady: Promise<ServiceWorkerRegistration | null> | null = null;
let lastToken = '';
/** Set by the Drive client: the media worker asks it for a token (a new one when Google refused the old). */
let tokenSource: ((fresh: boolean) => Promise<string>) | null = null;
export const setTokenSource = (fn: (fresh: boolean) => Promise<string>) => { tokenSource = fn; };

export function startMediaWorker(): Promise<ServiceWorkerRegistration | null> {
  swReady ??= ('serviceWorker' in navigator
    ? navigator.serviceWorker.register('/media-sw.js', { scope: '/' }).then(async (r) => {
      await navigator.serviceWorker.ready;
      navigator.serviceWorker.addEventListener('message', async (e) => {
        if (e.data?.type !== 'need-token' || !e.ports[0]) return;
        const fresh = e.data.stale && e.data.stale === lastToken;
        if (fresh) forgetDriveToken();
        e.ports[0].postMessage({ token: tokenSource ? await tokenSource(!!fresh).catch(() => lastToken) : lastToken });
      });
      return r;
    }).catch(() => null)
    : Promise.resolve(null));
  return swReady;
}

function postToken(token: string) {
  lastToken = token;
  navigator.serviceWorker?.controller?.postMessage({ type: 'token', token });
}

// ─── helpers ──────────────────────────────────────────────────────────────

export const isFolder = (f: Pick<DFile, 'mimeType'>) => f.mimeType === FOLDER_MIME;
export const isImage = (f: Pick<DFile, 'mimeType'>) => f.mimeType.startsWith('image/');
export const isVideo = (f: Pick<DFile, 'mimeType'>) => f.mimeType.startsWith('video/');
export const isAudio = (f: Pick<DFile, 'mimeType'>) => f.mimeType.startsWith('audio/');
export const isPdf = (f: Pick<DFile, 'mimeType'>) => f.mimeType === 'application/pdf';
export const isMedia = (f: Pick<DFile, 'mimeType'>) => isImage(f) || isVideo(f);
export const bytesOf = (f: Pick<DFile, 'size' | 'quotaBytesUsed'>) => Number(f.size ?? f.quotaBytesUsed ?? 0);

/** A sharper thumbnail: Drive's links end in `=s220`; ask for the size we draw. */
export function thumb(f: DFile, px: number): string | undefined {
  if (!f.thumbnailLink) return undefined;
  const link = f.thumbnailLink.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${Math.round(px)}`);
  if (link.startsWith('data:') || !navigator.serviceWorker?.controller) return link;
  // Through the media worker: cached by file, size and version; an expired link is renewed there.
  return `/__thumb/${encodeURIComponent(f.id)}?s=${Math.round(px)}&v=${encodeURIComponent(f.modifiedTime ?? '')}&u=${encodeURIComponent(link)}`;
}

/** An original file through the media worker's cache (keyed by file and version). */
export const originalUrl = (f: DFile) => `/__orig/${encodeURIComponent(f.id)}?v=${encodeURIComponent(f.modifiedTime ?? '')}&size=${bytesOf(f)}`;

export function kindOf(f: Pick<DFile, 'mimeType' | 'name'>): string {
  const m = f.mimeType;
  if (m === FOLDER_MIME) return 'Folder';
  if (m.startsWith('image/')) return 'Image';
  if (m.startsWith('video/')) return 'Video';
  if (m.startsWith('audio/')) return 'Audio';
  if (m === 'application/pdf') return 'PDF';
  if (m.includes('google-apps.document')) return 'Google Doc';
  if (m.includes('google-apps.spreadsheet')) return 'Google Sheet';
  if (m.includes('google-apps.presentation')) return 'Google Slides';
  if (/zip|compressed|tar|rar|7z/.test(m)) return 'Archive';
  if (m.startsWith('text/')) return 'Text';
  const ext = /\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1];
  return ext ? ext.toUpperCase() : 'File';
}

export const driveLink = (f: DFile) => f.webViewLink ?? (isFolder(f) ? `https://drive.google.com/drive/folders/${f.id}` : `https://drive.google.com/file/d/${f.id}/view`);

export function duration(ms?: string | number): string {
  const s = Math.round(Number(ms ?? 0) / 1000);
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function ago(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso);
  const d = (Date.now() - t.getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export const failText = (e: unknown) => (e instanceof DriveFail ? e.message : errorText(e));
