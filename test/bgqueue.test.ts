import { describe, expect, it } from 'vitest';
import { BgQueue } from '../web/src/lib/bgqueue.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('background actions', () => {
  it('runs up to N at once and the rest after', async () => {
    let now = 0, peak = 0;
    const counts: number[] = [];
    const q = new BgQueue(3, () => {}, (n) => counts.push(n));
    const job = () => async () => { now++; peak = Math.max(peak, now); await wait(10); now--; };
    const all = await Promise.all(Array.from({ length: 10 }, () => q.run('x', job())));
    expect(all.every(Boolean)).toBe(true);
    expect(peak).toBe(3);
    expect(counts.at(-1)).toBe(0);
    expect(Math.max(...counts)).toBe(10);
  });

  it('a failure undoes, reports, and does not stop the others', async () => {
    const failed: string[] = [];
    let undone = 0, ok = 0;
    const q = new BgQueue(2, (label) => failed.push(label));
    const r = await Promise.all([
      q.run('a', async () => { await wait(5); ok++; }),
      q.run('b', async () => { throw new Error('boom'); }, () => undone++),
      q.run('c', async () => { ok++; }),
    ]);
    expect(r).toEqual([true, false, true]);
    expect(failed).toEqual(['b']);
    expect(undone).toBe(1);
    expect(ok).toBe(2);
  });

  it('a job that throws at once (not async) is still caught', async () => {
    const q = new BgQueue(1, () => {});
    expect(await q.run('sync', () => { throw new Error('x'); })).toBe(false);
  });
});
