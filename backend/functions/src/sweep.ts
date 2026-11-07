// Linked accounts: files they drop into a share's Drive folder start out in THEIR Drive (and
// their quota). Google lets only a file's current owner offer it to someone else, so the sweep
// uses the linked account's token to offer each file to the share owner (pendingOwner), then the
// owner's token to accept it. After that the file counts against the owner's storage only.
import { Drive, DriveError, sizeOf, type DriveFile } from './drive.ts';

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
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Hand one file from `from` to `ownerEmail`. Returns the permission id used. */
export async function handOver(file: DriveFile, from: Drive, owner: Drive, ownerEmail: string): Promise<void> {
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
  const items: SweepItem[] = [];
  const errors: string[] = [];
  let used = input.usedBytes;
  for (const acc of input.linked) {
    let files: DriveFile[];
    try {
      await acc.drive.get(input.folderId); // 404 when the account was removed from the folder
      files = await acc.drive.walk(input.folderId);
    } catch (e) {
      errors.push(`${acc.email}: ${(e as Error).message}`);
      continue;
    }
    // Folders first (so a moved file's folder is the owner's too), then small files before big ones.
    const mine = files
      .filter((f) => same(f.owners?.[0]?.emailAddress, acc.email))
      .sort((a, b) => Number(b.mimeType.endsWith('.folder')) - Number(a.mimeType.endsWith('.folder')) || sizeOf(a) - sizeOf(b));
    for (const f of mine) {
      const size = sizeOf(f);
      const base = { id: f.id, name: f.name, size, from: acc.email };
      if (size > 0 && used + size > input.capBytes) {
        items.push({ ...base, state: 'over-cap' });
        continue;
      }
      try {
        await handOver(f, acc.drive, input.owner, input.ownerEmail);
        used += size;
        items.push({ ...base, state: 'moved' });
      } catch (e) {
        items.push({ ...base, state: 'failed', error: (e as Error).message.slice(0, 300) });
      }
    }
  }
  return { items, usedBytes: used, errors };
}
