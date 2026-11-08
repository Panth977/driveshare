import { describe, expect, it } from 'vitest';
import { Drive } from '../backend/functions/src/drive.ts';
import { sweepShare } from '../backend/functions/src/sweep.ts';
import { FakeDrive } from './fake-drive.ts';

const OWNER = 'owner@gmail.com';
const ALT = 'alt@gmail.com';
const GB = 1024 ** 3;

function setup() {
  const fd = new FakeDrive();
  const folder = fd.add(OWNER, { name: 'Share', mimeType: 'application/vnd.google-apps.folder' });
  fd.share(folder.id, ALT);
  const owner = new Drive(OWNER, fd.fetch);
  const alt = new Drive(ALT, fd.fetch);
  return { fd, folder, owner, alt };
}

describe('sweepShare', () => {
  it('moves a linked account file into the owner quota', async () => {
    const { fd, folder, owner, alt } = setup();
    fd.add(ALT, { name: 'video.mp4', size: 3 * GB, parents: [folder.id] });
    expect(fd.quota(ALT)).toBe(3 * GB);
    const r = await sweepShare({ folderId: folder.id, ownerEmail: OWNER, capBytes: 10 * GB, usedBytes: 0, owner, linked: [{ email: ALT, drive: alt }] });
    expect(r.items.map((i) => i.state)).toEqual(['moved']);
    expect(r.usedBytes).toBe(3 * GB);
    expect(fd.quota(ALT)).toBe(0);
    expect(fd.quota(OWNER)).toBe(3 * GB);
  });

  it('leaves files over the cap with the sender and moves the rest, big first', async () => {
    const { fd, folder, owner, alt } = setup();
    fd.add(ALT, { name: 'big', size: 8 * GB, parents: [folder.id] });
    fd.add(ALT, { name: 'small', size: 1 * GB, parents: [folder.id] });
    const r = await sweepShare({ folderId: folder.id, ownerEmail: OWNER, capBytes: 5 * GB, usedBytes: 2 * GB, owner, linked: [{ email: ALT, drive: alt }] });
    expect(Object.fromEntries(r.items.map((i) => [i.name, i.state]))).toEqual({ small: 'moved', big: 'over-cap' });
    expect(r.usedBytes).toBe(3 * GB);
    expect(fd.quota(ALT)).toBe(8 * GB);
  });

  it('walks subfolders and moves the files, then the folders', async () => {
    const { fd, folder, owner, alt } = setup();
    const sub = fd.add(ALT, { name: 'trip', mimeType: 'application/vnd.google-apps.folder', parents: [folder.id] });
    fd.add(ALT, { name: 'a.jpg', size: 5_000_000, parents: [sub.id] });
    const r = await sweepShare({ folderId: folder.id, ownerEmail: OWNER, capBytes: GB, usedBytes: 0, owner, linked: [{ email: ALT, drive: alt }] });
    expect(r.items.map((i) => [i.name, i.state])).toEqual([['a.jpg', 'moved'], ['trip', 'moved']]);
    expect(fd.files.get(sub.id)!.owner).toBe(OWNER);
    expect(fd.quota(ALT)).toBe(0);
  });

  it('ignores files the owner already owns and files of other people', async () => {
    const { fd, folder, owner, alt } = setup();
    fd.add(OWNER, { name: 'mine', size: 100, parents: [folder.id] });
    fd.share(folder.id, 'stranger@gmail.com');
    fd.add('stranger@gmail.com', { name: 'theirs', size: 100, parents: [folder.id] });
    const r = await sweepShare({ folderId: folder.id, ownerEmail: OWNER, capBytes: GB, usedBytes: 0, owner, linked: [{ email: ALT, drive: alt }] });
    expect(r.items).toEqual([]);
  });

  it('finishes a hand-over that was offered but not accepted', async () => {
    const { fd, folder, owner, alt } = setup();
    const f = fd.add(ALT, { name: 'half', size: 10, parents: [folder.id] });
    await alt.addPermission(f.id, { type: 'user', role: 'writer', emailAddress: OWNER });
    await alt.updatePermission(f.id, 'p_owner_gmail_com', { role: 'writer', pendingOwner: true });
    const r = await sweepShare({ folderId: folder.id, ownerEmail: OWNER, capBytes: GB, usedBytes: 0, owner, linked: [{ email: ALT, drive: alt }] });
    expect(r.items[0]!.state).toBe('moved');
    expect(fd.files.get(f.id)!.owner).toBe(OWNER);
  });

  it('reports an account that lost access instead of failing the sweep', async () => {
    const { fd, folder, owner } = setup();
    const gone = new Drive('gone@gmail.com', fd.fetch);
    const r = await sweepShare({ folderId: folder.id, ownerEmail: OWNER, capBytes: GB, usedBytes: 0, owner, linked: [{ email: 'gone@gmail.com', drive: gone }] });
    expect(r.items).toEqual([]);
    expect(r.errors[0]).toMatch(/gone@gmail.com/);
  });
});

describe('big trees', () => {
  it('walks many folders with few Drive calls', async () => {
    const { fd, folder, alt } = setup();
    let parents = [folder.id];
    for (let depth = 0; depth < 3; depth++) {
      const next: string[] = [];
      for (const p of parents) for (let k = 0; k < 10; k++) next.push(fd.add(ALT, { name: `d${depth}-${k}`, mimeType: 'application/vnd.google-apps.folder', parents: [p] }).id);
      parents = next;
    }
    for (const p of parents) fd.add(ALT, { name: 'x.jpg', size: 10, parents: [p] });
    fd.calls.length = 0;
    const all = await alt.walk(folder.id);
    expect(all.length).toBe(1110 + 1000);
    expect(fd.calls.length).toBeLessThan(60); // 1 + 1 + 3 + 25 + 25 queries instead of 1,111
  });

  it('stops at the deadline, keeps what it did, and reports what is left', async () => {
    const { fd, folder, owner, alt } = setup();
    for (let k = 0; k < 30; k++) fd.add(ALT, { name: `f${k}`, size: 1, parents: [folder.id] });
    const saved: string[] = [];
    let calls = 0;
    const slow = new Drive(ALT, async (u, i) => { if (++calls > 40) await new Promise((r) => setTimeout(r, 30)); return fd.fetch(u, i); });
    const r = await sweepShare({
      folderId: folder.id, ownerEmail: OWNER, capBytes: GB, usedBytes: 0, owner, linked: [{ email: ALT, drive: slow }],
      deadline: Date.now() + 150, flushEvery: 5, onProgress: async (items) => { saved.push(...items.map((i) => i.name)); },
    });
    expect(r.left).toBeGreaterThan(0);
    expect(r.items.length + r.left).toBe(30);
    expect(saved.length).toBe(r.items.length);
    expect(r.items.every((i) => i.state === 'moved')).toBe(true);
    expect(fd.quota(OWNER)).toBe(r.items.length);
    void alt;
  });

  it('never goes over the cap with parallel hand-overs', async () => {
    const { fd, folder, owner, alt } = setup();
    for (let k = 0; k < 20; k++) fd.add(ALT, { name: `f${k}`, size: 100, parents: [folder.id] });
    const r = await sweepShare({ folderId: folder.id, ownerEmail: OWNER, capBytes: 1050, usedBytes: 0, owner, linked: [{ email: ALT, drive: alt }], parallel: 8 });
    expect(r.items.filter((i) => i.state === 'moved').length).toBe(10);
    expect(r.items.filter((i) => i.state === 'over-cap').length).toBe(10);
    expect(fd.quota(OWNER)).toBe(1000);
  });
});
