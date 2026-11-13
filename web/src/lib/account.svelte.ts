import { onAuthStateChanged, signInWithCustomToken, signOut } from '@panth977/icebase/auth';
import type { ScopeLevel } from '@driveshare/backend/shared';
import { auth, errorCode, errorText, googleSignIn } from './icebase.ts';
import { redirectForCode, requestCode, takeRedirectCode, type CodeOptions } from './google.ts';

export interface Account { uid: string; email: string; name: string; photo?: string; role?: 'admin' | 'linked' }

/** The signed-in Google account. One popup proves who you are and leaves Drive access with the backend. */
class AccountState {
  user = $state<Account | null>(null);
  known = $state(false);
  busy = $state(false);
  error = $state('');
  /**
   * Set when Google signed in a linked account with only the small Drive scope: the account
   * must still grant full Drive access (a second, explicit consent). Holds the email as a hint.
   */
  needsFull = $state<string | null>(null);

  constructor() {
    onAuthStateChanged(auth, async (u) => {
      if (!u) { this.user = null; this.known = true; return; }
      const claims = (await u.getIdTokenResult?.().catch(() => null))?.claims as { role?: 'admin' | 'linked' } | undefined;
      this.user = { uid: u.uid, email: u.email ?? '', name: u.displayName ?? u.email ?? 'You', photo: u.photoURL ?? undefined, role: claims?.role };
      this.known = true;
    });
    void this.finishRedirect();
  }

  private async exchange(code: string, redirectUri?: string): Promise<{ driveConnected: boolean }> {
    const r = await googleSignIn({ code, ...(redirectUri ? { redirectUri } : {}) });
    await signInWithCustomToken(auth, r.token);
    if (this.user) this.user = { ...this.user, role: r.role };
    return r;
  }

  private async finishRedirect(): Promise<void> {
    const r = takeRedirectCode();
    if (!r) return;
    if ('error' in r) { this.error = r.error; return; }
    this.busy = true;
    try {
      await this.exchange(r.code, r.redirectUri);
      this.needsFull = null;
    } catch (e) {
      if (!this.wantsFull(e)) this.error = errorText(e);
    } finally {
      this.busy = false;
    }
  }

  /** Sign in (or widen access to `level`). Asks for consent again when Google sent no refresh token. */
  async signIn(level: ScopeLevel): Promise<boolean> {
    this.busy = true;
    this.error = '';
    const o: CodeOptions = { level, ...(this.user?.email ? { hint: this.user.email } : {}) };
    try {
      const r = await this.exchange(await requestCode(o));
      if (!r.driveConnected) await this.exchange(await requestCode({ ...o, consent: true }));
      this.needsFull = null;
      return true;
    } catch (e) {
      if ((e as Error).name === 'SignInCancelled') return false;
      if (this.wantsFull(e)) return false;
      if (/popup/i.test(String((e as Error).message))) await redirectForCode(o);
      this.error = errorCode(e) === 'permission-denied' || errorText(e) ? errorText(e) : 'Sign-in failed';
      return false;
    } finally {
      this.busy = false;
    }
  }

  private wantsFull(e: unknown): boolean {
    if (!/needs-full-drive/.test(errorText(e))) return false;
    this.needsFull = String((e as { details?: { email?: string } }).details?.email ?? '');
    return true;
  }

  /** Second step for a linked account: ask Google for full Drive access, with the consent screen shown. */
  async grantFull(): Promise<boolean> {
    this.busy = true;
    this.error = '';
    const o: CodeOptions = { level: 'full', consent: true, ...(this.needsFull ? { hint: this.needsFull } : {}) };
    try {
      await this.exchange(await requestCode(o));
      this.needsFull = null;
      return true;
    } catch (e) {
      if ((e as Error).name === 'SignInCancelled') return false;
      if (/popup/i.test(String((e as Error).message))) await redirectForCode(o);
      if (this.wantsFull(e)) {
        this.error = 'Google still did not give DriveShare access to your Drive. On Google\'s screen, tick the box “See, edit, create and delete all of your Google Drive files”, then Continue.';
        return false;
      }
      this.error = errorText(e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Sign in with a session token from the backend (a TV approved from a phone). */
  async signInWithToken(token: string): Promise<void> {
    await signInWithCustomToken(auth, token);
  }

  async signOut(): Promise<void> {
    // Leave nothing of the Drive behind on this screen (a TV is often shared).
    localStorage.removeItem('ds.driveToken');
    await Promise.all(['ds-thumb-v1', 'ds-orig-v1'].map((c) => caches?.delete(c).catch(() => false)));
    for (const db of ['driveshare-index', 'driveshare-cache']) indexedDB.deleteDatabase(db);
    await signOut(auth);
  }
}

export const account = new AccountState();
