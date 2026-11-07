<script lang="ts">
  import { formatBytes } from '@driveshare/backend/shared';
  import { account } from '../lib/account.svelte.ts';
  import { errorText, linkedShares } from '../lib/icebase.ts';
  import TopBar from '../components/TopBar.svelte';
  import SignIn from '../components/SignIn.svelte';

  let list = $state<{ name: string; folderUrl: string; ownerEmail: string; capBytes: number; usedBytes: number }[] | null>(null);
  let error = $state('');

  $effect(() => {
    if (!account.user) return;
    linkedShares({}).then((r) => (list = r.shares), (e) => (error = errorText(e)));
  });
</script>

{#if !account.known}
  <div class="center muted">Loading…</div>
{:else if !account.user}
  <SignIn level="full" title="Link your Google account">
    <p class="muted">Someone added your Google account to a DriveShare folder. Link it once: files you put in that folder then move to their Drive and stop using your storage.</p>
    <p class="small muted">Google will ask to let DriveShare see and manage your Drive files. It only touches files inside the shared folders, to hand them over.</p>
  </SignIn>
{:else}
  <TopBar />
  <main class="wrap narrow stack">
    <h1>Linked</h1>
    <p class="muted">Drop files into these folders from Google Drive (web, phone or desktop). Within about 15 minutes they move to the owner's Drive; your storage is freed. A file that does not fit under the cap stays yours.</p>
    {#if error}<p class="error">{error}</p>{/if}
    {#if list === null && !error}<p class="muted">Loading…</p>{/if}
    {#each list ?? [] as s}
      <div class="card row spread">
        <div><h3>{s.name}</h3><div class="small muted">{s.ownerEmail} · {formatBytes(Math.max(0, s.capBytes - s.usedBytes))} left of {formatBytes(s.capBytes)}</div></div>
        <a class="btn primary" href={s.folderUrl} target="_blank" rel="noopener">Open folder</a>
      </div>
    {/each}
    {#if list && list.length === 0}<p class="muted">No folders are linked to {account.user.email}.</p>{/if}
  </main>
{/if}
