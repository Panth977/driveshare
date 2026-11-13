// Dev only (`?demo` on the Vite server): a made-up Drive in memory, so the views can be tried and
// screenshotted without a Google account. Never part of a production path (gated by import.meta.env.DEV).
import { FOLDER_MIME, type DComment, type DFile, type DPermission, type DriveApi } from './gdrive.ts';

const HUES = [12, 28, 42, 160, 190, 210, 260, 300, 330];
function art(seed: number, w: number, h: number, label: string): string {
  const a = HUES[seed % HUES.length]!, b = HUES[(seed * 7 + 3) % HUES.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a} 70% 55%)"/><stop offset="1" stop-color="hsl(${b} 60% 25%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${(seed * 97) % w}" cy="${(seed * 53) % h}" r="${Math.min(w, h) / 3}" fill="hsl(${b} 80% 75% / .35)"/>
<path d="M0 ${h * 0.72} Q ${w * 0.3} ${h * 0.55} ${w * 0.55} ${h * 0.7} T ${w} ${h * 0.62} V ${h} H 0 Z" fill="hsl(${a} 40% 12% / .55)"/>
<text x="${w * 0.05}" y="${h * 0.92}" font-family="system-ui" font-size="${Math.round(h / 16)}" fill="white" opacity=".8">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

let n = 0;
const id = () => `d${(++n).toString(36)}`;
const day = (d: number) => new Date(Date.UTC(2026, 9, 30) - d * 86400_000).toISOString();

export class DemoDrive implements DriveApi {
  readonly demo = true;
  private files = new Map<string, DFile>();
  private comm = new Map<string, DComment[]>();
  private perms = new Map<string, DPermission[]>();

  constructor() {
    this.files.set('root', { id: 'root', name: 'My Drive', mimeType: FOLDER_MIME });
    const folder = (name: string, parent: string, d = 3) => {
      const f: DFile = { id: id(), name, mimeType: FOLDER_MIME, parents: [parent], modifiedTime: day(d), createdTime: day(d + 20), ownedByMe: true };
      this.files.set(f.id, f);
      return f.id;
    };
    const photo = (name: string, parent: string, seed: number, mb: number, d: number) => {
      const fid = id();
      this.files.set(fid, {
        id: fid, name, mimeType: 'image/jpeg', size: String(Math.round(mb * 1024 * 1024)), parents: [parent], modifiedTime: day(d), createdTime: day(d),
        thumbnailLink: art(seed, 400, 300, ''), hasThumbnail: true, ownedByMe: true, imageMediaMetadata: { width: 4032, height: 3024, cameraModel: 'iPhone 15 Pro' },
      });
    };
    const video = (name: string, parent: string, seed: number, mb: number, d: number, secs: number) => {
      const fid = id();
      this.files.set(fid, {
        id: fid, name, mimeType: 'video/mp4', size: String(Math.round(mb * 1024 * 1024)), parents: [parent], modifiedTime: day(d), createdTime: day(d),
        thumbnailLink: art(seed + 50, 400, 225, '▶'), hasThumbnail: true, ownedByMe: true, videoMediaMetadata: { width: 3840, height: 2160, durationMillis: String(secs * 1000) },
      });
    };
    const doc = (name: string, parent: string, mime: string, kb: number, d: number) => {
      const fid = id();
      this.files.set(fid, { id: fid, name, mimeType: mime, size: String(kb * 1024), parents: [parent], modifiedTime: day(d), createdTime: day(d), ownedByMe: true });
    };

    const photos = folder('Photos', 'root', 1);
    const places = ['Goa', 'Ladakh', 'Kyoto', 'Lisbon', 'Udaipur', 'Munnar'];
    places.forEach((p, i) => {
      const f = folder(`${2019 + i} · ${p}`, photos, 2 + i * 30);
      for (let k = 0; k < 18 + i * 7; k++) photo(`IMG_${4100 + i * 100 + k}.JPG`, f, i * 31 + k, 2.4 + ((k * 13) % 9) / 3, 2 + i * 30 + k);
      for (let k = 0; k < 2 + (i % 3); k++) video(`VID_${7000 + i * 10 + k}.MP4`, f, i * 7 + k, 180 + k * 410, 3 + i * 30, 42 + k * 95);
    });
    const vids = folder('Family videos', 'root', 4);
    for (let k = 0; k < 9; k++) video(`Diwali ${2018 + k}.mp4`, vids, k * 3, 900 + k * 640, 300 - k * 30, 600 + k * 120);
    const work = folder('Work', 'root', 0);
    const proj = folder('KadhaiBot', work, 0);
    doc('Pitch deck.pdf', proj, 'application/pdf', 8400, 1);
    doc('Bill of materials', proj, 'application/vnd.google-apps.spreadsheet', 0, 2);
    doc('Arm firmware.zip', proj, 'application/zip', 52_000, 6);
    for (let k = 0; k < 6; k++) photo(`render-${k + 1}.png`, proj, 70 + k, 6.5, 3 + k);
    folder('Invoices', work, 12);
    const backups = folder('Backups', 'root', 40);
    doc('MacBook 2024.sparsebundle.tar', backups, 'application/x-tar', 412_000_000, 40);
    doc('Phone backup.zip', backups, 'application/zip', 96_000_000, 60);
    doc('Notes.txt', 'root', 'text/plain', 4, 0);
    doc('Passport scan.pdf', 'root', 'application/pdf', 1900, 120);
    this.comm.set([...this.files.values()].find((f) => f.name === 'IMG_4100.JPG')!.id, [
      { id: 'c1', content: 'Best one of the trip. Print this for the yearbook.', createdTime: day(1), author: { displayName: 'Panth', me: true } },
    ]);
  }

  async token() { return 'demo'; }
  async about() { return { email: 'demo@example.com', quota: { limit: String(5 * 1024 ** 4), usage: String(1.92 * 1024 ** 4), usageInDrive: String(1.87 * 1024 ** 4), usageInDriveTrash: String(3.1 * 1024 ** 3) } }; }
  private sort(list: DFile[], orderBy = 'folder,name_natural') {
    const byDate = orderBy.startsWith('modifiedTime');
    return list.sort((a, b) => (Number(b.mimeType === FOLDER_MIME) - Number(a.mimeType === FOLDER_MIME)) || (byDate ? String(b.modifiedTime).localeCompare(String(a.modifiedTime)) : a.name.localeCompare(b.name, undefined, { numeric: true })));
  }
  async children(folderId: string, o: { orderBy?: string } = {}) { await wait(); return this.sort([...this.files.values()].filter((f) => f.parents?.[0] === folderId && !f.trashed), o.orderBy); }
  async query(q: string, o: { orderBy?: string; max?: number } = {}) {
    await wait();
    let list = [...this.files.values()].filter((f) => f.id !== 'root' && !f.trashed);
    if (q.includes('anyoneWithLink')) list = list.filter((f) => this.perms.has(f.id));
    if (q.includes("mimeType contains 'image/'")) list = list.filter((f) => /^(image|video)\//.test(f.mimeType));
    if (q.includes('starred')) list = list.filter((f) => f.starred);
    if (q.includes("mimeType != 'application/vnd.google-apps.folder'")) list = list.filter((f) => f.mimeType !== FOLDER_MIME);
    const m = /name contains '([^']*)'/.exec(q);
    if (m) list = list.filter((f) => f.name.toLowerCase().includes(m[1]!.toLowerCase()));
    return this.sort(list, o.orderBy).slice(0, o.max ?? 1000);
  }
  async get(fid: string) { const f = this.files.get(fid); if (!f) throw new Error('Not found'); return { ...f }; }
  async everything(onPage: (files: DFile[]) => void) {
    const all = [...this.files.values()].filter((f) => f.id !== 'root' && !f.trashed);
    for (let i = 0; i < all.length; i += 60) { await wait(60); onPage(all.slice(i, i + 60)); }
  }
  async startPageToken() { return '1'; }
  async changes() { return { changes: [], next: '1' }; }
  async createFolder(name: string, parent: string) { const f: DFile = { id: id(), name, mimeType: FOLDER_MIME, parents: [parent], modifiedTime: new Date().toISOString(), ownedByMe: true }; this.files.set(f.id, f); return f; }
  async update(fid: string, patch: { name?: string; trashed?: boolean; starred?: boolean }) { const f = this.files.get(fid)!; Object.assign(f, patch); return { ...f }; }
  async comments(fid: string) { await wait(); return this.comm.get(fid) ?? []; }
  async addComment(fid: string, content: string) { const c = { id: id(), content, createdTime: new Date().toISOString(), author: { displayName: 'You', me: true } }; this.comm.set(fid, [...(this.comm.get(fid) ?? []), c]); return c; }
  async permissions(fid: string) { return this.perms.get(fid) ?? []; }
  async shareAnyone(fid: string) { this.perms.set(fid, [{ id: 'anyone', type: 'anyone', role: 'reader' }]); return `https://drive.google.com/file/d/${fid}/view?usp=sharing`; }
  async unshareAnyone(fid: string) { this.perms.delete(fid); }
  async startUpload(): Promise<string> { throw new Error('Uploads are off in the demo'); }
  async mediaUrl(f: DFile) { return art(f.name.length * 7 + f.id.length, 1600, 1200, f.name); }
  streamUrl() { return ''; }
}

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
