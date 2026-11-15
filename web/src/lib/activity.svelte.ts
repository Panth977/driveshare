// Background actions. Bin, star, rotate, comment… change the screen at once and save to Drive in
// the background, several at a time, so you can carry on (next photo, another rotate) while they
// finish. A failure puts the screen back (the caller's `undo`) and says so.
import { BgQueue } from './bgqueue.ts';
import { failText } from './gdrive.ts';
import { toast } from './toast.svelte.ts';

class Activity {
  /** Actions waiting or running. */
  pending = $state(0);
  private q = new BgQueue(4, (label, e) => toast.show(`${label} did not work: ${failText(e)}`), (n) => (this.pending = n));

  constructor() {
    // Closing the tab while something is still saving: let the browser ask first.
    addEventListener('beforeunload', (e) => { if (this.pending) e.preventDefault(); });
  }

  /** Run `fn` in the background. Resolves true when it worked, false when it failed (after `undo`). */
  run(label: string, fn: () => Promise<unknown>, undo?: () => void): Promise<boolean> {
    return this.q.run(label, fn, undo);
  }
}

export const activity = new Activity();
