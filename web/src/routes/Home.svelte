<script lang="ts">
  import { account } from '../lib/account.svelte.ts';
  import { router } from '../lib/router.svelte.ts';
  import { linked } from '../lib/linked.svelte.ts';
  import { demoMode } from '../lib/mydrive.svelte.ts';
  import TopBar from '../components/TopBar.svelte';
  import SignIn from '../components/SignIn.svelte';
  import Shares from './Shares.svelte';
  import MyDrive from './MyDrive.svelte';
  import Viewer from './Viewer.svelte';

  // Linked accounts get the same app on their own Drive (My Drive, Viewer), plus the folders they are linked to.
  $effect(() => { linked.load(); });

  const view = $derived(/^\/view(?:\/([\w-]+))?(?:\/([\w-]+))?/.exec(router.path));
  const drive = $derived(/^\/drive(?:\/([\w-]+))?/.exec(router.path));
  const allowed = $derived(demoMode || account.user?.role === 'admin' || account.user?.role === 'linked');
</script>

{#if !demoMode && !account.known}
  <div class="center muted"><span class="spin"></span></div>
{:else if !demoMode && !account.user}
  <SignIn level="file" title="DriveShare" qr>
    <p class="muted">Your Google Drive, shared on your terms. Capped upload links, a Finder for your whole Drive, and a fast viewer.</p>
    <p class="small faint">Private: only the owner and the accounts linked to a share can sign in.</p>
  </SignIn>
{:else if !allowed}
  <div class="center muted">This account cannot use this DriveShare.</div>
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
