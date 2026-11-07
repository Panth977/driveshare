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
    try { await this.exchange(r.code, r.redirectUri); } catch (e) { this.error = errorText(e); } finally { this.busy = false; }
  }

  /** Sign in (or widen access to `level`). Asks for consent again when Google sent no refresh token. */
  async signIn(level: ScopeLevel): Promise<boolean> {
    this.busy = true;
    this.error = '';
    const o: CodeOptions = { level, ...(this.user?.email ? { hint: this.user.email } : {}) };
    try {
      const r = await this.exchange(await requestCode(o));
      if (!r.driveConnected) await this.exchange(await requestCode({ ...o, consent: true }));
      return true;
    } catch (e) {
      if ((e as Error).name === 'SignInCancelled') return false;
      if (/popup/i.test(String((e as Error).message))) await redirectForCode(o);
      this.error = errorCode(e) === 'permission-denied' || errorText(e) ? errorText(e) : 'Sign-in failed';
      return false;
    } finally {
      this.busy = false;
    }
  }

  async signOut(): Promise<void> {
    await signOut(auth);
  }
}

export const account = new AccountState();
