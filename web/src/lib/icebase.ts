// The only IceBase setup in the web app.
import { initializeApp } from '@panth977/icebase/app';
import { getAuth } from '@panth977/icebase/auth';
import { getFirestore } from '@panth977/icebase/firestore';
import { callable, getFunctions } from '@panth977/icebase/functions';
import config from '@driveshare/backend/config';
import { api } from '@driveshare/backend/api';

export const app = initializeApp(config, 'prod');
export const auth = getAuth(app);
export const db = getFirestore(app);
const fns = getFunctions(app);

export const googleSignIn = callable(fns, api.googleSignIn);
export const linkedShares = callable(fns, api.linkedShares);
export const createShare = callable(fns, api.createShare);
export const updateShare = callable(fns, api.updateShare);
export const deleteShare = callable(fns, api.deleteShare);
export const syncShare = callable(fns, api.syncShare);
export const sweepNow = callable(fns, api.sweepNow);
export const shareInfo = callable(fns, api.shareInfo);
export const startUpload = callable(fns, api.startUpload);
export const finishUpload = callable(fns, api.finishUpload);

/** A readable message from a callable error. */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^(FirebaseError|IceBaseError):\s*/, '').replace(/\s*\((functions|icebase)\/[\w-]+\)\.?$/, '');
}
export const errorCode = (e: unknown): string => String((e as { code?: string }).code ?? '').replace(/^functions\//, '');
