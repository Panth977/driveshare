<script lang="ts">
  import { account } from '../lib/account.svelte.ts';
  import { router, nav } from '../lib/router.svelte.ts';
  import { watchSends } from '../lib/remote.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { profiles } from '../lib/profiles.svelte.ts';
  import ProfilePicker from '../components/profiles/ProfilePicker.svelte';
  import PinPad from '../components/profiles/PinPad.svelte';
  import { linked } from '../lib/linked.svelte.ts';
  import { demoMode, mydrive } from '../lib/mydrive.svelte.ts';
  import TopBar from '../components/TopBar.svelte';
  import SignIn from '../components/SignIn.svelte';
  import Shares from './Shares.svelte';
  import MyDrive from './MyDrive.svelte';
  import Viewer from './Viewer.svelte';
  import TvBrowse from './TvBrowse.svelte';
  import ProfilesEditor from '../components/profiles/ProfilesEditor.svelte';
  import { tv } from '../lib/tv.svelte.ts';

  // Linked accounts get the same app on their own Drive (My Drive, Viewer), plus the folders they are linked to.
  $effect(() => { linked.load(); });

  // Household profiles (who may do what on a shared TV).
  $effect(() => { if (account.user) profiles.watch(); });

  // On the TV: open whatever a phone sends ("Send to TV").
  $effect(() => {
    if (!tv.on || !account.user) return;
    return watchSends((i) => {
      toast.show(`From your phone: ${i.name}`, undefined, 3000);
      if (i.kind === 'folder') nav(`/drive/${i.folderId}`);
      else if (i.kind === 'show') nav(`/view/${i.folderId}`);
      else nav(`/view/${i.folderId}/${i.fileId}`);
    });
  });

  const view = $derived(/^\/view(?:\/([\w-]+))?(?:\/([\w-]+))?/.exec(router.path));
  const drive = $derived(/^\/drive(?:\/([\w-]+))?/.exec(router.path));
  // A TV profile kept to some folders: anything else (a link, Send to TV, Back past its folder) is refused.
  const target = $derived(view ? (view[1] ?? '') : drive ? (drive[1] ?? '') : '');
  let gate = $state<{ key: string; ok: boolean } | null>(null);
  const gateKey = $derived(`${profiles.currentId}:${target}`);
  const kept = $derived(tv.on && !!profiles.folders && !!target);
  $effect(() => {
    if (!kept) return;
    const key = gateKey;
    void mydrive.start();
    const d = mydrive.drive;
    if (!d) return;
    void profiles.canSee(target, d).then((ok) => { if (key === gateKey) gate = { key, ok }; });
  });
  const focusMe = (el: HTMLElement) => { setTimeout(() => el.focus(), 60); };
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
{:else if profiles.needsPick}
  <ProfilePicker />
{:else if kept && gate?.key !== gateKey}
  <div class="center muted"><span class="spin"></span></div>
{:else if kept && !gate?.ok}
  <div class="center stack" style="gap:1rem;text-align:center">
    <p>This folder is not on {profiles.current?.name}'s list.</p>
    <div class="row" style="justify-content:center"><button class="primary" use:focusMe onclick={() => nav('/drive')}>Home</button><button onclick={() => profiles.leave()}>Switch profile</button></div>
  </div>
{:else if view}
  <Viewer folderId={view[1] ?? ''} fileId={view[2] ?? ''} />
{:else if tv.on}
  <TvBrowse place={drive?.[1] ?? ''} />
{:else}
  <TopBar tabs />
  {#if router.path.startsWith('/tv-profiles')}
    <main class="page" style="max-width:62rem;margin:0 auto;padding:1.4rem 1.2rem 3rem"><ProfilesEditor /></main>
  {:else if drive}
    <MyDrive folderId={drive[1] ?? ''} />
  {:else}
    <Shares />
  {/if}
{/if}

{#if profiles.ask}<PinPad />{/if}
