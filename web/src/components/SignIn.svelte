<script lang="ts">
  import type { ScopeLevel } from '@driveshare/backend/shared';
  import { account } from '../lib/account.svelte.ts';
  let { level, title, children }: { level: ScopeLevel; title: string; children?: import('svelte').Snippet } = $props();
</script>

<div class="center">
  <div class="card narrow stack" style="padding:32px; text-align:center">
    <img src="/icon.svg" alt="" style="width:52px; margin:0 auto" />
    <h1>{title}</h1>
    {@render children?.()}
    <div><button class="primary" disabled={account.busy} onclick={() => account.signIn(level)}>{account.busy ? 'Signing in…' : 'Sign in with Google'}</button></div>
    {#if account.error}<p class="error">{account.error}</p>{/if}
  </div>
</div>
