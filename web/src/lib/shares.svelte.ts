import { collection, limit, onSnapshot, orderBy, query, where, type Timestamp } from '@panth977/icebase/firestore';
import { shares, transfers, uploads } from '@driveshare/backend/schema';
import { db } from './icebase.ts';

export interface ShareView {
  id: string;
  name: string;
  folderId: string;
  capBytes: number;
  maxFileBytes: number;
  usedBytes: number;
  reservedBytes: number;
  fileCount: number;
  enabled: boolean;
  uploadLink: boolean;
  secret: string;
  passwordHash?: string;
  publicView: boolean;
  linkedEmails: string[];
  createdAt?: Timestamp;
  lastSync?: Timestamp;
  lastSweep?: Timestamp;
  lastError?: string;
}

/** The owner's shares, live. */
export function watchShares(uid: string, next: (list: ShareView[]) => void, error: (e: Error) => void): () => void {
  return onSnapshot(query(collection(db, shares), where('ownerUid', '==', uid)), (s) => {
    next(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ShareView, 'id'>) })).sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0)));
  }, error);
}

export function watchUploads(shareId: string, next: (list: { id: string; name: string; size: number; state: string; by?: string; createdAt: Timestamp }[]) => void): () => void {
  return onSnapshot(query(collection(db, uploads, shareId), orderBy('createdAt', 'desc'), limit(15)), (s) => next(s.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as never)));
}

export function watchTransfers(shareId: string, next: (list: { id: string; name: string; size: number; state: string; from: string; error?: string; at: Timestamp }[]) => void): () => void {
  return onSnapshot(query(collection(db, transfers, shareId), orderBy('at', 'desc'), limit(15)), (s) => next(s.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as never)));
}

export const uploadUrl = (s: Pick<ShareView, 'id' | 'secret'>) => `${location.origin}/s/${s.id}#${s.secret}`;
export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;
export const when = (t?: Timestamp) => (t ? t.toDate().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
