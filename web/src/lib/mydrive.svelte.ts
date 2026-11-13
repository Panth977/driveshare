// The "My Drive" session: which Drive we talk to, its root, the storage quota, and whether the owner
// still has to grant full Drive access.
import { RestDrive, failText, startMediaWorker, type DriveApi, type Quota } from './gdrive.ts';
import { errorText } from './icebase.ts';
import { sizes } from './sizes.svelte.ts';

export const demoMode = import.meta.env.DEV && new URLSearchParams(location.search).has('demo');

class MyDrive {
  drive = $state<DriveApi | null>(null);
  rootId = $state('');
  email = $state('');
  quota = $state<Quota>({});
  state = $state<'off' | 'loading' | 'ready' | 'needs-full' | 'error'>('off');
  error = $state('');

  async start(): Promise<void> {
    if (this.state === 'loading' || this.state === 'ready') return;
    this.state = 'loading';
    this.error = '';
    try {
      const d: DriveApi = demoMode ? new (await import('./demo.ts')).DemoDrive() : new RestDrive();
      await startMediaWorker();
      await d.token();
      const [about, root] = await Promise.all([d.about(), d.get('root')]);
      this.drive = d;
      this.email = about.email;
      this.quota = about.quota;
      this.rootId = root.id;
      this.state = 'ready';
      void sizes.start(d, about.email);
    } catch (e) {
      const t = errorText(e);
      if (/needs-full-drive|drive-not-connected/.test(t)) { this.state = 'needs-full'; return; }
      this.state = 'error';
      this.error = failText(e);
    }
  }

  async refreshQuota() {
    if (this.drive) this.quota = (await this.drive.about().catch(() => ({ quota: this.quota }))).quota;
  }

  reset() { this.state = 'off'; }
}

export const mydrive = new MyDrive();

// Dev-only load test: window.__dsStress(files, { latency, rateLimit }) syncs a synthetic folder into
// an in-memory Drive (twice in a row shows the "already in Drive" path).
if (demoMode) {
  (window as unknown as Record<string, unknown>).__dsStress = async (files: number, o: { latency?: number; rateLimit?: number; again?: boolean } = {}) => {
    const [{ StressDrive, synthDir }, { transfers }] = await Promise.all([import('./stress.ts'), import('./transfer.svelte.ts')]);
    const w = window as unknown as { __dsStressDrive?: InstanceType<typeof StressDrive> };
    const d = o.again && w.__dsStressDrive ? w.__dsStressDrive : (w.__dsStressDrive = new StressDrive(o.latency ?? 3, o.rateLimit ?? 0));
    d.latency = o.latency ?? d.latency; d.rateLimit = o.rateLimit ?? 0;
    transfers.sync(d, 'root', 'Stress Drive', synthDir(files));
  };
}
