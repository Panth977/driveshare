// DriveShare functions. Bytes never pass through here: uploads go from the browser straight to
// Google (a resumable session opened with the owner's token), and the linked-account sweep only
// makes Drive API calls. Each upload costs two small function calls; the sweep one per schedule tick.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpsError, onCall, onSchedule } from '@panth977/icebase-server/functions';
import { getAdminAuth, getAdminFirestore, initializeAdminApp } from '@panth977/icebase-server/admin';
import {
  collection, deleteDoc, deleteField, doc, getDoc, getDocs, increment, limit, query, runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, where, writeBatch,
} from '@panth977/icebase/firestore';
import config from '../../icebase.config.ts';
import { api } from '../../icebase/api.ts';
import { drive, shares, transfers, tvLogins, uploads, users } from '../../icebase/schema.ts';
import { ORIGINS, REGION, deployment } from '../../deployment.ts';
import { DRIVE_FULL_SCOPE, RESERVE_MS, ROOT_FOLDER, cleanName, hasScope, room } from '../../shared.ts';
import { Drive, DriveError, folderUrl, sizeOf } from './drive.ts';
import { sweepShare, type SweepItem } from './sweep.ts';

const app = initializeAdminApp(config, (process.env.ICEBASE_ENV ?? 'prod') as 'local' | 'prod');
const db = getAdminFirestore(app);
const auth = getAdminAuth(app);

const SECRETS = ['GOOGLE_CLIENT_SECRET', 'TOKEN_KEY'];
const opts = { secrets: SECRETS, cors: ORIGINS, region: REGION };
const ADMINS = (process.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// ─── Google tokens ────────────────────────────────────────────────────────────

interface TokenResponse { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string; error?: string; error_description?: string }

async function googleToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: deployment.googleClientId, client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '', ...params }),
  });
  return (await res.json()) as TokenResponse;
}

/** Read straight from Google's token endpoint over TLS, so no signature check is needed. */
function idClaims(idToken: string): { sub: string; email: string; email_verified?: boolean; name?: string; picture?: string; aud: string } {
  return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

function key(): Buffer {
  const k = Buffer.from(process.env.TOKEN_KEY ?? '', 'base64');
  if (k.length !== 32) throw new HttpsError('internal', 'TOKEN_KEY is not set');
  return k;
}
function encrypt(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}
function decrypt(blob: string): string {
  const [iv, tag, body] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(body!), d.final()]).toString('utf8');
}

const driveDoc = (uid: string) => doc(collection(db, drive, uid), 'drive');
const userRef = (uid: string) => doc(collection(db, users), uid);
const shareRef = (id: string) => doc(collection(db, shares), id);

/** A fresh Google access token for this account (refresh token → access token). */
async function accessFor(uid: string): Promise<{ token: string; expiresIn: number; scope: string }> {
  const stored = (await getDoc(driveDoc(uid))).data() as { refreshToken?: string; scope?: string } | undefined;
  if (!stored?.refreshToken) throw new HttpsError('failed-precondition', 'drive-not-connected');
  const t = await googleToken({ refresh_token: decrypt(stored.refreshToken), grant_type: 'refresh_token' });
  if (t.error === 'invalid_grant') {
    await deleteDoc(driveDoc(uid));
    throw new HttpsError('failed-precondition', 'drive-not-connected');
  }
  if (!t.access_token) throw new HttpsError('unavailable', t.error_description ?? t.error ?? 'Google token refresh failed');
  return { token: t.access_token, expiresIn: t.expires_in ?? 3600, scope: t.scope ?? stored.scope ?? '' };
}

/** A Drive client acting as this account. */
async function driveFor(uid: string): Promise<Drive> {
  return new Drive((await accessFor(uid)).token);
}

// ─── who may do what ──────────────────────────────────────────────────────────

const isAdmin = (email?: string) => !!email && ADMINS.includes(email.toLowerCase());

function admin(req: { auth?: { uid: string; token: Record<string, unknown> } }): string {
  const email = req.auth?.token.email as string | undefined;
  if (!req.auth || !isAdmin(email)) throw new HttpsError('permission-denied', 'Only the owner of this DriveShare can do that.');
  return req.auth.uid;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Share = Record<string, any>;

const validId = (id: string) => /^[\w-]{1,64}$/.test(id);

async function ownShare(uid: string, shareId: string) {
  if (!validId(shareId)) throw new HttpsError('not-found', 'No such share');
  const snap = await getDoc(shareRef(shareId));
  const s = snap.data() as Share | undefined;
  if (!s || s.ownerUid !== uid) throw new HttpsError('not-found', 'No such share');
  return s;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/** The share behind an upload link, if the link is right and on. */
async function linkShare(shareId: string, secret: string) {
  if (!validId(shareId)) throw new HttpsError('not-found', 'The link is wrong or was turned off');
  const s = (await getDoc(shareRef(shareId))).data() as Share | undefined;
  if (!s || !s.enabled || !s.uploadLink || !sameSecret(s.secret, secret)) throw new HttpsError('not-found', 'The link is wrong or was turned off');
  return s;
}

function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('base64url')}.${scryptSync(pw, salt, 32).toString('base64url')}`;
}
function checkPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split('.');
  return sameSecret(scryptSync(pw, Buffer.from(salt!, 'base64url'), 32).toString('base64url'), hash!);
}

const now = () => Timestamp.now();
const newSecret = () => randomBytes(18).toString('base64url');

// ─── sign-in ──────────────────────────────────────────────────────────────────

export const googleSignIn = onCall(api.googleSignIn, opts, async (req) => {
  const redirectUri = req.data.redirectUri ?? 'postmessage';
  if (redirectUri !== 'postmessage' && !ORIGINS.some((o) => redirectUri === `${o}/auth/callback`)) throw new HttpsError('invalid-argument', 'Unknown redirect URI');
  const t = await googleToken({ code: req.data.code, grant_type: 'authorization_code', redirect_uri: redirectUri });
  if (!t.id_token || !t.access_token) throw new HttpsError('invalid-argument', t.error_description ?? t.error ?? 'Google rejected the code');
  const c = idClaims(t.id_token);
  if (c.aud !== deployment.googleClientId || !c.email || c.email_verified === false) throw new HttpsError('invalid-argument', 'ID token is not for this app');
  const email = c.email.toLowerCase();

  let role: 'admin' | 'linked';
  if (isAdmin(email)) role = 'admin';
  else if (!(await getDocs(query(collection(db, shares), where('linkedEmails', 'array-contains', email), limit(1)))).empty) role = 'linked';
  else throw new HttpsError('permission-denied', 'This DriveShare is private. If its owner added your Google account to a share, sign in again after they saved it.');

  const scope = t.scope ?? '';
  const level = hasScope(scope, 'full') && scope.split(' ').includes(DRIVE_FULL_SCOPE) ? 'full' : hasScope(scope, 'file') ? 'file' : null;
  if (!level) throw new HttpsError('permission-denied', 'Google did not give DriveShare access to your Drive. Sign in again and tick the Google Drive box.');
  // A linked account signs in with the small scope first (we don't know who it is yet); the app then asks for the full one.
  if (role === 'linked' && level !== 'full') throw new HttpsError('failed-precondition', 'needs-full-drive', { email });

  const uid = `google:${c.sub}`;
  await auth.getUser(uid).catch(() => auth.createUser({ uid, email, displayName: c.name, photoURL: c.picture, emailVerified: true }));
  const existing = (await getDoc(userRef(uid))).data() as { driveScope?: string } | undefined;

  let driveConnected: boolean;
  if (t.refresh_token) {
    await setDoc(driveDoc(uid), { refreshToken: encrypt(t.refresh_token), scope, updatedAt: serverTimestamp() } as never);
    driveConnected = true;
  } else {
    driveConnected = (await getDoc(driveDoc(uid))).exists();
  }
  // Keep the wider scope we already hold (include_granted_scopes keeps old grants on the token).
  const driveScope = level === 'full' || existing?.driveScope === 'full' ? 'full' : 'file';
  await setDoc(userRef(uid), {
    email, name: c.name ?? email, ...(c.picture ? { photo: c.picture } : {}), role, driveScope,
    lastLogin: serverTimestamp(), ...(existing ? {} : { createdAt: serverTimestamp() }),
  } as never, { merge: true });

  const token = await auth.createCustomToken(uid, { role });
  return { token, role, driveConnected, scope };
});

// ─── My Drive: the browser talks to Drive itself ──────────────────────────────

export const driveAccess = onCall(api.driveAccess, opts, async (req) => {
  // The owner, and linked accounts (verified when they signed in): each gets a token for their own Drive only.
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first');
  const email = req.auth.token.email as string | undefined;
  if (!isAdmin(email) && req.auth.token.role !== 'linked') throw new HttpsError('permission-denied', 'This DriveShare is private.');
  const uid = req.auth.uid;
  const a = await accessFor(uid);
  if (!a.scope.split(' ').includes(DRIVE_FULL_SCOPE)) throw new HttpsError('failed-precondition', 'needs-full-drive');
  return { accessToken: a.token, expiresAt: Date.now() + (a.expiresIn - 120) * 1000, email: String(req.auth!.token.email ?? '') };
});

// ─── TV sign-in: show a QR code, approve on the phone ────────────────────────

const TV_MS = 10 * 60 * 1000;
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const tvRef = (id: string) => doc(collection(db, tvLogins), id);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const tvStart = onCall(api.tvStart, opts, async (req) => {
  const origin = String(req.rawRequest.headers.origin ?? '');
  if (!ORIGINS.includes(origin)) throw new HttpsError('permission-denied', 'TV sign-in starts from the DriveShare site only');
  const ref = doc(collection(db, tvLogins));
  const secret = randomBytes(24).toString('base64url');
  const code = Array.from(randomBytes(4), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  const expiresAt = Date.now() + TV_MS;
  await setDoc(ref, {
    secretHash: sha(secret), code, state: 'waiting',
    ...(req.data.device ? { device: req.data.device.slice(0, 200) } : {}),
    createdAt: now(), expiresAt: Timestamp.fromMillis(expiresAt),
  } as never);
  return { id: ref.id, secret, code, expiresAt };
});

async function tvRequest(id: string, secret: string) {
  if (!validId(id)) return null;
  const t = (await getDoc(tvRef(id))).data() as { secretHash: string; code: string; state: string; device?: string; uid?: string; expiresAt: Timestamp } | undefined;
  if (!t || !sameSecret(t.secretHash, sha(secret))) return null;
  return t;
}

export const tvApprove = onCall(api.tvApprove, opts, async (req) => {
  // The owner or a linked account approves a TV for itself (the TV gets that account's own session).
  if (!req.auth || (!isAdmin(req.auth.token.email as string | undefined) && req.auth.token.role !== 'linked')) throw new HttpsError('permission-denied', 'This DriveShare is private.');
  const uid = req.auth.uid;
  const t = await tvRequest(req.data.id, req.data.secret);
  if (!t || t.state !== 'waiting' || t.expiresAt.toMillis() < Date.now()) throw new HttpsError('not-found', 'The QR code expired or was used; show a new one on the TV');
  await updateDoc(tvRef(req.data.id), { state: 'approved', uid, email: String(req.auth!.token.email ?? '') } as never);
  return { ok: true, code: t.code, ...(t.device ? { device: t.device } : {}) };
});

export const tvClaim = onCall(api.tvClaim, opts, async (req) => {
  const t = await tvRequest(req.data.id, req.data.secret);
  if (!t || t.expiresAt.toMillis() < Date.now()) return { state: 'expired' as const };
  if (t.state !== 'approved' || !t.uid) return { state: t.state as 'waiting' | 'used' };
  let won = false;
  await runTransaction(db, async (tx) => {
    const cur = (await tx.get(tvRef(req.data.id))).data() as { state: string } | undefined;
    if (cur?.state !== 'approved') return;
    tx.update(tvRef(req.data.id), { state: 'used' } as never);
    won = true;
  });
  if (!won) return { state: 'used' as const };
  const u = (await getDoc(userRef(t.uid))).data() as { role?: 'admin' | 'linked' } | undefined;
  return { state: 'approved' as const, token: await auth.createCustomToken(t.uid, { role: u?.role ?? 'admin' }) };
});

export const linkedShares = onCall(api.linkedShares, opts, async (req) => {
  const email = String(req.auth?.token.email ?? '').toLowerCase();
  if (!email) throw new HttpsError('unauthenticated', 'Sign in first');
  const snap = await getDocs(query(collection(db, shares), where('linkedEmails', 'array-contains', email)));
  return {
    shares: snap.docs.map((d) => d.data() as Share).filter((s) => s.enabled).map((s) => ({ name: s.name, folderId: s.folderId, folderUrl: folderUrl(s.folderId), ownerEmail: s.ownerEmail, capBytes: s.capBytes, usedBytes: s.usedBytes })),
  };
});

// ─── shares (owner) ───────────────────────────────────────────────────────────

/** The "DriveShare" folder at the top of the owner's Drive (made on first use). */
async function rootFolder(d: Drive): Promise<string> {
  const found = await d.list(`appProperties has { key='dsRoot' and value='1' } and trashed = false`);
  if (found[0]) return found[0].id;
  return (await d.createFolder(ROOT_FOLDER, undefined, { dsRoot: '1' })).id;
}

export const createShare = onCall(api.createShare, opts, async (req) => {
  const uid = admin(req);
  const d = await driveFor(uid);
  const ref = doc(collection(db, shares));
  const folder = await d.createFolder(cleanName(req.data.name), await rootFolder(d), { dsShare: ref.id });
  const pw = req.data.password?.trim();
  await setDoc(ref, {
    ownerUid: uid,
    ownerEmail: String(req.auth!.token.email).toLowerCase(),
    name: cleanName(req.data.name),
    folderId: folder.id,
    capBytes: req.data.capBytes,
    maxFileBytes: req.data.maxFileBytes ?? 0,
    usedBytes: 0, reservedBytes: 0, fileCount: 0,
    enabled: true, uploadLink: true, secret: newSecret(),
    ...(pw ? { passwordHash: hashPassword(pw) } : {}),
    publicView: false, linkedEmails: [], linked: false,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  } as never);
  return { shareId: ref.id, folderId: folder.id };
});

export const updateShare = onCall(api.updateShare, opts, async (req) => {
  const uid = admin(req);
  const s = await ownShare(uid, req.data.shareId);
  const x = req.data;
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  const warnings: string[] = [];
  if (x.name !== undefined) patch.name = cleanName(x.name);
  if (x.capBytes !== undefined) patch.capBytes = x.capBytes;
  if (x.maxFileBytes !== undefined) patch.maxFileBytes = x.maxFileBytes;
  if (x.enabled !== undefined) patch.enabled = x.enabled;
  if (x.uploadLink !== undefined) patch.uploadLink = x.uploadLink;
  if (x.rotateSecret) patch.secret = newSecret();
  if (x.password !== undefined) patch.passwordHash = x.password.trim() ? hashPassword(x.password.trim()) : deleteField();

  const needsDrive = x.name !== undefined || x.publicView !== undefined || x.linkedEmails !== undefined;
  const d = needsDrive ? await driveFor(uid) : null;
  if (x.name !== undefined) await d!.update(s.folderId, { name: cleanName(x.name) }).catch((e) => warnings.push(`Folder not renamed: ${e.message}`));

  if (x.publicView !== undefined && x.publicView !== s.publicView) {
    const perms = await d!.permissions(s.folderId);
    const anyone = perms.find((p) => p.type === 'anyone');
    if (x.publicView && !anyone) await d!.addPermission(s.folderId, { type: 'anyone', role: 'reader', allowFileDiscovery: false });
    if (!x.publicView && anyone) await d!.deletePermission(s.folderId, anyone.id);
    patch.publicView = x.publicView;
  }

  if (x.linkedEmails !== undefined) {
    const next = [...new Set(x.linkedEmails.map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)))].filter((e) => e !== s.ownerEmail);
    if (next.length) {
      const me = (await getDoc(userRef(uid))).data() as { driveScope?: string } | undefined;
      if (me?.driveScope !== 'full') throw new HttpsError('failed-precondition', 'needs-full-drive');
    }
    const before: string[] = s.linkedEmails ?? [];
    const perms = await d!.permissions(s.folderId);
    for (const e of next.filter((e) => !before.includes(e))) {
      if (perms.some((p) => p.type === 'user' && p.emailAddress?.toLowerCase() === e)) continue;
      await d!.addPermission(s.folderId, { type: 'user', role: 'writer', emailAddress: e }, {
        notify: true,
        message: `Files you put in this folder move to ${s.ownerEmail}'s Drive and stop using your storage. Link your account once at ${ORIGINS[0]}/link`,
      }).catch((err) => warnings.push(`${e}: ${err.message}`));
    }
    for (const e of before.filter((e) => !next.includes(e))) {
      const p = perms.find((p) => p.type === 'user' && p.emailAddress?.toLowerCase() === e && p.role !== 'owner');
      if (p) await d!.deletePermission(s.folderId, p.id).catch((err) => warnings.push(`${e}: ${err.message}`));
    }
    patch.linkedEmails = next;
    patch.linked = next.length > 0;
  }
  await updateDoc(shareRef(x.shareId), patch as never);
  return { ok: true, warnings };
});

async function deleteAll(c: ReturnType<typeof collection<any>>) {
  for (;;) {
    const snap = await getDocs(query(c as any, limit(400)) as any);
    if (snap.empty) return;
    const b = writeBatch(db);
    for (const d of snap.docs) b.delete(d.ref);
    await b.commit();
  }
}

export const deleteShare = onCall(api.deleteShare, opts, async (req) => {
  const uid = admin(req);
  const s = await ownShare(uid, req.data.shareId);
  if (req.data.trashFolder) await (await driveFor(uid)).update(s.folderId, { trashed: true }).catch(() => {});
  await deleteAll(collection(db, uploads, req.data.shareId) as any);
  await deleteAll(collection(db, transfers, req.data.shareId) as any);
  await deleteDoc(shareRef(req.data.shareId));
  return { ok: true };
});

/** Release reservations of uploads that never finished. */
async function expireStale(shareId: string): Promise<void> {
  const stale = await getDocs(query(collection(db, uploads, shareId), where('state', '==', 'started'), where('expiresAt', '<', now()), limit(50)));
  for (const u of stale.docs) {
    await runTransaction(db, async (tx) => {
      const cur = (await tx.get(u.ref)).data() as { state: string; size: number } | undefined;
      if (cur?.state !== 'started') return;
      tx.update(u.ref, { state: 'expired' } as never);
      tx.update(shareRef(shareId), { reservedBytes: increment(-cur.size) } as never);
    });
  }
}

export const syncShare = onCall(api.syncShare, opts, async (req) => {
  const uid = admin(req);
  const s = await ownShare(uid, req.data.shareId);
  await expireStale(req.data.shareId);
  const files = await (await driveFor(uid)).walk(s.folderId, { deadline: Date.now() + 50_000 });
  const mine = files.filter((f) => f.owners?.[0]?.emailAddress?.toLowerCase() === s.ownerEmail && !f.mimeType.endsWith('.folder'));
  const usedBytes = mine.reduce((n, f) => n + sizeOf(f), 0);
  const active = await getDocs(query(collection(db, uploads, req.data.shareId), where('state', '==', 'started'), where('expiresAt', '>=', now())));
  const reservedBytes = active.docs.reduce((n, d) => n + (d.data() as { size: number }).size, 0);
  await updateDoc(shareRef(req.data.shareId), { usedBytes, fileCount: mine.length, reservedBytes, lastSync: serverTimestamp() } as never);
  return { usedBytes, fileCount: mine.length, reservedBytes };
});

// ─── upload link (anyone with the link) ───────────────────────────────────────

export const shareInfo = onCall(api.shareInfo, opts, async (req) => {
  const s = await linkShare(req.data.shareId, req.data.secret);
  return {
    name: s.name, capBytes: s.capBytes, usedBytes: s.usedBytes, reservedBytes: s.reservedBytes, maxFileBytes: s.maxFileBytes,
    needsPassword: !!s.passwordHash, open: true, ...(s.publicView ? { folderUrl: folderUrl(s.folderId) } : {}),
  };
});

/** Hold room for one file under the cap and open its Drive upload session (owner token, caller's Origin). */
async function startOne(s0: Share, shareId: string, origin: string, d: Drive, f: { name: string; size: number; mime?: string }, by?: string) {
  if (s0.maxFileBytes && f.size > s0.maxFileBytes) throw new HttpsError('out-of-range', 'The file is larger than this link allows');
  const upRef = doc(collection(db, uploads, shareId));
  await runTransaction(db, async (tx) => {
    const s = (await tx.get(shareRef(shareId))).data() as Share | undefined;
    if (!s) throw new HttpsError('not-found', 'The link is wrong or was turned off');
    if (f.size > room(s.capBytes, s.usedBytes, s.reservedBytes)) throw new HttpsError('resource-exhausted', 'Not enough room left under the cap');
    tx.update(shareRef(shareId), { reservedBytes: increment(f.size) } as never);
    tx.set(upRef, {
      name: cleanName(f.name, 500), size: f.size, mime: f.mime || 'application/octet-stream',
      ...(by ? { by } : {}),
      state: 'started', createdAt: now(), expiresAt: Timestamp.fromMillis(Date.now() + RESERVE_MS),
    } as never);
  });
  try {
    const url = await d.startResumable({
      name: cleanName(f.name, 500),
      parents: [s0.folderId],
      ...(f.mime ? { mimeType: f.mime } : {}),
      description: `Uploaded with DriveShare${by ? ` by ${by}` : ''}`,
      appProperties: { dsUpload: upRef.id, dsShare: shareId },
    }, f.size, origin);
    return { uploadId: upRef.id, url };
  } catch (e) {
    await runTransaction(db, async (tx) => {
      tx.update(upRef, { state: 'expired' } as never);
      tx.update(shareRef(shareId), { reservedBytes: increment(-f.size) } as never);
    });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('unavailable', `Drive did not open the upload: ${(e as Error).message}`);
  }
}

/** The share behind a link, checked for origin and password, before any upload starts. */
async function openLink(req: { rawRequest: { headers: Record<string, unknown> } }, shareId: string, secret: string, password?: string) {
  const origin = String(req.rawRequest.headers.origin ?? '');
  if (!ORIGINS.includes(origin)) throw new HttpsError('permission-denied', 'Uploads start from the DriveShare site only');
  const s0 = await linkShare(shareId, secret);
  if (s0.passwordHash && !checkPassword(password ?? '', s0.passwordHash)) throw new HttpsError('unauthenticated', 'Wrong password');
  await expireStale(shareId);
  return { s0, origin };
}

export const startUpload = onCall(api.startUpload, opts, async (req) => {
  const { s0, origin } = await openLink(req, req.data.shareId, req.data.secret, req.data.password);
  const d = await driveFor(s0.ownerUid);
  return startOne(s0, req.data.shareId, origin, d, req.data, req.data.by?.trim() || undefined);
});

/** Up to 20 files in one call: a folder of photos costs a handful of calls, not two per photo. */
export const startUploads = onCall(api.startUploads, opts, async (req) => {
  const { s0, origin } = await openLink(req, req.data.shareId, req.data.secret, req.data.password);
  const d = await driveFor(s0.ownerUid);
  const by = req.data.by?.trim() || undefined;
  const out: ({ uploadId: string; url: string } | { error: string; code: string })[] = [];
  for (const f of req.data.files) {
    try {
      out.push(await startOne(s0, req.data.shareId, origin, d, f, by));
    } catch (e) {
      out.push({ code: e instanceof HttpsError ? e.code : 'internal', error: (e as Error).message });
    }
  }
  return { uploads: out };
});

/** Count one finished upload against the cap (idempotent). */
async function finishOne(s: Share, shareId: string, d: Drive, uploadId: string, fileId?: string): Promise<boolean> {
  if (!validId(uploadId)) throw new HttpsError('not-found', 'Unknown upload');
  const upRef = doc(collection(db, uploads, shareId), uploadId);
  const up = (await getDoc(upRef)).data() as { state: string; size: number } | undefined;
  if (!up) throw new HttpsError('not-found', 'Unknown upload');
  if (up.state === 'done') return true;
  let file = fileId ? await d.get(fileId).catch(() => null) : null;
  if (!file || file.appProperties?.dsUpload !== uploadId) {
    file = (await d.list(`appProperties has { key='dsUpload' and value='${uploadId.replace(/[^\w-]/g, '')}' } and trashed = false`))[0] ?? null;
  }
  if (!file || !file.parents?.includes(s.folderId)) throw new HttpsError('failed-precondition', 'The upload has not reached Drive');
  const size = sizeOf(file);
  await runTransaction(db, async (tx) => {
    const cur = (await tx.get(upRef)).data() as { state: string; size: number };
    if (cur.state === 'done') return;
    tx.update(shareRef(shareId), {
      usedBytes: increment(size), fileCount: increment(1),
      ...(cur.state === 'started' ? { reservedBytes: increment(-cur.size) } : {}),
    } as never);
    tx.update(upRef, { state: 'done', fileId: file!.id, size, finishedAt: now() } as never);
  });
  return true;
}

export const finishUpload = onCall(api.finishUpload, opts, async (req) => {
  const s = await linkShare(req.data.shareId, req.data.secret);
  await finishOne(s, req.data.shareId, await driveFor(s.ownerUid), req.data.uploadId, req.data.fileId);
  const after = (await getDoc(shareRef(req.data.shareId))).data() as Share;
  return { ok: true, usedBytes: after.usedBytes };
});

export const finishUploads = onCall(api.finishUploads, opts, async (req) => {
  const s = await linkShare(req.data.shareId, req.data.secret);
  const d = await driveFor(s.ownerUid);
  const results: { uploadId: string; ok: boolean; error?: string }[] = [];
  for (const it of req.data.items) {
    try {
      await finishOne(s, req.data.shareId, d, it.uploadId, it.fileId);
      results.push({ uploadId: it.uploadId, ok: true });
    } catch (e) {
      results.push({ uploadId: it.uploadId, ok: false, error: (e as Error).message });
    }
  }
  const after = (await getDoc(shareRef(req.data.shareId))).data() as Share;
  return { results, usedBytes: after.usedBytes, reservedBytes: after.reservedBytes, capBytes: after.capBytes };
});

// ─── linked accounts: hand files over to the owner ────────────────────────────

async function sweepOne(shareId: string, deadline: number) {
  const s = (await getDoc(shareRef(shareId))).data() as Share | undefined;
  if (!s || !s.enabled || !s.linkedEmails?.length) return { moved: 0, overCap: 0, failed: 0, left: 0, errors: [] as string[] };
  const owner = await driveFor(s.ownerUid);
  const linked = [];
  const errors: string[] = [];
  for (const email of s.linkedEmails as string[]) {
    const u = await getDocs(query(collection(db, users), where('email', '==', email), limit(1)));
    if (u.empty) { errors.push(`${email}: has not linked yet (${ORIGINS[0]}/link)`); continue; }
    try {
      linked.push({ email, drive: await driveFor(u.docs[0]!.id) });
    } catch {
      errors.push(`${email}: Drive access was revoked; they need to link again`);
    }
  }
  // Save as we go: a run that is cut off keeps what it moved, and the dashboard fills in live.
  const save = async (items: SweepItem[]) => {
    const b = writeBatch(db);
    for (const i of items) {
      b.set(doc(collection(db, transfers, shareId), i.id), { name: i.name, size: i.size, from: i.from, state: i.state, ...(i.error ? { error: i.error } : {}), at: now() } as never);
    }
    const moved = items.filter((i) => i.state === 'moved');
    const bytes = moved.reduce((n, i) => n + i.size, 0);
    const files = moved.filter((i) => i.size > 0).length;
    if (bytes || files) b.update(shareRef(shareId), { usedBytes: increment(bytes), fileCount: increment(files) } as never);
    await b.commit();
  };
  const r = await sweepShare({ folderId: s.folderId, ownerEmail: s.ownerEmail, capBytes: s.capBytes, usedBytes: s.usedBytes, owner, linked, deadline, onProgress: save });
  errors.push(...r.errors);
  await updateDoc(shareRef(shareId), {
    lastSweep: serverTimestamp(),
    lastError: errors.length ? errors.join('\n').slice(0, 2000) : deleteField(),
    sweepLeft: r.left ? r.left : deleteField(),
  } as never);
  const n = (st: string) => r.items.filter((i) => i.state === st).length;
  return { moved: n('moved'), overCap: n('over-cap'), failed: n('failed'), left: r.left, errors };
}

export const sweepNow = onCall(api.sweepNow, { ...opts, timeoutSeconds: 120 }, async (req) => {
  const uid = admin(req);
  await ownShare(uid, req.data.shareId);
  return sweepOne(req.data.shareId, Date.now() + 90_000);
});

/** One tick: only shares with linked accounts are read (one query when there are none). */
export const sweep = onSchedule({ schedule: process.env.SWEEP_SCHEDULE || 'every 5 minutes', region: REGION, secrets: SECRETS, timeoutSeconds: 540, memory: '256MiB' }, async () => {
  // Cloud Scheduler gives up on the call after 5 minutes: stop starting new hand-overs before that.
  // What is left waits for the next tick (sweepLeft on the share).
  const deadline = Date.now() + 250_000;
  const snap = await getDocs(query(collection(db, shares), where('linked', '==', true)));
  for (const d of snap.docs) {
    try {
      const r = await sweepOne(d.id, deadline);
      if (r.moved || r.failed || r.left) console.log(`sweep ${d.id}: moved ${r.moved}, over cap ${r.overCap}, failed ${r.failed}, left ${r.left}`);
    } catch (e) {
      console.error(`sweep ${d.id}:`, e instanceof DriveError ? e.message : e);
    }
  }
});
