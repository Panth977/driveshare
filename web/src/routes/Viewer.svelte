<script lang="ts">
  // The viewer: every file of a folder, one by one. Arrow keys (or the remote) step through;
  // Delete bins the one on screen (with Undo); C comments; S makes a share link; I shows details.
  import { onDestroy, onMount, tick } from 'svelte';
  import { formatBytes } from '@driveshare/backend/shared';
  import { mydrive } from '../lib/mydrive.svelte.ts';
  import { sizes } from '../lib/sizes.svelte.ts';
  import { nav } from '../lib/router.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { editable, isBack, tv } from '../lib/tv.svelte.ts';
  import { ago, bytesOf, driveLink, duration, failText, isAudio, isFolder, isImage, isMedia, isPdf, isVideo, kindOf, thumb, type DComment, type DFile } from '../lib/gdrive.ts';
  import FileIcon from '../components/drive/FileIcon.svelte';
  import ShareDialog from '../components/drive/ShareDialog.svelte';
  import TopBar from '../components/TopBar.svelte';
  import Toast from '../components/Toast.svelte';

  let { folderId, fileId }: { folderId: string; fileId: string } = $props();

  const VIRTUAL: Record<string, string> = { recent: 'Recent photos and videos', starred: 'Starred' };
  let all = $state<DFile[] | null>(null);
  let folder = $state<DFile | null>(null);
  let loadError = $state('');
  let index = $state(0);
  let onlyMedia = $state(localStorage.getItem('ds.v.media') !== '0');
  let deep = $state(false);
  let panel = $state<'' | 'info' | 'comments'>('');
  let chrome = $state(true);
  let sharing = $state<DFile | null>(null);
  let comments = $state<DComment[] | null>(null);
  let draft = $state('');
  let posting = $state(false);
  let full = $state<Record<string, string>>({});
  let commentBox = $state<HTMLTextAreaElement | null>(null);
  let stageEl = $state<HTMLElement | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let recents = $state<{ id: string; name: string }[]>(JSON.parse(localStorage.getItem('ds.v.recent') ?? '[]'));

  $effect(() => { void mydrive.start(); });
  const drive = $derived(mydrive.drive);

  const list = $derived(all ? (onlyMedia && all.some(isMedia) ? all.filter(isMedia) : all) : null);
  const cur = $derived(list?.[Math.min(index, (list?.length ?? 1) - 1)]);

  async function collect(id: string): Promise<DFile[]> {
    const d = drive!;
    if (id === 'recent') return d.query(`(mimeType contains 'image/' or mimeType contains 'video/') and trashed = false`, { orderBy: 'modifiedTime desc', max: 500 });
    if (id === 'starred') return (await d.query('starred = true and trashed = false')).filter((f) => !isFolder(f));
    if (!deep) return (await d.children(id, { orderBy: 'name_natural' })).filter((f) => !isFolder(f));
    // Subfolders too: breadth first, up to 5,000 files.
    const out: DFile[] = [];
    let level = [id];
    while (level.length && out.length < 5000) {
      const next: string[] = [];
      for (const fid of level) {
        for (const f of await d.children(fid, { orderBy: 'name_natural' })) (isFolder(f) ? next.push(f.id) : out.push(f));
      }
      level = next;
    }
    return out;
  }

  async function load() {
    if (!drive || !folderId) return;
    all = null;
    loadError = '';
    try {
      folder = VIRTUAL[folderId] ? { id: folderId, name: VIRTUAL[folderId]!, mimeType: 'virtual' } : await drive.get(folderId);
      const files = await collect(folderId);
      all = files;
      const wanted = fileId ? (onlyMedia && files.some(isMedia) ? files.filter(isMedia) : files).findIndex((f) => f.id === fileId) : -1;
      if (fileId && wanted < 0 && onlyMedia) { onlyMedia = false; }
      await tick();
      index = Math.max(0, list?.findIndex((f) => f.id === fileId) ?? 0);
      if (folder && !VIRTUAL[folderId]) {
        recents = [{ id: folder.id, name: folder.id === mydrive.rootId ? 'My Drive' : folder.name }, ...recents.filter((r) => r.id !== folder!.id)].slice(0, 8);
        localStorage.setItem('ds.v.recent', JSON.stringify(recents));
      }
    } catch (e) { loadError = failText(e); }
  }
  $effect(() => { void folderId; void deep; if (drive) void load(); });
  $effect(() => { localStorage.setItem('ds.v.media', onlyMedia ? '1' : '0'); });

  // Keep the URL on the file you are looking at (replace, so Back leaves the viewer).
  $effect(() => {
    const c = cur;
    if (c && folderId && c.id !== fileId) history.replaceState(null, '', `/view/${folderId}/${c.id}`);
  });

  // Comments of the file on screen, when the panel is open.
  $effect(() => {
    const c = cur;
    comments = null;
    if (!c || panel !== 'comments' || !drive) return;
    drive.comments(c.id).then((l) => { if (cur?.id === c.id) comments = l; }, (e) => toast.show(failText(e)));
  });

  // Images: a big thumbnail first (fast); originals load for files without one, and PDFs.
  $effect(() => {
    const c = cur;
    if (!c || !drive) return;
    const need = (isImage(c) && !c.thumbnailLink) || isPdf(c);
    if (need && !full[c.id]) drive.mediaUrl(c).then((u) => (full = { ...full, [c.id]: u }), () => {});
    // Warm the next two pictures.
    for (const n of [index + 1, index + 2]) {
      const f = list?.[n];
      const src = f && thumb(f, px());
      if (src) new Image().src = src;
    }
  });

  const px = () => Math.min(2560, Math.round(Math.max(innerWidth, innerHeight) * Math.min(2, devicePixelRatio || 1)));

  function go(i: number) {
    if (!list?.length) return;
    index = Math.max(0, Math.min(list.length - 1, i));
    wake();
  }

  async function binCurrent() {
    const f = cur;
    if (!f || !drive || !all) return;
    try {
      await drive.update(f.id, { trashed: true });
      sizes.local({ id: f.id, removed: true });
      const at = index;
      all = all.filter((x) => x.id !== f.id);
      if (index >= (list?.length ?? 0)) index = Math.max(0, (list?.length ?? 1) - 1);
      toast.show(`Binned ${f.name}`, { label: 'Undo', run: async () => {
        const back = await drive.update(f.id, { trashed: false });
        sizes.local(back);
        const pos = Math.min(at, all!.length);
        all = [...all!.slice(0, pos), { ...f }, ...all!.slice(pos)];
        index = list?.findIndex((x) => x.id === f.id) ?? index;
      } });
    } catch (e) { toast.show(failText(e)); }
  }

  async function star() {
    const f = cur;
    if (!f || !drive) return;
    const r = await drive.update(f.id, { starred: !f.starred }).catch((e) => { toast.show(failText(e)); return null; });
    if (r && all) all = all.map((x) => (x.id === f.id ? { ...x, starred: r.starred } : x));
    if (r) toast.show(r.starred ? 'Starred' : 'Star removed', undefined, 1500);
  }

  async function post(e?: SubmitEvent) {
    e?.preventDefault();
    const f = cur;
    if (!f || !drive || !draft.trim()) return;
    posting = true;
    try {
      const c = await drive.addComment(f.id, draft.trim());
      comments = [...(comments ?? []), c];
      draft = '';
    } catch (err) { toast.show(failText(err)); }
    posting = false;
  }

  async function openComments() {
    panel = 'comments';
    await tick();
    commentBox?.focus();
  }

  function back() {
    if (panel) { panel = ''; return; }
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    if (VIRTUAL[folderId]) nav('/view');
    else nav(folderId === mydrive.rootId ? '/drive' : `/drive/${folderId}`);
  }

  function key(e: KeyboardEvent) {
    if (!folderId || sharing) return;
    if (editable(e.target)) {
      if (e.key === 'Escape') { (e.target as HTMLElement).blur(); e.preventDefault(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) { if (e.key === 'Backspace' && e.metaKey) { e.preventDefault(); void binCurrent(); } return; }
    // On a TV, arrows inside the toolbar or panel move focus there; on the picture they step through files.
    const inChrome = (e.target as HTMLElement)?.closest?.('[data-chrome]');
    if (tv.on && inChrome && e.key.startsWith('Arrow')) { wake(); return; }
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': case 'MediaTrackNext': go(index + 1); break;
      case 'ArrowLeft': case 'PageUp': case 'MediaTrackPrevious': go(index - 1); break;
      case 'Home': go(0); break;
      case 'End': go((list?.length ?? 1) - 1); break;
      case 'Delete': case 'd': case 'D': case 'ColorF0Red': void binCurrent(); break;
      case 'c': case 'C': void openComments(); break;
      case 'i': case 'I': panel = panel === 'info' ? '' : 'info'; break;
      case 's': case 'S': if (cur) sharing = cur; break;
      case '*': case 'ColorF2Yellow': void star(); break;
      case 'f': case 'F': void toggleFull(); break;
      case ' ': case 'MediaPlayPause': case 'Enter':
        if (videoEl) { videoEl.paused ? void videoEl.play() : videoEl.pause(); }
        else if (e.key === 'Enter') { chrome = !chrome; }
        else go(index + 1);
        break;
      case 'ArrowUp': case 'ArrowDown':
        // Show the toolbar and let spatial navigation move focus into it.
        wake();
        if (tv.on) { handled = false; break; }
        if (videoEl && e.key === 'ArrowUp') videoEl.volume = Math.min(1, videoEl.volume + 0.1);
        else if (videoEl) videoEl.volume = Math.max(0, videoEl.volume - 0.1);
        break;
      default:
        if (isBack(e)) back(); else handled = false;
    }
    if (handled) e.preventDefault();
  }

  async function toggleFull() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stageEl?.closest('.viewer')?.requestFullscreen().catch(() => {});
  }

  // The toolbar fades away while you watch, and comes back on any movement or key.
  let idle: ReturnType<typeof setTimeout> | null = null;
  function wake() {
    chrome = true;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { if (!panel && !sharing) chrome = false; }, tv.on ? 4500 : 3000);
  }
  onMount(() => wake());
  onDestroy(() => { if (idle) clearTimeout(idle); for (const u of Object.values(full)) if (u.startsWith('blob:')) URL.revokeObjectURL(u); });

  // Swipe on phones and touch screens.
  let touchX = 0;
  const strip = $derived.by(() => {
    if (!list) return [];
    const from = Math.max(0, index - 30), to = Math.min(list.length, index + 31);
    return list.slice(from, to).map((f, k) => ({ f, i: from + k }));
  });
  $effect(() => {
    void index;
    queueMicrotask(() => document.querySelector('.strip .on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }));
  });
</script>

<svelte:window onkeydown={key} onmousemove={wake} />

{#if !folderId}
  <TopBar tabs />
  <main class="wrap stack" style="gap:1.4rem">
    <div>
      <h1>Viewer</h1>
      <p class="muted" style="margin:0.3rem 0 0">Look through a folder one file at a time. <span class="kbd">←</span> <span class="kbd">→</span> to move, <span class="kbd">Del</span> to bin, <span class="kbd">C</span> to comment, <span class="kbd">S</span> to share.</p>
    </div>
    <div class="picks">
      <button class="pick hero" onclick={() => nav('/view/recent')}>
        <span class="pi">✦</span><b>Recent photos and videos</b><span class="small muted">The latest 500 across your Drive</span>
      </button>
      <button class="pick" onclick={() => nav('/view/starred')}><span class="pi">★</span><b>Starred</b><span class="small muted">Everything you starred</span></button>
      <button class="pick" onclick={() => nav('/drive')}><span class="pi">⌘</span><b>Pick a folder</b><span class="small muted">In My Drive: right-click › Preview all</span></button>
    </div>
    {#if recents.length}
      <section class="stack" style="gap:0.6rem">
        <h3>Recently viewed folders</h3>
        <div class="picks">
          {#each recents as r (r.id)}
            <button class="pick slim" onclick={() => nav(`/view/${r.id}`)}><FileIcon file={{ mimeType: 'application/vnd.google-apps.folder', name: '' }} size={1.6} /><b class="ellipsis">{r.name}</b>{#if sizes.of(r.id)}<span class="tiny muted num">{formatBytes(sizes.of(r.id)!.bytes)} · {sizes.of(r.id)!.files.toLocaleString()} files</span>{/if}</button>
          {/each}
        </div>
      </section>
    {/if}
  </main>
{:else}
  <div class="viewer" class:hide={!chrome} class:withpanel={!!panel}>
    <header class="top" data-chrome>
      <button class="ghost" onclick={back} aria-label="Back">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 18l-6-6 6-6"/></svg>{folder?.id === mydrive.rootId ? 'My Drive' : (folder?.name ?? '')}
      </button>
      <div class="ttl">
        <div class="ellipsis nm">{cur?.name ?? ''}{#if cur?.starred} <span class="star">★</span>{/if}</div>
        {#if list}<div class="tiny muted num">{list.length ? index + 1 : 0} of {list.length}{cur ? ` · ${kindOf(cur)} · ${formatBytes(bytesOf(cur))}` : ''}</div>{/if}
      </div>
      <div class="acts">
        <label class="tog small"><input type="checkbox" bind:checked={onlyMedia} /> Photos & videos only</label>
        {#if !VIRTUAL[folderId]}<label class="tog small"><input type="checkbox" bind:checked={deep} /> Subfolders</label>{/if}
        <button class="ghost icon" title="Star (*)" aria-label="Star" onclick={star}>{cur?.starred ? '★' : '☆'}</button>
        <button class="ghost" title="Comment (C)" onclick={openComments}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/></svg>Comment</button>
        <button class="ghost" title="Share link (S)" onclick={() => cur && (sharing = cur)}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>Share</button>
        <button class="ghost icon" title="Details (I)" aria-label="Details" onclick={() => (panel = panel === 'info' ? '' : 'info')}>ⓘ</button>
        {#if cur}<a class="btn ghost icon" title="Open in Google Drive" aria-label="Open in Google Drive" href={driveLink(cur)} target="_blank" rel="noopener">↗</a>{/if}
        <button class="ghost danger" title="Move to bin (Del)" onclick={binCurrent}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>Bin</button>
      </div>
    </header>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="stage" bind:this={stageEl}
      ontouchstart={(e) => (touchX = e.touches[0]?.clientX ?? 0)}
      ontouchend={(e) => { const dx = (e.changedTouches[0]?.clientX ?? 0) - touchX; if (Math.abs(dx) > 50) go(index + (dx < 0 ? 1 : -1)); else wake(); }}>
      {#if loadError}
        <div class="msg"><p class="error">{loadError}</p></div>
      {:else if !list || !mydrive.drive}
        <div class="msg"><span class="spin"></span></div>
      {:else if !cur}
        <div class="msg"><p class="muted">Nothing to show here{onlyMedia ? ' (photos and videos only is on)' : ''}.</p></div>
      {:else}
        {#key cur.id}
          {#if isVideo(cur)}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video bind:this={videoEl} src={mydrive.drive.streamUrl(cur)} poster={thumb(cur, px())} controls autoplay playsinline onclick={(e) => e.stopPropagation()}></video>
          {:else if isImage(cur)}
            <img class="pic" src={full[cur.id] ?? thumb(cur, px())} alt={cur.name} referrerpolicy="no-referrer" />
          {:else if isAudio(cur)}
            <div class="msg"><FileIcon file={cur} size={6} /><audio src={mydrive.drive.streamUrl(cur)} controls autoplay onclick={(e) => e.stopPropagation()}></audio></div>
          {:else if isPdf(cur) && full[cur.id]}
            <iframe class="doc" src={full[cur.id]} title={cur.name}></iframe>
          {:else if cur.mimeType.startsWith('application/vnd.google-apps') || isPdf(cur) || cur.mimeType.startsWith('text/')}
            <iframe class="doc" src={`https://drive.google.com/file/d/${cur.id}/preview`} title={cur.name} allow="autoplay"></iframe>
          {:else}
            <div class="msg">
              {#if thumb(cur, 900)}<img class="pic small-pic" src={thumb(cur, 900)} alt="" referrerpolicy="no-referrer" />{:else}<FileIcon file={cur} size={7} />{/if}
              <p class="muted">{cur.name}</p>
              <a class="btn" href={driveLink(cur)} target="_blank" rel="noopener" onclick={(e) => e.stopPropagation()}>Open in Google Drive</a>
            </div>
          {/if}
        {/key}
        {#if index > 0}<button class="nav l" data-chrome aria-label="Previous" onclick={(e) => { e.stopPropagation(); go(index - 1); }}>‹</button>{/if}
        {#if index < list.length - 1}<button class="nav r" data-chrome aria-label="Next" onclick={(e) => { e.stopPropagation(); go(index + 1); }}>›</button>{/if}
      {/if}
    </div>

    {#if list && list.length > 1}
      <div class="strip" data-chrome data-nav-skip>
        {#each strip as { f, i } (f.id)}
          <button class:on={i === index} tabindex="-1" onclick={() => go(i)} aria-label={f.name}>
            {#if thumb(f, 160)}<img src={thumb(f, 160)} alt="" loading="lazy" referrerpolicy="no-referrer" />{:else}<FileIcon file={f} size={1.6} />{/if}
            {#if isVideo(f)}<span class="pl">▶</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if panel && cur}
      <aside class="panel" data-chrome>
        <div class="row spread">
          <div class="seg">
            <button class:on={panel === 'info'} onclick={() => (panel = 'info')}>Details</button>
            <button class:on={panel === 'comments'} onclick={() => void openComments()}>Comments</button>
          </div>
          <button class="ghost icon" aria-label="Close" onclick={() => (panel = '')}>✕</button>
        </div>
        {#if panel === 'info'}
          <h3 class="pn">{cur.name}</h3>
          <dl>
            <dt>Kind</dt><dd>{kindOf(cur)}</dd>
            <dt>Size</dt><dd class="num">{formatBytes(bytesOf(cur))}</dd>
            {#if cur.imageMediaMetadata?.width}<dt>Pixels</dt><dd class="num">{cur.imageMediaMetadata.width} × {cur.imageMediaMetadata.height}</dd>{/if}
            {#if cur.imageMediaMetadata?.cameraModel}<dt>Camera</dt><dd>{cur.imageMediaMetadata.cameraModel}</dd>{/if}
            {#if cur.imageMediaMetadata?.time}<dt>Taken</dt><dd>{cur.imageMediaMetadata.time}</dd>{/if}
            {#if cur.videoMediaMetadata}<dt>Length</dt><dd class="num">{duration(cur.videoMediaMetadata.durationMillis)}</dd><dt>Video</dt><dd class="num">{cur.videoMediaMetadata.width} × {cur.videoMediaMetadata.height}</dd>{/if}
            <dt>Created</dt><dd>{cur.createdTime ? new Date(cur.createdTime).toLocaleString() : ''}</dd>
            <dt>Modified</dt><dd>{cur.modifiedTime ? new Date(cur.modifiedTime).toLocaleString() : ''}</dd>
            <dt>Shared</dt><dd>{cur.shared ? 'Yes' : 'No'}</dd>
          </dl>
          <div class="row">
            <button class="small" onclick={() => (sharing = cur!)}>Share link</button>
            <a class="btn small" href={driveLink(cur)} target="_blank" rel="noopener">Open in Drive</a>
          </div>
        {:else}
          <div class="comments">
            {#if comments === null}<p class="muted small"><span class="spin"></span></p>
            {:else if comments.length === 0}<p class="muted small">No comments yet.</p>
            {:else}
              {#each comments as c (c.id)}
                <div class="cm">
                  <div class="tiny muted">{c.author?.displayName ?? 'Someone'} · {ago(c.createdTime)}{c.resolved ? ' · resolved' : ''}</div>
                  <div class="small">{c.content}</div>
                </div>
              {/each}
            {/if}
          </div>
          <form class="stack" style="gap:0.5rem" onsubmit={post}>
            <textarea bind:this={commentBox} bind:value={draft} rows="3" placeholder="Add a comment (saved on the file in Google Drive)"></textarea>
            <div class="row spread"><span class="tiny faint"><span class="kbd">⌘ ↵</span> to post · <span class="kbd">Esc</span> back</span><button class="primary small" disabled={posting || !draft.trim()}>{posting ? 'Posting…' : 'Post'}</button></div>
          </form>
        {/if}
      </aside>
    {/if}

    <div class="keys tiny faint" data-chrome>
      <span class="kbd">←</span><span class="kbd">→</span> move · <span class="kbd">Del</span> bin · <span class="kbd">C</span> comment · <span class="kbd">S</span> share · <span class="kbd">I</span> details · <span class="kbd">F</span> full screen · <span class="kbd">Esc</span> back
    </div>
  </div>
{/if}

{#if sharing && drive}<ShareDialog {drive} file={sharing} onclose={() => (sharing = null)} />{/if}
<Toast />

<style>
  .picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 0.9rem; }
  .pick { display: grid; justify-items: start; gap: 0.35rem; padding: 1.2rem; border-radius: 16px; background: var(--panel); border: 1px solid var(--line); text-align: left; font-weight: 500; }
  .pick b { font-size: 1rem; }
  .pick.hero { background: linear-gradient(135deg, rgb(124 156 255 / 0.22), rgb(79 209 161 / 0.08)), var(--panel); border-color: rgb(124 156 255 / 0.35); }
  .pick.slim { grid-template-columns: auto 1fr; align-items: center; padding: 0.8rem 1rem; }
  .pick.slim .tiny { grid-column: 2; }
  .pi { font-size: 1.4rem; color: var(--accent-2); }

  .viewer { position: fixed; inset: 0; background: #050607; display: grid; grid-template-rows: auto 1fr auto; grid-template-columns: 1fr; z-index: 30; }
  .viewer.withpanel { grid-template-columns: 1fr 22rem; }
  .top { grid-column: 1 / -1; display: flex; align-items: center; gap: 0.8rem; padding: 0.6rem 0.9rem; background: linear-gradient(180deg, rgb(5 6 7 / 0.95), rgb(5 6 7 / 0.6)); border-bottom: 1px solid rgb(255 255 255 / 0.05); z-index: 3; transition: opacity 0.25s; }
  .ttl { flex: 1; min-width: 0; text-align: center; }
  .nm { font-weight: 640; }
  .star { color: var(--warn); }
  .acts { display: flex; align-items: center; gap: 0.25rem; flex-wrap: wrap; justify-content: flex-end; }
  .tog { display: inline-flex; flex-direction: row; align-items: center; gap: 0.35rem; color: var(--muted); font-weight: 500; padding: 0 0.4rem; white-space: nowrap; }
  .stage { position: relative; display: grid; place-items: center; overflow: hidden; min-height: 0; }
  .pic, video { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; display: block; animation: fade 0.18s ease-out; }
  .small-pic { width: auto; height: auto; max-height: 50vh; border-radius: 12px; }
  @keyframes fade { from { opacity: 0.2; } }
  .doc { width: min(1100px, 100%); height: 100%; border: 0; background: #fff; }
  .msg { display: grid; justify-items: center; gap: 1rem; text-align: center; padding: 2rem; }
  .nav { position: absolute; top: 50%; transform: translateY(-50%); width: 3.4rem; height: 5rem; font-size: 2.6rem; line-height: 1; border-radius: 14px; background: rgb(0 0 0 / 0.35); border: 1px solid rgb(255 255 255 / 0.08); color: #fff; justify-content: center; transition: opacity 0.25s; }
  .nav:hover { background: rgb(0 0 0 / 0.6); }
  .nav.l { left: 1rem; }
  .nav.r { right: 1rem; }
  .strip { grid-column: 1; display: flex; gap: 0.35rem; padding: 0.55rem 0.8rem 0.7rem; overflow-x: auto; background: linear-gradient(0deg, rgb(5 6 7 / 0.95), rgb(5 6 7 / 0.7)); transition: opacity 0.25s; scrollbar-width: none; }
  .strip button { position: relative; flex: none; width: 4.2rem; height: 3.1rem; padding: 0; border-radius: 8px; overflow: hidden; border: 2px solid transparent; background: var(--panel); opacity: 0.55; display: grid; place-items: center; }
  .strip button.on { border-color: var(--accent); opacity: 1; transform: scale(1.06); }
  .strip button:hover { opacity: 0.9; }
  .strip img { width: 100%; height: 100%; object-fit: cover; }
  .pl { position: absolute; font-size: 0.7rem; color: #fff; text-shadow: 0 1px 4px #000; }
  .panel { grid-row: 2 / 4; grid-column: 2; background: var(--panel); border-left: 1px solid var(--line); padding: 1rem; display: flex; flex-direction: column; gap: 1rem; overflow: auto; }
  .seg { display: flex; background: var(--bg-2); border-radius: 9px; padding: 0.15rem; border: 1px solid var(--line); }
  .seg button { border: 0; background: none; font-size: 0.8rem; padding: 0.35rem 0.7rem; color: var(--muted); border-radius: 7px; }
  .seg button.on { background: var(--raise); color: var(--ink); }
  .pn { word-break: break-word; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 0.9rem; margin: 0; font-size: 0.84rem; }
  dt { color: var(--faint); }
  dd { margin: 0; color: var(--ink-2); }
  .comments { flex: 1; display: grid; gap: 0.6rem; align-content: start; }
  .cm { padding: 0.65rem 0.75rem; border-radius: 10px; background: var(--panel-2); display: grid; gap: 0.25rem; }
  .keys { position: absolute; left: 50%; bottom: 4.6rem; transform: translateX(-50%); background: rgb(0 0 0 / 0.55); padding: 0.35rem 0.7rem; border-radius: 99px; white-space: nowrap; transition: opacity 0.25s; pointer-events: none; }
  .keys .kbd { margin: 0 0.1rem; }
  .hide .top, .hide .strip, .hide .nav, .hide .keys { opacity: 0; pointer-events: none; }
  .hide { cursor: none; }
  @media (max-width: 760px) {
    .viewer.withpanel { grid-template-columns: 1fr; }
    .panel { position: fixed; inset: auto 0 0 0; max-height: 60vh; grid-column: 1; border-radius: 16px 16px 0 0; z-index: 5; }
    .acts .tog, .keys { display: none; }
    .acts button:not(.icon) { font-size: 0; gap: 0; }
  }
</style>
