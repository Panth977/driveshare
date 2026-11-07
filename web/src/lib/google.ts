// Google Identity Services: the authorization-code flow (popup, or a full-page redirect when popups are blocked).
import { deployment } from '@driveshare/backend/deployment';
import { scopesFor, type ScopeLevel } from '@driveshare/backend/shared';

interface CodeClient { requestCode(): void }
interface GoogleOAuth2 {
  initCodeClient(cfg: {
    client_id: string;
    scope: string;
    ux_mode: 'popup' | 'redirect';
    redirect_uri?: string;
    state?: string;
    prompt?: '' | 'consent' | 'select_account';
    login_hint?: string;
    include_granted_scopes?: boolean;
    callback: (r: { code?: string; error?: string; error_description?: string }) => void;
    error_callback?: (e: { type: string; message?: string }) => void;
  }): CodeClient;
}
declare global {
  interface Window { google?: { accounts: { oauth2: GoogleOAuth2 } } }
}

let loading: Promise<GoogleOAuth2> | null = null;
function gis(): Promise<GoogleOAuth2> {
  loading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts) return resolve(window.google.accounts.oauth2);
    const s = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
    s.onload = () => resolve(window.google!.accounts.oauth2);
    s.onerror = () => { loading = null; reject(new Error('Could not load Google sign-in.')); };
    document.head.append(s);
  });
  return loading;
}

export class SignInCancelled extends Error {
  override name = 'SignInCancelled';
}

export interface CodeOptions { level: ScopeLevel; consent?: boolean; hint?: string }

export async function requestCode(o: CodeOptions): Promise<string> {
  const oauth2 = await gis();
  return new Promise((resolve, reject) => {
    oauth2.initCodeClient({
      client_id: deployment.googleClientId,
      scope: scopesFor(o.level).join(' '),
      ux_mode: 'popup',
      prompt: o.consent ? 'consent' : 'select_account',
      login_hint: o.hint,
      include_granted_scopes: true,
      callback: (r) => (r.code ? resolve(r.code) : reject(new Error(r.error_description ?? r.error ?? 'Google sign-in failed'))),
      error_callback: (e) => reject(e.type === 'popup_closed' ? new SignInCancelled('Sign-in was closed.') : new Error(e.message ?? e.type)),
    }).requestCode();
  });
}

export const CALLBACK_PATH = '/auth/callback';

export async function redirectForCode(o: CodeOptions): Promise<never> {
  const oauth2 = await gis();
  const state = crypto.randomUUID();
  sessionStorage.setItem('ds-oauth', JSON.stringify({ state, returnTo: location.pathname + location.hash }));
  oauth2.initCodeClient({
    client_id: deployment.googleClientId,
    scope: scopesFor(o.level).join(' '),
    ux_mode: 'redirect',
    redirect_uri: location.origin + CALLBACK_PATH,
    state,
    prompt: o.consent ? 'consent' : 'select_account',
    login_hint: o.hint,
    include_granted_scopes: true,
    callback: () => {},
  }).requestCode();
  return new Promise(() => {});
}

/** On /auth/callback: the code Google sent back, if its state matches ours. */
export function takeRedirectCode(): { code: string; redirectUri: string } | { error: string } | null {
  if (location.pathname !== CALLBACK_PATH) return null;
  const q = new URLSearchParams(location.search);
  const saved = JSON.parse(sessionStorage.getItem('ds-oauth') ?? 'null') as { state: string; returnTo: string } | null;
  sessionStorage.removeItem('ds-oauth');
  history.replaceState(null, '', saved?.returnTo || '/');
  if (q.get('error')) return { error: q.get('error') === 'access_denied' ? '' : q.get('error')! };
  const code = q.get('code');
  if (!code || !saved || saved.state !== q.get('state')) return { error: 'Sign-in could not be verified. Please try again.' };
  return { code, redirectUri: location.origin + CALLBACK_PATH };
}
