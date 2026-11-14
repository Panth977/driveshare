// Send to TV. A phone or laptop writes one small doc under the account (users/{uid}/remote/now);
// the account's TV app watches it and opens what was sent. Firestore only: no function runs, a
// send costs one write and one read on the TV.
import { collection, doc, onSnapshot, serverTimestamp, setDoc } from '@panth977/icebase/firestore';
import { remote } from '@driveshare/backend/schema';
import { auth, db } from './icebase.ts';

export interface TvItem { kind: 'folder' | 'show' | 'file'; folderId: string; fileId?: string; name: string }

const now = () => doc(collection(db, remote, auth.currentUser?.uid ?? '-'), 'now');

export async function sendToTv(item: TvItem): Promise<void> {
  if (!auth.currentUser) throw new Error('Sign in first');
  await setDoc(now(), {
    kind: item.kind, folderId: item.folderId, ...(item.fileId ? { fileId: item.fileId } : {}),
    name: item.name.slice(0, 300), nonce: crypto.randomUUID().slice(0, 36), at: serverTimestamp(),
  } as never);
}

/** On the TV: call `open` for every send made after it started listening. */
export function watchSends(open: (item: TvItem) => void): () => void {
  let last: string | null = null;
  return onSnapshot(now(), (s) => {
    const d = s.data() as (TvItem & { nonce: string }) | undefined;
    if (!d) { last = ''; return; }
    if (last === null) { last = d.nonce; return; } // what was there before the TV started
    if (d.nonce === last) return;
    last = d.nonce;
    open(d);
  }, () => {});
}

/** Follow mode in the viewer: the TV shows what this screen shows. */
class Follow {
  on = $state(false);
  toggle() { this.on = !this.on; }
}
export const follow = new Follow();
