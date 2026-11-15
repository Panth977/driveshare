// A small queue for background actions: at most `parallel` run at once, the rest wait their turn.
// A failing action runs its `undo` and is reported through `onFail`; run() never throws.
interface Job { label: string; fn: () => Promise<unknown>; undo?: () => void; done: (ok: boolean) => void }

export class BgQueue {
  private queue: Job[] = [];
  private running = 0;
  constructor(
    private readonly parallel: number,
    private readonly onFail: (label: string, e: unknown) => void,
    private readonly onCount: (pending: number) => void = () => {},
  ) {}
  private pending = 0;

  run(label: string, fn: () => Promise<unknown>, undo?: () => void): Promise<boolean> {
    this.onCount(++this.pending);
    return new Promise((done) => {
      this.queue.push({ label, fn, ...(undo ? { undo } : {}), done });
      this.pump();
    });
  }

  private pump() {
    while (this.running < this.parallel && this.queue.length) {
      const j = this.queue.shift()!;
      this.running++;
      Promise.resolve().then(j.fn).then(() => j.done(true), (e) => {
        try { j.undo?.(); } catch { /* ignore */ }
        this.onFail(j.label, e);
        j.done(false);
      }).finally(() => {
        this.running--;
        this.onCount(--this.pending);
        this.pump();
      });
    }
  }
}
