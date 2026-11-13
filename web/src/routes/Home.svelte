<script lang="ts">
  import { account } from '../lib/account.svelte.ts';
  import { router, nav } from '../lib/router.svelte.ts';
  import { demoMode } from '../lib/mydrive.svelte.ts';
  import TopBar from '../components/TopBar.svelte';
  import SignIn from '../components/SignIn.svelte';
  import Shares from './Shares.svelte';
  import MyDrive from './MyDrive.svelte';
  import Viewer from './Viewer.svelte';

  // A linked account that signed in here belongs on /link.
  $effect(() => {
    if (account.user && account.user.role === 'linked') nav('/link', true);
  });

  const view = $derived(/^\/view(?:\/([\w-]+))?(?:\/([\w-]+))?/.exec(router.path));
  const drive = $derived(/^\/drive(?:\/([\w-]+))?/.exec(router.path));
  const isAdmin = $derived(demoMode || account.user?.role === 'admin');
</script>

{#if !demoMode && !account.known}
  <div class="center muted"><span class="spin"></span></div>
{:else if !demoMode && !account.user}
  <SignIn level="file" title="DriveShare" qr>
    <p class="muted">Your Google Drive, shared on your terms. Capped upload links, a Finder for your whole Drive, and a fast viewer.</p>
    <p class="small faint">Private: only the owner signs in. Linked accounts use <a href="/link">/link</a>.</p>
  </SignIn>
{:else if !isAdmin}
  <div class="center muted">Opening your linked folders…</div>
{:else if view}
  <Viewer folderId={view[1] ?? ''} fileId={view[2] ?? ''} />
{:else}
  <TopBar tabs />
  {#if drive}
    <MyDrive folderId={drive[1] ?? ''} />
  {:else}
    <Shares />
  {/if}
{/if}
