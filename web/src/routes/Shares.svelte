<script lang="ts">
  import { formatBytes } from '@driveshare/backend/shared';
  import { account } from '../lib/account.svelte.ts';
  import { watchShares, type ShareView } from '../lib/shares.svelte.ts';
  import { demoMode, mydrive } from '../lib/mydrive.svelte.ts';
  import { bytesOf, driveLink, failText, isFolder, kindOf, thumb, ago, type DFile } from '../lib/gdrive.ts';
  import { nav } from '../lib/router.svelte.ts';
  import NewShare from '../components/NewShare.svelte';
  import ShareCard from '../components/ShareCard.svelte';
  import FileIcon from '../components/drive/FileIcon.svelte';

  let list = $state<ShareView[] | null>(null);
  let loadError = $state('');
  let creating = $state(false);

  $effect(() => {
    const u = account.user;
    if (demoMode) { list = []; return; }
    if (!u || u.role !== 'admin') return;
    return watchShares(u.uid, (l) => (list = l), (e) => (loadError = e.message));
  });

  // Files and folders you shared with "anyone with the link" (from the viewer or Drive itself).
  let links = $state<DFile[] | null>(null);
  let linksError = $state('');
  let copied = $state('');
  $effect(() => { void mydrive.start(); });
  $effect(() => {
    const d = mydrive.drive;
    if (!d) return;
    d.query(`visibility = 'anyoneWithLink' and 'me' in owners and trashed = false`, { orderBy: 'modifiedTime desc', max: 60 })
      .then((l) => (links = l), (e) => (linksError = failText(e)));
  });

  async function stop(f: DFile) {
    try {
      await mydrive.drive!.unshareAnyone(f.id);
      links = links?.filter((x) => x.id !== f.id) ?? null;
    } catch (e) { linksError = failText(e); }
  }
  const copy = (f: DFile) => navigator.clipboard.writeText(driveLink(f)).then(() => { copied = f.id; setTimeout(() => (copied = ''), 1400); });
</script>

<main class="wrap stack" style="gap:1.4rem">
  <section class="hero">
    <div>
      <h1>Shares</h1>
      <p class="muted" style="margin:0.3rem 0 0">Capped folders of your Drive. People upload through a link; it uses your storage, not theirs.</p>
    </div>
    {#if !creating}<button class="primary" onclick={() => (creating = true)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>New share</button>{/if}
  </section>
  {#if creating}<NewShare onclose={() => (creating = false)} />{/if}
  {#if loadError}<p class="error">{loadError}</p>{/if}
  {#if list === null}
    <div class="skeleton" style="height:9rem"></div>
  {:else if list.length === 0 && !creating}
    <div class="card empty">
      <h3>No shares yet</h3>
      <p class="muted small">Make one, then send its link to whoever should upload.</p>
    </div>
  {:else}
    {#each list as s (s.id)}<ShareCard share={s} />{/each}
  {/if}

  <section class="stack" style="gap:0.8rem; margin-top:0.8rem">
    <div class="row spread">
      <div>
        <h2>Shared by link</h2>
        <p class="muted small" style="margin:0.2rem 0 0">Anyone with the link can view these. Made from the viewer, or in Google Drive.</p>
      </div>
    </div>
    {#if mydrive.state === 'needs-full'}
      <div class="card small muted">Open <button class="link" onclick={() => nav('/drive')}>My Drive</button> once and allow full Drive access to see these here.</div>
    {:else if linksError}
      <p class="error">{linksError}</p>
    {:else if links === null}
      <div class="skeleton" style="height:4rem"></div>
    {:else if links.length === 0}
      <div class="card small muted">Nothing is shared by link.</div>
    {:else}
      <div class="links card">
        {#each links as f (f.id)}
          <div class="link-row">
            <div class="lt">
              {#if thumb(f, 96)}<img src={thumb(f, 96)} alt="" referrerpolicy="no-referrer" />{:else}<FileIcon file={f} size={1.6} />{/if}
            </div>
            <div class="grow">
              <div class="ellipsis">{f.name}</div>
              <div class="tiny faint">{kindOf(f)}{isFolder(f) ? '' : ` · ${formatBytes(bytesOf(f))}`} · {ago(f.modifiedTime)}</div>
            </div>
            <button class="ghost small" onclick={() => copy(f)}>{copied === f.id ? 'Copied' : 'Copy link'}</button>
            <a class="btn ghost small" href={driveLink(f)} target="_blank" rel="noopener">Open</a>
            <button class="ghost small danger" onclick={() => stop(f)}>Stop sharing</button>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</main>

<style>
  .hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; flex-wrap: wrap; }
  .empty { text-align: center; padding: 2.4rem; }
  .empty p { margin: 0.3rem 0 0; }
  .links { padding: 0.35rem; display: grid; }
  .link-row { display: flex; align-items: center; gap: 0.8rem; padding: 0.5rem 0.6rem; border-radius: 10px; }
  .link-row:hover { background: var(--panel-2); }
  .lt { width: 2.4rem; height: 2.4rem; border-radius: 8px; overflow: hidden; display: grid; place-items: center; background: var(--bg-2); flex: none; }
  .lt img { width: 100%; height: 100%; object-fit: cover; }
</style>
