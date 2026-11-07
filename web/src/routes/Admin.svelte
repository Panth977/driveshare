<script lang="ts">
  import { account } from '../lib/account.svelte.ts';
  import { watchShares, type ShareView } from '../lib/shares.svelte.ts';
  import TopBar from '../components/TopBar.svelte';
  import SignIn from '../components/SignIn.svelte';
  import NewShare from '../components/NewShare.svelte';
  import ShareCard from '../components/ShareCard.svelte';

  let list = $state<ShareView[] | null>(null);
  let loadError = $state('');
  let creating = $state(false);

  // A linked account that signed in here belongs on /link.
  $effect(() => {
    if (account.user && account.user.role === 'linked') {
      history.replaceState(null, '', '/link');
      dispatchEvent(new PopStateEvent('popstate'));
    }
  });

  $effect(() => {
    const u = account.user;
    if (!u || u.role !== 'admin') return;
    return watchShares(u.uid, (l) => (list = l), (e) => (loadError = e.message));
  });
</script>

{#if !account.known}
  <div class="center muted">Loading…</div>
{:else if !account.user}
  <SignIn level="file" title="DriveShare">
    <p class="muted">Share capped folders of your Google Drive. People upload into your storage, not theirs.</p>
    <p class="small muted">This site is private: only its owner can sign in. Linked accounts use <a href="/link">/link</a>.</p>
  </SignIn>
{:else if account.user.role !== 'admin'}
  <div class="center muted">Opening your linked folders…</div>
{:else}
  <TopBar />
  <main class="wrap stack" style="gap:18px">
    <div class="row spread">
      <div>
        <h1>Your shares</h1>
        <p class="muted small" style="margin:4px 0 0">Each share is a folder in your Drive with a size cap. Uploads use your storage.</p>
      </div>
      {#if !creating}<button class="primary" onclick={() => (creating = true)}>New share</button>{/if}
    </div>
    {#if creating}<NewShare onclose={() => (creating = false)} />{/if}
    {#if loadError}<p class="error">{loadError}</p>{/if}
    {#if list === null}
      <p class="muted">Loading shares…</p>
    {:else if list.length === 0 && !creating}
      <div class="card muted">No shares yet. Make one, then send its link to whoever should upload.</div>
    {:else}
      {#each list as s (s.id)}<ShareCard share={s} />{/each}
    {/if}
  </main>
{/if}
