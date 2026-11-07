<script lang="ts">
  import { account } from '../lib/account.svelte.ts';
  let { title = 'DriveShare' }: { title?: string } = $props();
</script>

<header class="topbar">
  <a class="brand" href="/"><img src="/icon.svg" alt="" />{title}</a>
  {#if account.user}
    <div class="row small">
      {#if account.user.photo}<img class="avatar" src={account.user.photo} alt="" referrerpolicy="no-referrer" />{/if}
      <span class="muted">{account.user.email}</span>
      <button class="link" onclick={() => account.signOut()}>Sign out</button>
    </div>
  {/if}
</header>
