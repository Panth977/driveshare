<script lang="ts">
  import type { ScopeLevel } from '@driveshare/backend/shared';
  import { account } from '../lib/account.svelte.ts';
  let { level, title, children }: { level: ScopeLevel; title: string; children?: import('svelte').Snippet } = $props();
</script>

<div class="center">
  <div class="card narrow stack" style="padding:32px; text-align:center">
    <img src="/icon.svg" alt="" style="width:52px; margin:0 auto" />
    {#if account.needsFull !== null}
      <h1>One more step</h1>
      <p class="muted">{account.needsFull || 'Your account'} is linked to a DriveShare folder. To move the files you put there into the owner's Drive, DriveShare needs access to your Google Drive.</p>
      <ol class="small muted" style="text-align:left; line-height:1.6">
        <li>If Google says it hasn't verified this app: <b>Advanced</b> › <b>Go to driveshare-p977.web.app</b>.</li>
        <li>Tick <b>See, edit, create and delete all of your Google Drive files</b>.</li>
        <li><b>Continue</b>.</li>
      </ol>
      <p class="small muted">It only touches files you put inside folders you were invited to.</p>
      <div><button class="primary" disabled={account.busy} onclick={() => account.grantFull().then((ok) => { if (ok && location.pathname !== '/link') { history.replaceState(null, '', '/link'); dispatchEvent(new PopStateEvent('popstate')); } })}>{account.busy ? 'Waiting for Google…' : 'Allow Drive access'}</button></div>
    {:else}
      <h1>{title}</h1>
      {@render children?.()}
      <div><button class="primary" disabled={account.busy} onclick={() => account.signIn(level)}>{account.busy ? 'Signing in…' : 'Sign in with Google'}</button></div>
    {/if}
    {#if account.error}<p class="error">{account.error}</p>{/if}
  </div>
</div>
