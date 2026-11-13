// The shares this account is linked to (the owner's folders it drops files into). Read once per
// session (one function call) and kept in localStorage, so the sidebar shows them at once.
import { account } from './account.svelte.ts';
import { linkedShares } from './icebase.ts';

export interface LinkedShare { name: string; folderId: string; folderUrl: string; ownerEmail: string; capBytes: number; usedBytes: number }

class Linked {
  list = $state<LinkedShare[] | null>(null);
  error = $state('');
  private loadedFor = '';

  load(): void {
    const u = account.user;
    if (!u || u.role !== 'linked' || this.loadedFor === u.uid) return;
    this.loadedFor = u.uid;
    const key = `ds.linked.${u.uid}`;
    try { this.list = JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { /* none */ }
    linkedShares({}).then((r) => {
      this.list = r.shares;
      localStorage.setItem(key, JSON.stringify(r.shares));
    }, (e) => (this.error = (e as Error).message));
  }
}
export const linked = new Linked();
