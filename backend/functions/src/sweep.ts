// Linked accounts: files they drop into a share's Drive folder start out in THEIR Drive (and
// their quota). Google lets only a file's current owner offer it to someone else, so the sweep
// uses the linked account's token to offer each file to the share owner (pendingOwner), then the
// owner's token to accept it. After that the file counts against the owner's storage only.
import { Drive, DriveError, pool, sizeOf, type DriveFile } from './drive.ts';

export interface LinkedAccount {
  email: string;
  drive: Drive;
}
export interface SweepInput {
  folderId: string;
  ownerEmail: string;
  capBytes: number;
  usedBytes: number;
  owner: Drive;
  linked: LinkedAccount[];
  /** Stop starting new hand-overs after this time (ms since epoch); the rest waits for the next run. */
  deadline?: number;
  /** Hand-overs at a time. */
  parallel?: number;
  /** Called with each batch of finished items, so a run that is cut off still keeps what it did. */
  onProgress?: (items: SweepItem[]) => Promise<void>;
  /** Items per onProgress call. */
  flushEvery?: number;
}
export interface SweepItem {
  id: string;
  name: string;
  size: number;
  from: string;
  state: 'moved' | 'over-cap' | 'failed';
  error?: string;
}
export interface SweepResult {
  items: SweepItem[];
  usedBytes: number;
  /** Accounts we could not read the folder with (revoked access, removed from the folder…). */
  errors: string[];
  /** Files still waiting because the time ran out (0 = all done). */
  left: number;
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const isFolder = (f: DriveFile) => f.mimeType === 'application/vnd.google-apps.folder';

/**
 * Hand one file from `from` to `ownerEmail`. With the owner's `permissionId` (the same on every
 * file) the common case is two calls: offer on the permission the owner already has through the
 * share folder, then accept. Anything unexpected falls back to listing the file's permissions.
 */
export async function handOver(file: DriveFile, from: Drive, owner: Drive, ownerEmail: string, ownerPermId?: string): Promise<void> {
  if (ownerPermId) {
    let offered = false;
    try {
      await from.updatePermission(file.id, ownerPermId, { role: 'writer', pendingOwner: true });
      offered = true;
    } catch (e) {
      if (!(e instanceof DriveError) || e.status === 401) throw e;
    }
    if (offered) return void (await owner.updatePermission(file.id, ownerPermId, { role: 'owner' }, true));
  }
  const perms = await from.permissions(file.id);
  let p = perms.find((x) => x.type === 'user' && same(x.emailAddress, ownerEmail));
  if (!p) p = await from.addPermission(file.id, { type: 'user', role: 'writer', emailAddress: ownerEmail });
  if (!p.pendingOwner) {
    try {
      p = await from.updatePermission(file.id, p.id, { role: p.role === 'owner' ? 'owner' : 'writer', pendingOwner: true });
    } catch (e) {
      // An inherited permission (from the share folder) can't always be edited on the file: add a direct one.
      if (!(e instanceof DriveError) || e.status === 401) throw e;
      p = await from.addPermission(file.id, { type: 'user', role: 'writer', emailAddress: ownerEmail });
      p = await from.updatePermission(file.id, p.id, { role: 'writer', pendingOwner: true });
    }
  }
  await owner.updatePermission(file.id, p.id, { role: 'owner' }, true);
}

export async function sweepShare(input: SweepInput): Promise<SweepResult> {
  const { deadline = Infinity, parallel = 10, flushEvery = 25 } = input;
  const items: SweepItem[] = [];
  const errors: string[] = [];
  let pending: SweepItem[] = [];
  let used = input.usedBytes;
  let left = 0;
  // The owner's permission id is the same on every file: one call saves one per file.
  const ownerPermId = await input.owner.about().then((a) => a.user?.permissionId).catch(() => undefined);

  const record = async (i: SweepItem) => {
    items.push(i);
    pending.push(i);
    if (pending.length >= flushEvery && input.onProgress) {
      const out = pending;
      pending = [];
      await input.onProgress(out);
    }
  };

  for (const acc of input.linked) {
    let files: DriveFile[];
    try {
      await acc.drive.get(input.folderId); // 404 when the account was removed from the folder
      files = await acc.drive.walk(input.folderId, { deadline });
    } catch (e) {
      errors.push(`${acc.email}: ${(e as Error).message}`);
      continue;
    }
    const mine = files.filter((f) => same(f.owners?.[0]?.emailAddress, acc.email));
    // Files first (they are what uses storage), biggest first so each run frees the most of the
    // sender's storage (a file that no longer fits under the cap is skipped, smaller ones still go);
    // then the folders themselves (no storage, but then the whole tree is yours).
    const folders = mine.filter(isFolder);
    const plain = mine.filter((f) => !isFolder(f)).sort((a, b) => sizeOf(b) - sizeOf(a));

    const one = async (f: DriveFile) => {
      if (Date.now() > deadline) { left++; return; }
      const size = sizeOf(f);
      const base = { id: f.id, name: f.name, size, from: acc.email };
      if (size > 0 && used + size > input.capBytes) return record({ ...base, state: 'over-cap' });
      used += size; // held while the hand-over runs, so parallel ones can't overshoot the cap
      try {
        await handOver(f, acc.drive, input.owner, input.ownerEmail, ownerPermId);
        await record({ ...base, state: 'moved' });
      } catch (e) {
        used -= size;
        await record({ ...base, state: 'failed', error: (e as Error).message.slice(0, 300) });
      }
    };
    await pool(plain, parallel, one);
    await pool(folders, parallel, one);
  }
  if (pending.length && input.onProgress) await input.onProgress(pending);
  return { items, usedBytes: used, errors, left };
}
