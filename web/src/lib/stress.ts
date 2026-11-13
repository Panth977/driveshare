// Dev only (`?demo` on the Vite server): a synthetic local folder of any size and an in-memory Drive
// with latency and optional rate limits, to load-test the transfer engine without a real Drive.
import { FOLDER_MIME, DriveFail, type DFile, type DriveApi } from './gdrive.ts';
import type { LocalDir } from './localfs.ts';

/** `files` files, `perDir` per directory, directories nested 3 deep. */
export function synthDir(files: number, perDir = 400, name = 'stress'): LocalDir {
  const dirs = Math.ceil(files / perDir);
  const fan = Math.max(2, Math.ceil(Math.cbrt(dirs)));
  const blob = new Uint8Array(1000);
  const leaf = (index: number): LocalDir => ({
    kind: 'dir', name: `d${index}`,
    async *entries() {
      const from = index * perDir, to = Math.min(files, from + perDir);
      for (let i = from; i < to; i++) yield { kind: 'file', name: `f${i}.jpg`, file: async () => new File([blob], `f${i}.jpg`, { type: 'image/jpeg', lastModified: 1_700_000_000_000 }) };
    },
  });
  const level = (depth: number, base: number, span: number): LocalDir => ({
    kind: 'dir', name: depth === 0 ? name : `g${base}`,
    async *entries() {
      if (span <= fan) { for (let i = base; i < Math.min(dirs, base + span); i++) yield leaf(i); return; }
      const step = Math.ceil(span / fan);
      for (let b = base; b < Math.min(dirs, base + span); b += step) yield level(depth + 1, b, step);
    },
  });
  return level(0, 0, dirs);
}

export class StressDrive implements DriveApi {
  readonly demo = false;
  private kids = new Map<string, DFile[]>();
  private n = 0;
  writes = 0;
  constructor(public latency = 3, public rateLimit = 0) { this.kids.set('root', []); }
  private wait() { return new Promise((r) => setTimeout(r, this.latency * (0.5 + Math.random()))); }
  private limit() { if (this.rateLimit && Math.random() < this.rateLimit) throw new DriveFail(429, 'Rate limit (simulated)', 'rateLimitExceeded'); }
  async token() { return 'stress'; }
  async about() { return { email: 'stress@example.com', quota: {} }; }
  async children(id: string) { await this.wait(); return [...(this.kids.get(id) ?? [])]; }
  async query() { return []; }
  async get(id: string): Promise<DFile> { return { id, name: id, mimeType: FOLDER_MIME }; }
  async everything() {}
  async startPageToken() { return '1'; }
  async changes() { return { changes: [], next: '1', done: true }; }
  async createFolder(name: string, parent: string) {
    await this.wait(); this.limit();
    const f: DFile = { id: `s${++this.n}`, name, mimeType: FOLDER_MIME, parents: [parent] };
    this.kids.set(parent, [...(this.kids.get(parent) ?? []), f]);
    this.kids.set(f.id, []);
    return f;
  }
  async update(id: string): Promise<DFile> { return this.get(id); }
  async comments() { return []; }
  async addComment(): Promise<never> { throw new Error('no'); }
  async permissions() { return []; }
  async shareAnyone() { return ''; }
  async unshareAnyone() {}
  async startUpload(): Promise<string> { throw new Error('stress files are small'); }
  async uploadSmall(meta: { name: string; parents: string[]; mimeType?: string }, file: Blob, replace?: string): Promise<DFile> {
    await this.wait(); this.limit();
    this.writes++;
    if (replace) return { id: replace, name: meta.name, mimeType: meta.mimeType ?? '', size: String(file.size) };
    const f: DFile = { id: `s${++this.n}`, name: meta.name, mimeType: meta.mimeType ?? 'application/octet-stream', size: String(file.size), parents: meta.parents };
    const list = this.kids.get(meta.parents[0]!) ?? [];
    list.push(f);
    this.kids.set(meta.parents[0]!, list);
    return f;
  }
  async mediaUrl() { return ''; }
  streamUrl() { return ''; }
}
