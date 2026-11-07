// An in-memory Google Drive behind `fetch`, with the ownership rules the sweep depends on:
// only the owner may offer a file (pendingOwner), only the pending owner may accept it, and
// a file's bytes count against its owner's quota. The bearer token is the caller's email.
interface FFile { id: string; name: string; mimeType: string; size: number; parents: string[]; owner: string; appProperties: Record<string, string>; trashed: boolean }
interface FPerm { id: string; type: 'user' | 'anyone'; role: string; emailAddress?: string; pendingOwner?: boolean }

const permId = (email: string) => 'p_' + email.replace(/\W/g, '_');

export class FakeDrive {
  files = new Map<string, FFile>();
  perms = new Map<string, FPerm[]>();
  calls: string[] = [];
  private n = 0;

  add(owner: string, f: Partial<FFile> & { name: string }): FFile {
    const file: FFile = { id: `f${++this.n}`, mimeType: 'application/octet-stream', size: 0, parents: [], appProperties: {}, trashed: false, owner, ...f };
    this.files.set(file.id, file);
    this.perms.set(file.id, [{ id: permId(owner), type: 'user', role: 'owner', emailAddress: owner }]);
    return file;
  }
  share(id: string, email: string, role = 'writer') {
    this.perms.get(id)!.push({ id: permId(email), type: 'user', role, emailAddress: email });
  }
  quota(email: string): number {
    let n = 0;
    for (const f of this.files.values()) if (f.owner === email) n += f.size;
    return n;
  }

  /** Can `who` see the file: owner, a direct permission, or one on any ancestor folder. */
  private canSee(who: string, f: FFile): boolean {
    if (f.owner === who || this.perms.get(f.id)!.some((p) => p.emailAddress === who)) return true;
    return f.parents.some((pid) => { const p = this.files.get(pid); return !!p && this.canSee(who, p); });
  }

  private view(f: FFile) {
    return { id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.size), parents: f.parents, owners: [{ emailAddress: f.owner }], appProperties: f.appProperties, trashed: f.trashed };
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const who = String((init.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push(`${who} ${method} ${url.pathname}`);
    const json = (status: number, data: unknown) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const err = (status: number, message: string) => json(status, { error: { message, errors: [{ reason: 'x' }] } });
    const parts = url.pathname.replace('/drive/v3/', '').split('/');

    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]!);
      const prop = /key='(\w+)' and value='([^']*)'/.exec(q);
      const out = [...this.files.values()].filter((f) => !f.trashed && this.canSee(who, f) && (!parents.length || f.parents.some((p) => parents.includes(p))) && (!prop || f.appProperties[prop[1]!] === prop[2]));
      return json(200, { files: out.map((f) => this.view(f)) });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      return json(200, this.view(this.add(who, { name: body.name, mimeType: body.mimeType, parents: body.parents ?? [], appProperties: body.appProperties ?? {} })));
    }
    const f = this.files.get(decodeURIComponent(parts[1] ?? ''));
    if (!f || !this.canSee(who, f)) return err(404, 'File not found');
    if (parts.length === 2) {
      if (method === 'GET') return json(200, this.view(f));
      if (method === 'PATCH') { Object.assign(f, body); return json(200, this.view(f)); }
    }
    const list = this.perms.get(f.id)!;
    if (parts[2] === 'permissions' && parts.length === 3) {
      if (method === 'GET') return json(200, { permissions: list });
      if (method === 'POST') {
        if (f.owner !== who && !list.some((p) => p.emailAddress === who && p.role === 'writer')) return err(403, 'Insufficient permissions');
        const p: FPerm = { id: body.type === 'anyone' ? 'anyoneWithLink' : permId(body.emailAddress), type: body.type, role: body.role, ...(body.emailAddress ? { emailAddress: body.emailAddress } : {}) };
        const old = list.findIndex((x) => x.id === p.id);
        if (old >= 0) list[old] = { ...list[old], ...p }; else list.push(p);
        return json(200, p);
      }
    }
    const p = list.find((x) => x.id === decodeURIComponent(parts[3] ?? ''));
    if (!p) return err(404, 'Permission not found');
    if (method === 'DELETE') { list.splice(list.indexOf(p), 1); return json(204, null); }
    if (method === 'PATCH') {
      if (body.pendingOwner) {
        if (f.owner !== who) return err(403, 'Only the owner can offer ownership');
        p.pendingOwner = true;
        p.role = body.role;
        return json(200, p);
      }
      if (body.role === 'owner') {
        if (url.searchParams.get('transferOwnership') !== 'true') return err(400, 'transferOwnership required');
        if (p.emailAddress !== who || !p.pendingOwner) return err(403, 'The user is not a pending owner');
        const prev = list.find((x) => x.role === 'owner')!;
        prev.role = 'writer';
        p.role = 'owner';
        p.pendingOwner = false;
        f.owner = who;
        return json(200, p);
      }
      p.role = body.role;
      return json(200, p);
    }
    return err(400, `unhandled ${method} ${url.pathname}`);
  };
}
