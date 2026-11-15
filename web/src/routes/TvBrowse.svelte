<script lang="ts" module>
  export function autofocus(el: HTMLElement, on: boolean = true) { if (on) setTimeout(() => el.focus(), 60); }
</script>

<script lang="ts">
  // The TV screen: a 10-foot layout for the remote. Big tiles in a grid, one focused at a time;
  // OK opens, Back goes up, holding OK (or the menu key) opens actions. Uploads and syncs stay on
  // the laptop; the TV is for looking.
  import { onMount, tick } from 'svelte';
  import { formatBytes } from '@driveshare/backend/shared';
  import { account } from '../lib/account.svelte.ts';
  import { mydrive } from '../lib/mydrive.svelte.ts';
  import { sizes } from '../lib/sizes.svelte.ts';
  import { linked } from '../lib/linked.svelte.ts';
  import { nav } from '../lib/router.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { isBack, tv, inTvApp } from '../lib/tv.svelte.ts';
  import { children as cachedChildren } from '../lib/listcache.ts';
  import { ago, bytesOf, duration, failText, isFolder, isVideo, kindOf, sortTv, thumb, type DFile } from '../lib/gdrive.ts';
  import FileIcon from '../components/drive/FileIcon.svelte';
  import ShareDialog from '../components/drive/ShareDialog.svelte';
  import Prompt from '../components/drive/Prompt.svelte';
  import Toast from '../components/Toast.svelte';
  import Saving from '../components/Saving.svelte';
  import { activity } from '../lib/activity.svelte.ts';
  import { profiles } from '../lib/profiles.svelte.ts';
  import { forgetFolder, recentAsFiles, type RecentFolder } from '../lib/recent.ts';

  let { place }: { place: string } = $props();

  const PLACES: { id: string; label: string }[] = [
    { id: '', label: 'My Drive' },
    { id: 'recent', label: 'Recent' },
    { id: 'starred', label: 'Starred' },
    { id: 'shared', label: 'Shared with me' },
  ];
  const VIRTUAL = new Set(['recent', 'starred', 'shared']);

  let items = $state<DFile[] | null>(null);
  let folder = $state<DFile | null>(null);
  let error = $state('');
  let limit = $state(60);
  let menuFor = $state<DFile | null>(null);
  let sharing = $state<DFile | null>(null);
  let confirmBin = $state<DFile | null>(null);
  let gridEl = $state<HTMLElement | null>(null);
  /** Files whose thumbnail did not load (Docs, Sheets…): they show their icon instead. */
  let noThumb = $state<Record<string, true>>({});

  $effect(() => { void mydrive.start(); });
  const drive = $derived(mydrive.drive);
  const virtual = $derived(VIRTUAL.has(place) ? place : '');
  const folderId = $derived(virtual ? '' : place || mydrive.rootId);

  async function load() {
    const d = drive;
    if (!d) return;
    items = null;
    error = '';
    limit = 60;
    try {
      // Recent = folders you looked through lately (newest first), each with the photo you were on.
      if (virtual === 'recent') { folder = null; await Promise.resolve(); items = recentAsFiles(); }
      else if (virtual === 'starred') { folder = null; items = await d.query('starred = true and trashed = false', { orderBy: 'folder,name_natural' }); }
      else if (virtual === 'shared') { folder = null; items = await d.query('sharedWithMe = true and trashed = false', { orderBy: 'folder,modifiedTime desc', max: 300 }); }
      else if (folderId) {
        folder = folderId === mydrive.rootId ? { id: folderId, name: 'My Drive', mimeType: 'application/vnd.google-apps.folder' } : await d.get(folderId).catch(() => null);
        items = sortTv(await cachedChildren(d, folderId, (l) => { if (place === (folderId === mydrive.rootId ? '' : folderId)) items = sortTv(l); }));
      }
      await tick();
      restoreFocus();
    } catch (e) { error = failText(e); }
  }
  $effect(() => { void place; void mydrive.rootId; if (drive) void load(); });


  const shown = $derived(items ? items.slice(0, limit) : null);
  const here = $derived(folderId ? sizes.of(folderId) : undefined);
  const title = $derived(virtual ? PLACES.find((p) => p.id === virtual)!.label : folder?.name ?? '');

  // Remember the focused tile per place, so Back lands where you were.
  const focusKey = () => `ds.tvfocus.${place || 'root'}`;
  function restoreFocus() {
    const id = sessionStorage.getItem(focusKey());
    const el = (id && gridEl?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)) || gridEl?.querySelector<HTMLElement>('[data-id]') || document.querySelector<HTMLElement>('.places button.on');
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'center' });
  }
  function remember(f: DFile) {
    sessionStorage.setItem(focusKey(), f.id);
    // Draw more tiles as you get near the end.
    const i = items?.indexOf(f) ?? 0;
    if (items && i > limit - 15 && limit < items.length) limit += 60;
  }

  const recentOf = (f: DFile) => (f as DFile & { recent?: RecentFolder }).recent;
  function open(f: DFile) {
    remember(f);
    // A recent folder carries on in the viewer where you left it.
    const r = recentOf(f);
    if (r) nav(`/view/${r.id}${r.file ? `/${r.file.id}` : ''}${r.deep ? '?deep=1' : ''}`);
    else if (isFolder(f)) nav(`/drive/${f.id}`);
    else nav(`/view/${f.parents?.[0] ?? folderId ?? 'recent'}/${f.id}`);
  }
  function previewAll(f?: DFile, deep = false) {
    const id = f ? f.id : virtual === 'recent' ? '' : virtual === 'starred' ? 'starred' : folderId;
    if (id) nav(`/view/${id}${deep ? '?deep=1' : ''}`);
  }

  // Hold OK (or press the menu key) for actions.
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  function down(e: KeyboardEvent, f: DFile) {
    if (e.key === 'ContextMenu' || e.key === 'm') { e.preventDefault(); menuFor = f; return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // A held OK button repeats its key: the first repeat means "hold" (remotes repeat after ~0.4 s).
    if (e.repeat) { if (!held) { held = true; if (pressTimer) clearTimeout(pressTimer); menuFor = f; } return; }
    held = false;
    // In the TV app the app itself reports a held OK (window.__dsHold); a timer here could mistake a
    // slow web view for a hold. In a browser, a held key is the only way to know.
    if (!inTvApp) pressTimer = setTimeout(() => { held = true; menuFor = f; }, 400);
  }
  function up(e: KeyboardEvent, f: DFile) {
    if (e.key !== 'Enter') return;
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    if (!held) open(f);
  }

  // Star and bin show at once and save in the background (lib/activity); nothing waits for Drive.
  async function star(f: DFile) {
    if (!(await profiles.allow('edit', (t) => toast.show(t)))) return;
    const to = !(items?.find((x) => x.id === f.id)?.starred ?? f.starred);
    const set = (v: boolean) => { if (items) items = items.map((x) => (x.id === f.id ? { ...x, starred: v } : x)); };
    set(to);
    toast.show(to ? 'Starred' : 'Star removed', undefined, 1500);
    void activity.run(to ? 'Star' : 'Remove star', () => drive!.update(f.id, { starred: to }), () => set(!to));
  }
  async function bin(f: DFile) {
    const at = Math.max(0, items?.findIndex((x) => x.id === f.id) ?? 0);
    const putBack = () => { if (items && !items.some((x) => x.id === f.id)) items = [...items.slice(0, at), f, ...items.slice(at)]; };
    items = items?.filter((x) => x.id !== f.id) ?? null;
    const saved = activity.run(`Bin ${f.name}`, async () => { await drive!.update(f.id, { trashed: true }); sizes.local({ id: f.id, removed: true }); }, putBack);
    toast.show(`Moved “${f.name}” to the bin`, { label: 'Undo', run: () => {
      putBack();
      void activity.run(`Undo bin ${f.name}`, async () => { if (await saved) sizes.local(await drive!.update(f.id, { trashed: false })); }, () => { items = items?.filter((x) => x.id !== f.id) ?? null; });
    } });
    await tick();
    gridEl?.querySelectorAll<HTMLElement>('[data-id]')[Math.min(at, (items?.length ?? 1) - 1)]?.focus();
  }

  function key(e: KeyboardEvent) {
    if (menuFor || sharing || confirmBin) return;
    if (isBack(e)) {
      // Handled = preventDefault, so the TV app knows to stay open; at the top it closes.
      if (!virtual && folder && folderId !== mydrive.rootId) {
        e.preventDefault();
        const parent = folder.parents?.[0];
        nav(parent && parent !== mydrive.rootId ? `/drive/${parent}` : '/drive');
      } else if (virtual || (place && place !== mydrive.rootId)) { e.preventDefault(); nav('/drive'); }
    }
  }

  onMount(() => {
    if (location.pathname === '/') nav('/drive', true);
    // The TV app calls this when OK is held on the remote: actions for the focused tile.
    const w = window as unknown as { __dsHold?: () => boolean };
    w.__dsHold = () => {
      const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-id]')?.dataset.id;
      const f = id ? items?.find((x) => x.id === id) : undefined;
      if (!f || menuFor || sharing || confirmBin) return false;
      menuFor = f;
      return true;
    };
    return () => { delete w.__dsHold; };
  });
  const cols = 5;
</script>

<svelte:window onkeydown={key} />

<div class="tvroot">
  <header class="top">
    <div class="brand"><img src="/icon.svg" alt="" />DriveShare</div>
    <nav class="places" aria-label="Places">
      {#each PLACES as p}
        <button class:on={(p.id === '' && !virtual && (!place || place === mydrive.rootId)) || p.id === virtual} onclick={() => nav(p.id ? `/drive/${p.id}` : '/drive')}>{p.label}</button>
      {/each}
      {#each linked.list ?? [] as l (l.folderId)}
        <button class:on={place === l.folderId} onclick={() => nav(`/drive/${l.folderId}`)}>{l.name}</button>
      {/each}
    </nav>
    <span class="grow"></span>
    <button class="me" onclick={() => (menuFor = { id: '__me', name: account.user?.email ?? '', mimeType: '' })} aria-label="Account">
      {#if account.user?.photo}<img src={account.user.photo} alt="" referrerpolicy="no-referrer" />{:else}<span>{(account.user?.email ?? 'D')[0]?.toUpperCase()}</span>{/if}
    </button>
  </header>

  <section class="head">
    <div>
      <h1>{title}</h1>
      <div class="sub num">
        {#if here}{formatBytes(here.bytes)} · {here.files.toLocaleString()} files{here.folders ? ` · ${here.folders.toLocaleString()} folders` : ''}{:else if items}{items.length.toLocaleString()} items{/if}
        {#if !virtual && folder && folderId !== mydrive.rootId}<span class="hint">· <kbd>Back</kbd> to go up</span>{/if}
      </div>
    </div>
    <div class="plays">
      {#if items?.some((f) => !isFolder(f))}
        <button class="play" onclick={() => previewAll()}>
          <svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M8 5v14l11-7z" fill="currentColor" /></svg> Show all
        </button>
      {/if}
      {#if !virtual && items?.some((f) => isFolder(f))}
        <button class="play alt" onclick={() => previewAll(undefined, true)}>With subfolders</button>
      {/if}
    </div>
  </section>

  {#if mydrive.state === 'needs-full'}
    <div class="msg">Open DriveShare on your laptop once and allow full Drive access, then come back.</div>
  {:else if error}
    <div class="msg error">{error}</div>
  {:else if !shown}
    <div class="grid" style:--cols={cols}>{#each Array(10) as _}<div class="tile skel"><div class="art skeleton"></div></div>{/each}</div>
  {:else if shown.length === 0}
    <div class="msg">{virtual === 'recent' ? 'Folders you look through show up here, so you can carry on where you left off.' : 'Nothing here.'}</div>
  {:else}
    <div class="grid" bind:this={gridEl} style:--cols={cols}>
      {#each shown as f (f.id)}
        {@const t = isFolder(f) ? sizes.of(f.id) : undefined}
        {@const r = recentOf(f)}
        <button class="tile" data-id={f.id}
          onfocus={() => remember(f)}
          onkeydown={(e) => down(e, f)} onkeyup={(e) => up(e, f)}
          onclick={(e) => { if (e.detail > 0) open(f); }}
          oncontextmenu={(e) => { e.preventDefault(); menuFor = f; }}>
          <div class="art" class:folder={isFolder(f) && !r?.file}>
            {#if r?.file && !noThumb[r.file.id] && thumb(r.file as DFile, 520)}<img src={thumb(r.file as DFile, 520)} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={() => (noThumb = { ...noThumb, [r.file!.id]: true })} /><span class="badge">▶ Carry on</span>
            {:else if !isFolder(f) && !noThumb[f.id] && thumb(f, 520)}<img src={thumb(f, 520)} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={() => (noThumb = { ...noThumb, [f.id]: true })} />
            {:else}<FileIcon file={f} size={4} shared={f.shared} />{/if}
            {#if isVideo(f)}<span class="badge">▶ {duration(f.videoMediaMetadata?.durationMillis)}</span>{/if}
            {#if f.starred}<span class="star">★</span>{/if}
          </div>
          <div class="name">{f.name}</div>
          <div class="meta num">{r ? `${t && t.files ? `${t.files.toLocaleString()} files · ` : ''}viewed ${ago(new Date(r.at).toISOString())}` : isFolder(f) ? (t && t.files ? `${t.files.toLocaleString()} files · ${formatBytes(t.bytes)}` : 'Folder') : `${kindOf(f)} · ${formatBytes(bytesOf(f))} · ${ago(f.modifiedTime)}`}</div>
        </button>
      {/each}
    </div>
    {#if items && items.length > limit}<div class="more">{(items.length - limit).toLocaleString()} more below</div>{/if}
  {/if}

  <footer class="keys">
    <span><kbd>OK</kbd> open</span><span><kbd>hold OK</kbd> actions</span><span><kbd>Back</kbd> up</span>
  </footer>
</div>

{#if menuFor}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" data-modal onkeydown={(e) => { if (isBack(e)) { e.preventDefault(); e.stopPropagation(); menuFor = null; restoreFocus(); } }}>
    <div class="sheet">
      {#if menuFor.id === '__me'}
        <h2>{profiles.current ? `${profiles.current.name} · ` : ''}{account.user?.email}</h2>
        {#if profiles.active}<button use:autofocus onclick={() => { menuFor = null; profiles.leave(); }}>Switch profile</button>{/if}
        <button use:autofocus={!profiles.active} onclick={() => { menuFor = null; void account.signOut(); }}>Sign out</button>
        {#if !inTvApp}<button onclick={() => { menuFor = null; tv.toggle(); }}>Leave TV mode</button>{/if}
        <button onclick={() => { menuFor = null; restoreFocus(); }}>Close</button>
      {:else}
        {@const f = menuFor}
        <h2 class="ellipsis">{f.name}</h2>
        {@const r = recentOf(f)}
        <button use:autofocus onclick={() => { menuFor = null; open(f); }}>{r ? (r.file ? `Carry on from ${r.file.name}` : 'Show everything, one by one') : isFolder(f) ? 'Open' : 'View'}</button>
        {#if r}<button onclick={() => { menuFor = null; nav(`/drive/${f.id}`); }}>Open folder</button>
          <button onclick={() => { menuFor = null; previewAll(f); }}>Start from the first</button>
          <button onclick={() => { menuFor = null; forgetFolder(f.id); items = items?.filter((x) => x.id !== f.id) ?? null; restoreFocus(); }}>Remove from Recent</button>
        {:else if isFolder(f)}<button onclick={() => { menuFor = null; previewAll(f); }}>Show everything, one by one</button>
          <button onclick={() => { menuFor = null; previewAll(f, true); }}>Show everything, with subfolders</button>{/if}
        {#if profiles.can('share')}<button onclick={async () => { menuFor = null; if (await profiles.allow('share', (t) => toast.show(t))) sharing = f; }}>Share link (QR code)</button>{/if}
        {#if profiles.can('edit') && !r}<button onclick={() => { menuFor = null; void star(f); restoreFocus(); }}>{f.starred ? 'Remove star' : 'Star'}</button>{/if}
        {#if profiles.can('bin') && !r}<button class="danger" onclick={async () => { menuFor = null; if (await profiles.allow('bin', (t) => toast.show(t))) confirmBin = f; else restoreFocus(); }}>Move to bin</button>{/if}
        <button onclick={() => { menuFor = null; restoreFocus(); }}>Close</button>
      {/if}
    </div>
  </div>
{/if}
{#if sharing && drive}<ShareDialog {drive} file={sharing} onclose={() => { sharing = null; restoreFocus(); }} />{/if}
{#if confirmBin}
  <Prompt title={`Move “${confirmBin.name}” to the bin?`} ok="Move to bin" danger text="You can restore it from Drive's bin for 30 days."
    onok={() => { const f = confirmBin!; confirmBin = null; void bin(f); }} oncancel={() => { confirmBin = null; restoreFocus(); }} />
{/if}
<Toast />
<Saving />

<style>
  .tvroot { min-height: 100vh; padding: 0 2.4rem 3rem; background: radial-gradient(60rem 30rem at 0 0, rgb(124 156 255 / 0.12), transparent 60%), var(--bg); }
  .top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 1.4rem; padding: 1.1rem 0 0.9rem; background: linear-gradient(var(--bg) 70%, transparent); }
  .brand { display: flex; align-items: center; gap: 0.6rem; font-weight: 750; font-size: 1.1rem; }
  .brand img { width: 1.8rem; height: 1.8rem; }
  .places { display: flex; gap: 0.4rem; overflow: hidden; min-width: 0; flex: 1 1 auto; }
  .places button { border: 0; background: transparent; color: var(--muted); font-size: 0.95rem; font-weight: 650; padding: 0.45rem 1rem; border-radius: 99px; white-space: nowrap; max-width: 14rem; overflow: hidden; text-overflow: ellipsis; display: inline-block; }
  .places button.on { background: var(--raise); color: var(--ink); }
  .places button:focus { background: #fff; color: #0d0f12; }
  .me { width: 2.4rem; height: 2.4rem; border-radius: 50%; padding: 0; overflow: hidden; border: 0; background: var(--raise); display: grid; place-items: center; }
  .me img { width: 100%; height: 100%; }
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; margin: 0.6rem 0 1.2rem; }
  h1 { font-size: 2rem; letter-spacing: -0.02em; }
  .sub { color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem; }
  .hint { color: var(--faint); }
  kbd { font-family: inherit; font-size: 0.75em; padding: 0.05em 0.45em; border-radius: 0.3em; border: 1px solid var(--line-2); background: var(--panel); color: var(--ink-2); }
  .play { font-size: 1rem; padding: 0.7rem 1.4rem; border-radius: 99px; background: var(--accent); color: var(--accent-ink); border: 0; font-weight: 700; }
  .play:focus { background: #fff; }
  .plays { display: flex; gap: 0.6rem; }
  .play.alt { background: var(--raise); color: var(--ink); }
  .play.alt:focus { background: #fff; color: #0d0f12; }
  .grid { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 1.4rem 1.1rem; }
  .tile { min-width: 0; display: grid; gap: 0.35rem; text-align: left; padding: 0; border: 0; background: transparent; color: var(--ink); border-radius: 0.9rem; transition: transform 0.15s ease; }
  .tile:hover { background: transparent; }
  .tile:focus { outline: none; box-shadow: none; transform: scale(1.06); z-index: 1; }
  .tile:focus .art { box-shadow: 0 0 0 0.2rem #fff, 0 1.2rem 2.4rem -0.6rem rgb(0 0 0 / 0.8); }
  .art { position: relative; aspect-ratio: 16 / 10; border-radius: 0.8rem; overflow: hidden; background: var(--panel); display: grid; place-items: center; border: 1px solid var(--line); }
  .art.folder { background: linear-gradient(145deg, #1f2a44, #151a24); }
  .art img { width: 100%; height: 100%; object-fit: cover; }
  .badge { position: absolute; right: 0.4rem; bottom: 0.4rem; font-size: 0.65rem; font-weight: 700; background: rgb(0 0 0 / 0.7); padding: 0.15rem 0.45rem; border-radius: 0.35rem; }
  .star { position: absolute; left: 0.45rem; top: 0.3rem; color: var(--warn); font-size: 0.9rem; }
  .name { font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 0.15rem; }
  .meta { font-size: 0.65rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 0.15rem; }
  .tile:focus .name { color: #fff; }
  .skel .art { border: 0; }
  .more { text-align: center; color: var(--faint); margin-top: 1.5rem; font-size: 0.8rem; }
  .msg { margin-top: 4rem; text-align: center; color: var(--muted); font-size: 1.1rem; }
  .keys { position: fixed; left: 0; right: 0; bottom: 0; display: flex; justify-content: center; gap: 1.6rem; padding: 0.6rem; font-size: 0.7rem; color: var(--faint); background: linear-gradient(transparent, rgb(13 15 18 / 0.95) 50%); pointer-events: none; }
  .scrim { position: fixed; inset: 0; z-index: 50; background: rgb(5 6 8 / 0.7); display: grid; place-items: center; }
  .sheet { width: 26rem; max-width: 90vw; display: grid; gap: 0.5rem; background: var(--panel); border: 1px solid var(--line-2); border-radius: 1.2rem; padding: 1.4rem; }
  .sheet h2 { font-size: 1.15rem; margin-bottom: 0.4rem; }
  .sheet button { font-size: 1rem; padding: 0.8rem 1.1rem; border-radius: 0.8rem; justify-content: flex-start; }
  .sheet button:focus { background: #fff; color: #0d0f12; outline: none; box-shadow: none; }
</style>
