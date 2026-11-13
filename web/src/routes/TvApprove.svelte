<script lang="ts">
  // The phone side of TV sign-in: opened from the QR code (/tv#<id>.<secret>).
  import { account } from '../lib/account.svelte.ts';
  import { errorText, tvApprove } from '../lib/icebase.ts';
  import { nav } from '../lib/router.svelte.ts';
  import SignIn from '../components/SignIn.svelte';

  // Keep the key across a Google redirect (the hash does not survive /auth/callback).
  const fromHash = location.hash.slice(1);
  if (fromHash) sessionStorage.setItem('ds.tv', fromHash);
  const key = fromHash || sessionStorage.getItem('ds.tv') || '';
  const [id = '', secret = ''] = key.split('.');

  let step = $state<'ask' | 'busy' | 'done' | 'error'>('ask');
  let code = $state('');
  let device = $state('');
  let error = $state('');

  async function approve() {
    step = 'busy';
    try {
      const r = await tvApprove({ id, secret });
      code = r.code;
      device = r.device ?? '';
      step = 'done';
      sessionStorage.removeItem('ds.tv');
    } catch (e) {
      step = 'error';
      error = errorText(e);
    }
  }
</script>

{#if !id || !secret}
  <div class="center"><div class="card narrow stack" style="text-align:center"><h2>Scan the code on your TV</h2><p class="muted">This page opens from the QR code DriveShare shows on a TV.</p><a class="btn" href="/">Open DriveShare</a></div></div>
{:else if !account.known}
  <div class="center muted"><span class="spin"></span></div>
{:else if !account.user}
  <SignIn level="file" title="Sign in the TV">
    <p class="muted">First sign in here, on your phone. Then you approve the TV.</p>
  </SignIn>
{:else if account.user.role !== 'admin' && account.user.role !== 'linked'}
  <div class="center"><div class="card narrow"><p class="error">{account.user.email} cannot use this DriveShare.</p></div></div>
{:else}
  <div class="center">
    <div class="card narrow stack approve">
      <div class="tvicon" aria-hidden="true">
        <svg viewBox="0 0 48 48"><rect x="4" y="8" width="40" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M16 42h16M24 34v8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>
      </div>
      {#if step === 'done'}
        <h1>TV signed in</h1>
        <p class="muted">Code <b class="mono">{code}</b>{device ? ` · ${device}` : ''}. The TV opens your DriveShare in a moment.</p>
        <button onclick={() => nav('/')}>Open DriveShare here</button>
      {:else}
        <h1>Sign in the TV?</h1>
        <p class="muted">The TV will be signed in as <b>{account.user.email}</b> and can see and change your Drive. Check the code on the TV first.</p>
        {#if step === 'error'}<p class="error">{error}</p>{/if}
        <button class="primary go" disabled={step === 'busy'} onclick={approve}>{step === 'busy' ? 'Approving…' : 'Approve'}</button>
        <button class="ghost" onclick={() => nav('/')}>Not now</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .approve { text-align: center; justify-items: center; padding: 2rem 1.5rem; }
  .tvicon { width: 4rem; height: 4rem; color: var(--accent-2); }
  .go { width: 100%; justify-content: center; padding: 0.95rem; font-size: 1.05rem; }
</style>
