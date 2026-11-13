<script lang="ts">
  import type { ScopeLevel } from '@driveshare/backend/shared';
  import { account } from '../lib/account.svelte.ts';
  import { tv } from '../lib/tv.svelte.ts';
  import TvLogin from './TvLogin.svelte';
  let { level, title, children, qr = false }: { level: ScopeLevel; title: string; children?: import('svelte').Snippet; qr?: boolean } = $props();
  // On a TV the phone is the easy way in; elsewhere Google first, the QR code one click away.
  let showQr = $state(tv.on);
</script>

<div class="center">
  <div class="signin" class:wide={qr && showQr}>
    <div class="glow"></div>
    {#if account.needsFull !== null}
      <div class="stack" style="text-align:center">
        <img src="/icon.svg" alt="" class="logo" />
        <h1>One more step</h1>
        <p class="muted">{account.needsFull || 'Your account'} is linked to a DriveShare folder. To move the files you put there into the owner's Drive, DriveShare needs access to your Google Drive.</p>
        <ol class="small muted" style="text-align:left; line-height:1.7">
          <li>If Google says it hasn't verified this app: <b>Advanced</b> › <b>Go to driveshare-p977.web.app</b>.</li>
          <li>Tick <b>See, edit, create and delete all of your Google Drive files</b>.</li>
          <li><b>Continue</b>.</li>
        </ol>
        <p class="small muted">It only touches files you put inside folders you were invited to.</p>
        <div><button class="primary big" disabled={account.busy} onclick={() => account.grantFull().then((ok) => { if (ok && location.pathname !== '/link') { history.replaceState(null, '', '/link'); dispatchEvent(new PopStateEvent('popstate')); } })}>{account.busy ? 'Waiting for Google…' : 'Allow Drive access'}</button></div>
      </div>
    {:else}
      <div class="head">
        <img src="/icon.svg" alt="" class="logo" />
        <h1>{title}</h1>
        {@render children?.()}
      </div>
      {#if qr && showQr}
        <TvLogin />
        <div class="or"><span>or</span></div>
        <div class="row" style="justify-content:center">
          <button class="big" disabled={account.busy} onclick={() => account.signIn(level)}><img src="/google.svg" alt="" class="g" />{account.busy ? 'Signing in…' : 'Sign in with Google on this screen'}</button>
          {#if !tv.on}<button class="ghost" onclick={() => (showQr = false)}>Hide QR code</button>{/if}
        </div>
      {:else}
        <div class="stack" style="justify-items:center">
          <button class="big gbtn" disabled={account.busy} onclick={() => account.signIn(level)}><img src="/google.svg" alt="" class="g" />{account.busy ? 'Signing in…' : 'Sign in with Google'}</button>
          {#if qr}<button class="ghost" onclick={() => (showQr = true)}>On a TV? Sign in with your phone</button>{/if}
        </div>
      {/if}
    {/if}
    {#if account.error}<p class="error" style="text-align:center">{account.error}</p>{/if}
  </div>
</div>

<style>
  .signin { position: relative; width: min(30rem, 100%); padding: 2.4rem 2rem; border-radius: 22px; background: linear-gradient(180deg, var(--panel-2), var(--panel)); border: 1px solid var(--line-2); box-shadow: 0 40px 120px -40px rgb(0 0 0 / 0.9); display: grid; gap: 1.6rem; overflow: hidden; }
  .signin.wide { width: min(50rem, 100%); gap: 1.2rem; padding: 2rem; }
  .signin.wide .head :global(p.muted) { display: none; }
  .signin.wide .logo { width: 2.6rem; height: 2.6rem; }
  .glow { position: absolute; inset: -40% -20% auto; height: 70%; background: radial-gradient(closest-side, rgb(124 156 255 / 0.18), transparent); pointer-events: none; }
  .head { position: relative; text-align: center; display: grid; gap: 0.5rem; justify-items: center; }
  .head :global(p) { margin: 0; }
  .logo { width: 3.4rem; height: 3.4rem; }
  .big { padding: 0.8rem 1.3rem; font-size: 1rem; border-radius: 12px; }
  .gbtn { background: #fff; color: #1f1f1f; border-color: #fff; }
  .gbtn:hover { background: #e8ecf5; border-color: #e8ecf5; }
  .g { width: 1.1rem; height: 1.1rem; }
  .or { display: flex; align-items: center; gap: 0.8rem; color: var(--faint); font-size: 0.8rem; }
  .or::before, .or::after { content: ''; flex: 1; border-top: 1px solid var(--line); }
</style>
