<script lang="ts">
  // My Drive: a Finder for the whole Drive. List, grid and column views; real folder sizes and
  // counts (from the size index); a right-click menu; drop folders to upload (resumable).
  import { formatBytes } from '@driveshare/backend/shared';
  import { account } from '../lib/account.svelte.ts';
  import { mydrive } from '../lib/mydrive.svelte.ts';
  import { sizes } from '../lib/sizes.svelte.ts';
  import { uploader, readDrop, fromInput } from '../lib/uploader.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { nav } from '../lib/router.svelte.ts';
  import { editable, isBack, tv } from '../lib/tv.svelte.ts';
  import { ago, bytesOf, driveLink, duration, failText, isFolder, isMedia, kindOf, thumb, type DFile } from '../lib/gdrive.ts';
  import { children as cacheChildren, remember } from '../lib/listcache.ts';
  import { linked } from '../lib/linked.svelte.ts';
  import FileIcon from '../components/drive/FileIcon.svelte';
  import Menu, { type MenuItem } from '../components/drive/Menu.svelte';
  import Prompt from '../components/drive/Prompt.svelte';
  import ShareDialog from '../components/drive/ShareDialog.svelte';
  import UploadPanel from '../components/drive/UploadPanel.svelte';
  import Toast from '../components/Toast.svelte';

  let { folderId }: { folderId: string } = $props();

  type View = 'list' | 'grid' | 'columns';
  type SortKey = 'name' | 'size' | 'modified' | 'kind';
  const VIRTUAL: Record<string, string> = { recent: 'Recent', starred: 'Starred', shared: 'Shared with me', search: 'Search' };

  let view = $state<View>((localStorage.getItem('ds.view') as View) || 'list');
  let sortKey = $state<SortKey>((localStorage.getItem('ds.sort') as SortKey) || 'name');
  let sortDir = $state<1 | -1>(Number(localStorage.getItem('ds.sortDir')) === -1 ? -1 : 1);
  $effect(() => { localStorage.setItem('ds.view', view); localStorage.setItem('ds.sort', sortKey); localStorage.setItem('ds.sortDir', String(sortDir)); });

  let q = $state(new URLSearchParams(location.search).get('q') ?? '');
  let items = $state<DFile[] | null>(null);
  let loadError = $state('');
  let selected = $state('');
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let prompt = $state<{ title: string; label?: string; value?: string; ok: string; danger?: boolean; text?: string; run: (v: string) => void } | null>(null);
  let sharing = $state<DFile | null>(null);
  let over = $state(false);
  let path = $state<DFile[]>([]);
  let filesInput = $state<HTMLInputElement | null>(null);
  let folderInput = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLElement | null>(null);

  const known = new Map<string, DFile>();
  const kids = new Map<string, DFile[]>();
  let colLists = $state<Record<string, DFile[]>>({});

  $effect(() => { void mydrive.start(); });

  const virtual = $derived(VIRTUAL[folderId] ? folderId : '');
  const current = $derived(virtual ? '' : folderId || mydrive.rootId);
  const drive = $derived(mydrive.drive);

  async function load(id: string, force = false): Promise<DFile[]> {
    if (!force && kids.has(id)) return kids.get(id)!;
    const take = (list: DFile[]) => {
      for (const f of list) known.set(f.id, f);
      kids.set(id, list);
      colLists[id] = list;
      if (id === current && !virtual) items = list;
    };
    // Cached copy at once; Drive's answer replaces it in the background when something changed.
    const list = force ? await drive!.children(id).then((l) => { if (!drive!.demo) void remember(id, l); return l; }) : await cacheChildren(drive!, id, take);
    take(list);
    return list;
  }

  async function refresh(force = true) {
    if (!drive) return;
    loadError = '';
    try {
      if (virtual === 'recent') items = await drive.query(`mimeType != 'application/vnd.google-apps.folder' and trashed = false`, { orderBy: 'modifiedTime desc', max: 200 });
      else if (virtual === 'shared') items = await drive.query('sharedWithMe = true and trashed = false', { orderBy: 'folder,modifiedTime desc', max: 500 });
      else if (virtual === 'starred') items = await drive.query('starred = true and trashed = false', { orderBy: 'folder,name_natural' });
      else if (virtual === 'search') items = q.trim() ? await drive.query(`name contains '${q.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`, { orderBy: 'folder,modifiedTime desc', max: 300 }) : [];
      else if (current) items = await load(current, force);
      for (const f of items ?? []) known.set(f.id, f);
    } catch (e) { loadError = failText(e); }
  }

  // Reload when the folder changes.
  $effect(() => {
    void current; void virtual;
    if (!drive) return;
    items = null;
    selected = '';
    void refresh(false).then(() => { if (!selected && items?.[0]) selected = items[0].id; });
    void buildPath();
  });

  /** Breadcrumbs: walk up the parents (cached). */
  async function buildPath() {
    if (!drive || !current) { path = []; return; }
    const chain: DFile[] = [];
    let id: string | undefined = current;
    for (let i = 0; id && i < 30; i++) {
      let f = known.get(id);
      if (!f || !f.parents) { f = await drive.get(id).catch(() => undefined); if (f) known.set(f.id, f); }
      if (!f) break;
      chain.unshift(f);
      if (f.id === mydrive.rootId) break;
      id = f.parents?.[0];
    }
    path = chain;
    if (view === 'columns') for (const p of chain) void load(p.id);
  }

  $effect(() => { if (view === 'columns') for (const p of path) void load(p.id); });

  uploader.onFinished = () => { void refresh(true); void mydrive.refreshQuota(); };

  // ── sizes and sorting ──
  const folderTotals = (f: DFile) => (isFolder(f) ? sizes.of(f.id) : undefined);
  const sizeOf = (f: DFile) => (isFolder(f) ? (folderTotals(f)?.bytes ?? -1) : bytesOf(f));

  function sorted(list: DFile[]): DFile[] {
    void sizes.version;
    const k = sortKey, d = sortDir;
    return [...list].sort((a, b) => {
      const fa = isFolder(a), fb = isFolder(b);
      if (fa !== fb && k !== 'size') return fa ? -1 : 1;
      let c = 0;
      if (k === 'size') c = sizeOf(a) - sizeOf(b);
      else if (k === 'modified') c = String(a.modifiedTime).localeCompare(String(b.modifiedTime));
      else if (k === 'kind') c = kindOf(a).localeCompare(kindOf(b));
      if (!c) c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return c * d;
    });
  }
  const shown = $derived(items ? sorted(items) : null);
  const here = $derived(current ? sizes.of(current) : undefined);
  const maxSize = $derived(shown ? Math.max(1, ...shown.map(sizeOf)) : 1);
  const sel = $derived(shown?.find((f) => f.id === selected));
  const title = $derived(virtual ? VIRTUAL[virtual]! : path.at(-1)?.id === mydrive.rootId ? 'My Drive' : (path.at(-1)?.name ?? ''));

  function setSort(k: SortKey) {
    if (sortKey === k) sortDir = sortDir === 1 ? -1 : 1;
    else { sortKey = k; sortDir = k === 'size' || k === 'modified' ? -1 : 1; }
  }

  // ── actions ──
  function open(f: DFile) {
    if (isFolder(f)) nav(`/drive/${f.id}`);
    else nav(`/view/${f.parents?.[0] ?? current ?? 'root'}/${f.id}`);
  }
  const preview = (folder: DFile | string) => nav(`/view/${typeof folder === 'string' ? folder : folder.id}`);

  async function trash(f: DFile) {
    try {
      await drive!.update(f.id, { trashed: true });
      items = items?.filter((x) => x.id !== f.id) ?? null;
      for (const [k, l] of kids) kids.set(k, l.filter((x) => x.id !== f.id));
      sizes.local({ id: f.id, removed: true });
      toast.show(`Moved “${f.name}” to the bin`, { label: 'Undo', run: () => void untrash(f) });
    } catch (e) { toast.show(failText(e)); }
  }
  async function untrash(f: DFile) {
    const back = await drive!.update(f.id, { trashed: false });
    sizes.local(back);
    await refresh(true);
    selected = f.id;
  }
  async function star(f: DFile) {
    const r = await drive!.update(f.id, { starred: !f.starred }).catch((e) => { toast.show(failText(e)); return null; });
    if (r && items) items = items.map((x) => (x.id === f.id ? { ...x, starred: r.starred } : x));
  }
  function rename(f: DFile) {
    prompt = { title: 'Rename', label: 'Name', value: f.name, ok: 'Rename', run: async (name) => {
      prompt = null;
      if (!name || name === f.name) return;
      try {
        const r = await drive!.update(f.id, { name });
        if (items) items = items.map((x) => (x.id === f.id ? { ...x, name: r.name } : x));
      } catch (e) { toast.show(failText(e)); }
    } };
  }
  function newFolder() {
    if (!current) return;
    prompt = { title: 'New folder', label: 'Name', value: 'Untitled folder', ok: 'Create', run: async (name) => {
      prompt = null;
      if (!name) return;
      try {
        const f = await drive!.createFolder(name, current);
        sizes.local(f);
        await refresh(true);
        selected = f.id;
      } catch (e) { toast.show(failText(e)); }
    } };
  }
  function askTrash(f: DFile) {
    const t = isFolder(f) ? folderTotals(f) : undefined;
    prompt = { title: `Move “${f.name}” to the bin?`, ok: 'Move to bin', danger: true,
      text: t ? `${formatBytes(t.bytes)} in ${t.files.toLocaleString()} files. You can restore it from Drive's bin for 30 days.` : 'You can restore it from Drive\'s bin for 30 days.',
      run: () => { prompt = null; void trash(f); } };
  }

  function menuFor(f: DFile, x: number, y: number) {
    selected = f.id;
    const folder = isFolder(f);
    const list: MenuItem[] = [
      { label: folder ? 'Open' : 'Open in viewer', key: '↵', run: () => open(f) },
      ...(folder ? [{ label: 'Preview all, one by one', key: 'Space', run: () => preview(f) }] : []),
      { label: 'Share link…', key: 'S', run: () => (sharing = f), sep: true },
      { label: f.starred ? 'Remove star' : 'Star', key: '*', run: () => void star(f) },
      { label: 'Rename…', key: 'F2', run: () => rename(f) },
      ...(folder ? [{ label: 'Upload into this folder…', run: () => { uploadTarget = f.id; folderInput?.click(); } }] : []),
      { label: 'Open in Google Drive', run: () => window.open(driveLink(f), '_blank', 'noopener'), sep: true },
      { label: 'Move to bin', key: 'Del', danger: true, run: () => askTrash(f), sep: true },
    ];
    menu = { x, y, items: list };
  }
  function menuAt(f: DFile, el: HTMLElement | null) {
    const r = el?.getBoundingClientRect();
    menuFor(f, r ? r.left + Math.min(r.width, 240) / 2 : innerWidth / 2, r ? r.bottom - 4 : innerHeight / 2);
  }
  function backgroundMenu(e: MouseEvent) {
    if (!current) return;
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, items: [
      { label: 'New folder…', run: newFolder },
      { label: 'Upload files…', run: () => { uploadTarget = current; filesInput?.click(); } },
      { label: 'Upload a folder…', run: () => { uploadTarget = current; folderInput?.click(); } },
      { label: 'Preview everything here', run: () => preview(current), sep: true },
      { label: 'Refresh', run: () => void refresh(true) },
    ] };
  }

  // ── uploads ──
  let uploadTarget = '';
  function startUpload(list: ReturnType<typeof fromInput>) {
    const target = uploadTarget || current;
    uploadTarget = '';
    if (!list.length || !drive || !target) return;
    if (drive.demo) { toast.show('Uploads are off in the demo.'); return; }
    void uploader.add(drive, target, list);
  }
  async function drop(e: DragEvent) {
    e.preventDefault();
    over = false;
    if (!e.dataTransfer || !current) return;
    startUpload(await readDrop(e.dataTransfer));
  }

  // ── keyboard ──
  function rowStep(): number {
    if (view !== 'grid' || !listEl) return 1;
    const tiles = [...listEl.querySelectorAll<HTMLElement>('[data-id]')];
    const top = tiles[0]?.offsetTop;
    return Math.max(1, tiles.filter((t) => t.offsetTop === top).length);
  }
  function focusSel() {
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected)}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest' });
    });
  }
  function key(e: KeyboardEvent) {
    if (menu || prompt || sharing || editable(e.target) || !shown) return;
    const i = Math.max(0, shown.findIndex((f) => f.id === selected));
    const f = shown[i];
    const step = rowStep();
    const go = (j: number) => { if (j < 0 || j >= shown.length) return false; selected = shown[j]!.id; focusSel(); return true; };
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': handled = go(i + step); break;
      case 'ArrowUp': handled = go(i - step); break;
      case 'ArrowRight':
        if (view === 'grid') handled = go(i + 1);
        else if (view === 'columns' && f && isFolder(f)) open(f);
        else handled = false;
        break;
      case 'ArrowLeft':
        if (view === 'grid') handled = go(i - 1);
        else if (view === 'columns' && path.length > 1) { const up = path.at(-2)!; const me = path.at(-1)!; nav(`/drive/${up.id === mydrive.rootId ? '' : up.id}`.replace(/\/$/, '')); queueMicrotask(() => (selected = me.id)); }
        else handled = false;
        break;
      case 'Enter': if (f) { if (e.metaKey && isFolder(f)) preview(f); else open(f); } break;
      case ' ': if (f) { isFolder(f) ? preview(f) : open(f); } break;
      case 'Delete': if (f) askTrash(f); break;
      case 'Backspace': if (e.metaKey && f) askTrash(f); else if (path.length > 1) nav(`/drive/${path.at(-2)!.id}`); else handled = false; break;
      case 'F2': if (f) rename(f); break;
      case 's': case 'S': if (f && !e.metaKey) sharing = f; else handled = false; break;
      case '*': if (f) void star(f); break;
      case 'ContextMenu': case 'm': if (f) menuAt(f, document.querySelector(`[data-id="${CSS.escape(f.id)}"]`)); break;
      case 'Home': handled = go(0); break;
      case 'End': handled = go(shown.length - 1); break;
      default:
        if (e.key === 'F10' && e.shiftKey && f) menuAt(f, document.querySelector(`[data-id="${CSS.escape(f.id)}"]`));
        else if (isBack(e) && path.length > 1) nav(`/drive/${path.at(-2)!.id}`);
        else handled = false;
    }
    if (handled) e.preventDefault();
  }

  // Long-press OK on a TV remote opens the menu (there is no right button).
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressed = false;
  function pressStart(e: KeyboardEvent, f: DFile) {
    if (e.key !== 'Enter' || e.repeat) { if (e.repeat && e.key === 'Enter') e.preventDefault(); return; }
    longPressed = false;
    pressTimer = setTimeout(() => { longPressed = true; menuAt(f, e.currentTarget as HTMLElement); }, 650);
  }
  function pressEnd() { if (pressTimer) clearTimeout(pressTimer); pressTimer = null; }

  function search(e: SubmitEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    nav(`/drive/search?q=${encodeURIComponent(q.trim())}`);
    if (virtual === 'search') void refresh(true);
  }

  // ── storage ──
  const quota = $derived(mydrive.quota);
  const qUsed = $derived(Number(quota.usage ?? 0));
  const qLimit = $derived(Number(quota.limit ?? 0));
  const rootKids = $derived.by(() => {
    void sizes.version;
    const list = mydrive.rootId ? colLists[mydrive.rootId] ?? kids.get(mydrive.rootId) : undefined;
    return (list ?? []).filter(isFolder).map((f) => ({ f, t: sizes.of(f.id) })).filter((x) => x.t).sort((a, b) => b.t!.bytes - a.t!.bytes).slice(0, 6);
  });
  $effect(() => { if (drive && mydrive.rootId) void load(mydrive.rootId).then(() => (colLists = { ...colLists })); });

  const itemsText = (t?: { files: number; folders: number }) => (t ? `${t.files.toLocaleString()} file${t.files === 1 ? '' : 's'}${t.folders ? ` · ${t.folders.toLocaleString()} folder${t.folders === 1 ? '' : 's'}` : ''}` : '');
</script>

<svelte:window onkeydown={key} />

{#if mydrive.state === 'needs-full'}
  <div class="center">
    <div class="card narrow stack" style="text-align:center; padding:2.2rem">
      <h2>Allow DriveShare to see your whole Drive</h2>
      <p class="muted">My Drive shows every folder with its real size, lets you upload whole folders and preview, comment and share files. That needs full Drive access. Everything happens between this browser and Google.</p>
      <div><button class="primary" disabled={account.busy} onclick={async () => { if (await account.signIn('full')) { mydrive.reset(); void mydrive.start(); } }}>{account.busy ? 'Waiting for Google…' : 'Allow full Drive access'}</button></div>
      {#if account.error}<p class="error">{account.error}</p>{/if}
    </div>
  </div>
{:else if mydrive.state === 'error'}
  <div class="center"><div class="card narrow stack"><p class="error">{mydrive.error}</p><button onclick={() => { mydrive.reset(); void mydrive.start(); }}>Try again</button></div></div>
{:else if mydrive.state !== 'ready'}
  <div class="center muted"><span class="spin"></span></div>
{:else}
  <div class="finder" class:tvm={tv.on}>
    <aside class="side">
      <form class="searchbox" onsubmit={search}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input placeholder="Search Drive" bind:value={q} aria-label="Search Drive" />
      </form>
      <nav class="places">
        <button class:on={!virtual && current === mydrive.rootId} onclick={() => nav('/drive')}><FileIcon file={{ mimeType: 'application/vnd.google-apps.folder', name: '' }} size={1.05} />My Drive</button>
        <button class:on={virtual === 'recent'} onclick={() => nav('/drive/recent')}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Recent</button>
        <button class:on={virtual === 'shared'} onclick={() => nav('/drive/shared')}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14c2.6 0 4.4 1.6 5 4.4"/></svg>Shared with me</button>
        <button class:on={virtual === 'starred'} onclick={() => nav('/drive/starred')}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>Starred</button>
      </nav>

      {#if linked.list?.length}
        <div class="sect">
          <div class="label">Linked to you</div>
          {#each linked.list as l (l.folderId)}
            <button class="big" class:on={current === l.folderId} onclick={() => nav(`/drive/${l.folderId}`)} title={`From ${l.ownerEmail}`}>
              <span class="ellipsis grow">{l.name}</span><span class="tiny muted num">{formatBytes(Math.max(0, l.capBytes - l.usedBytes))} left</span>
              <span class="mini"><span style:width="{Math.min(100, (l.usedBytes / Math.max(1, l.capBytes)) * 100)}%"></span></span>
            </button>
          {/each}
        </div>
      {/if}

      {#if rootKids.length}
        <div class="sect">
          <div class="label">Biggest folders</div>
          {#each rootKids as { f, t } (f.id)}
            <button class="big" onclick={() => nav(`/drive/${f.id}`)}>
              <span class="ellipsis grow">{f.name}</span><span class="tiny muted num">{formatBytes(t!.bytes)}</span>
              <span class="mini"><span style:width="{(t!.bytes / Math.max(1, rootKids[0]!.t!.bytes)) * 100}%"></span></span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="storage">
        <div class="row spread small"><span>Storage</span><span class="muted num">{qLimit ? `${Math.round((qUsed / qLimit) * 100)}%` : ''}</span></div>
        <div class="bar"><div class="used" style:width="{qLimit ? Math.min(100, (qUsed / qLimit) * 100) : 0}%"></div></div>
        <div class="tiny muted num">{formatBytes(qUsed)} of {qLimit ? formatBytes(qLimit) : 'unlimited'}</div>
        <div class="tiny faint idx">
          {#if sizes.state === 'scanning'}<span class="spin"></span> Measuring folders · {sizes.scanned.toLocaleString()} items
          {:else if sizes.state === 'error'}Sizes: {sizes.error} <button class="link tiny" onclick={() => void sizes.rebuild()}>Retry</button>
          {:else}{sizes.count.toLocaleString()} items indexed · <button class="link tiny" onclick={() => void sizes.rebuild()}>Re-measure</button>{/if}
        </div>
      </div>
    </aside>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section class="main" class:over
      ondragover={(e) => { if (current) { e.preventDefault(); over = true; } }}
      ondragleave={(e) => { if (e.currentTarget === e.target) over = false; }}
      ondrop={drop}
      oncontextmenu={backgroundMenu}>
      <header class="bar-top">
        <div class="crumbs">
          {#if virtual}
            <span class="crumb last">{title}{virtual === 'search' && q ? `: “${q}”` : ''}</span>
          {:else}
            {#each path as p, i (p.id)}
              {#if i}<span class="sep">›</span>{/if}
              <button class="crumb" class:last={i === path.length - 1} onclick={() => nav(p.id === mydrive.rootId ? '/drive' : `/drive/${p.id}`)}>{p.id === mydrive.rootId ? 'My Drive' : p.name}</button>
            {/each}
          {/if}
        </div>
        <span class="grow"></span>
        <div class="seg" role="group" aria-label="View">
          <button class:on={view === 'list'} onclick={() => (view = 'list')} title="List" aria-label="List view"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
          <button class:on={view === 'grid'} onclick={() => (view = 'grid')} title="Grid" aria-label="Grid view"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg></button>
          <button class:on={view === 'columns'} onclick={() => (view = 'columns')} title="Columns" aria-label="Column view"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg></button>
        </div>
        {#if current}
          <button class="ghost" onclick={() => preview(current)} title="Preview everything here, one by one"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>Preview</button>
          <button class="ghost" onclick={newFolder}>New folder</button>
          <button class="primary" onclick={() => folderInput?.click()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 19V5M5 12l7-7 7 7"/></svg>Upload folder</button>
          <button class="ghost" onclick={() => filesInput?.click()}>Files</button>
        {/if}
      </header>

      {#if current && here}
        <div class="summary num">
          <b>{formatBytes(here.bytes)}</b>&nbsp;<span class="muted">· {itemsText(here)}</span>
          {#if sizes.state === 'scanning'}<span class="faint"> · measuring…</span>{/if}
        </div>
      {/if}

      {#if loadError}<p class="error" style="padding:1rem">{loadError}</p>{/if}

      {#if shown === null}
        <div class="loading">{#each Array(8) as _}<div class="skeleton" style="height:2.6rem"></div>{/each}</div>
      {:else if shown.length === 0}
        <div class="empty">
          <FileIcon file={{ mimeType: 'application/vnd.google-apps.folder', name: '' }} size={4} />
          <p class="muted">{virtual === 'search' ? (q ? 'Nothing matches.' : 'Type to search your Drive.') : 'This folder is empty.'}</p>
          {#if current}<p class="small faint">Drop files or a whole folder here to upload.</p>{/if}
        </div>
      {:else if view === 'list'}
        <div class="list" bind:this={listEl} role="grid" aria-label={title}>
          <div class="lh" role="row">
            <button class="c-name" onclick={() => setSort('name')}>Name {sortKey === 'name' ? (sortDir === 1 ? '↑' : '↓') : ''}</button>
            <button class="c-size" onclick={() => setSort('size')}>Size {sortKey === 'size' ? (sortDir === 1 ? '↑' : '↓') : ''}</button>
            <span class="c-items">Contents</span>
            <button class="c-kind" onclick={() => setSort('kind')}>Kind {sortKey === 'kind' ? (sortDir === 1 ? '↑' : '↓') : ''}</button>
            <button class="c-mod" onclick={() => setSort('modified')}>Modified {sortKey === 'modified' ? (sortDir === 1 ? '↑' : '↓') : ''}</button>
          </div>
          {#each shown as f (f.id)}
            {@const t = folderTotals(f)}
            {@const s = sizeOf(f)}
            <div class="lr" role="row" data-id={f.id} tabindex={f.id === selected ? 0 : -1} aria-selected={f.id === selected}
              class:sel={f.id === selected}
              onclick={() => (selected = f.id)}
              ondblclick={() => open(f)}
              onkeydown={(e) => pressStart(e, f)} onkeyup={pressEnd}
              onkeypress={(e) => { if (e.key === 'Enter' && longPressed) e.preventDefault(); }}
              oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); menuFor(f, e.clientX, e.clientY); }}>
              <span class="c-name">
                {#if !isFolder(f) && thumb(f, 64)}<img class="lthumb" src={thumb(f, 64)} alt="" loading="lazy" referrerpolicy="no-referrer" />{:else}<FileIcon file={f} size={1.35} shared={f.shared} />{/if}
                <span class="ellipsis">{f.name}</span>
                {#if f.starred}<span class="star" title="Starred">★</span>{/if}
              </span>
              <span class="c-size num">
                {#if s >= 0}<span>{formatBytes(s)}</span><span class="mini"><span style:width="{(s / maxSize) * 100}%"></span></span>{:else}<span class="faint">—</span>{/if}
              </span>
              <span class="c-items num muted">{isFolder(f) ? itemsText(t) : f.videoMediaMetadata ? duration(f.videoMediaMetadata.durationMillis) : f.imageMediaMetadata?.width ? `${f.imageMediaMetadata.width}×${f.imageMediaMetadata.height}` : ''}</span>
              <span class="c-kind muted">{kindOf(f)}</span>
              <span class="c-mod muted">{ago(f.modifiedTime)}</span>
              <button class="more ghost icon" aria-label="More" tabindex="-1" onclick={(e) => { e.stopPropagation(); menuAt(f, e.currentTarget.closest('.lr')); }}>⋯</button>
            </div>
          {/each}
        </div>
      {:else if view === 'grid'}
        <div class="grid" bind:this={listEl} role="grid" aria-label={title}>
          {#each shown as f (f.id)}
            {@const t = folderTotals(f)}
            {@const s = sizeOf(f)}
            <div class="tile" data-id={f.id} role="gridcell" tabindex={f.id === selected ? 0 : -1} aria-selected={f.id === selected} class:sel={f.id === selected}
              onclick={() => (selected = f.id)} ondblclick={() => open(f)}
              onkeydown={(e) => pressStart(e, f)} onkeyup={pressEnd}
              oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); menuFor(f, e.clientX, e.clientY); }}>
              <div class="art" class:media={isMedia(f)}>
                {#if !isFolder(f) && thumb(f, 480)}<img src={thumb(f, 480)} alt="" loading="lazy" referrerpolicy="no-referrer" />{:else}<FileIcon file={f} size={3.2} shared={f.shared} />{/if}
                {#if f.videoMediaMetadata}<span class="dur">{duration(f.videoMediaMetadata.durationMillis)}</span>{/if}
                {#if f.starred}<span class="star tl">★</span>{/if}
              </div>
              <div class="tn ellipsis">{f.name}</div>
              <div class="tm tiny muted num ellipsis">{isFolder(f) ? (t ? `${formatBytes(t.bytes)} · ${t.files.toLocaleString()} files` : '…') : formatBytes(s)}</div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="cols">
          {#each virtual ? [] : path.slice(0, -1) as p, i (p.id)}
            {@const next = path[i + 1]}
            <div class="col">
              {#each sorted(colLists[p.id] ?? []) as f (f.id)}
                <button class="ci" class:trail={f.id === next?.id} tabindex="-1" onclick={() => open(f)} oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); menuFor(f, e.clientX, e.clientY); }}>
                  <FileIcon file={f} size={1.1} /><span class="ellipsis grow">{f.name}</span>{#if isFolder(f)}<span class="chev">›</span>{/if}
                </button>
              {/each}
            </div>
          {/each}
          <div class="col cur" bind:this={listEl}>
            {#each shown as f (f.id)}
              <div class="ci" data-id={f.id} role="option" tabindex={f.id === selected ? 0 : -1} aria-selected={f.id === selected} class:sel={f.id === selected}
                onclick={() => (selected = f.id)} ondblclick={() => open(f)}
                onkeydown={(e) => pressStart(e, f)} onkeyup={pressEnd}
                oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); menuFor(f, e.clientX, e.clientY); }}>
                <FileIcon file={f} size={1.1} /><span class="ellipsis grow">{f.name}</span>
                <span class="tiny faint num">{sizeOf(f) >= 0 ? formatBytes(sizeOf(f)) : ''}</span>{#if isFolder(f)}<span class="chev">›</span>{/if}
              </div>
            {/each}
          </div>
          {#if sel}
            <div class="col detail">
              <div class="dart">
                {#if !isFolder(sel) && thumb(sel, 640)}<img src={thumb(sel, 640)} alt="" referrerpolicy="no-referrer" />{:else}<FileIcon file={sel} size={5} />{/if}
              </div>
              <h3 class="dn">{sel.name}</h3>
              <dl>
                <dt>Kind</dt><dd>{kindOf(sel)}</dd>
                <dt>Size</dt><dd class="num">{sizeOf(sel) >= 0 ? formatBytes(sizeOf(sel)) : '…'}</dd>
                {#if isFolder(sel)}<dt>Contents</dt><dd class="num">{itemsText(folderTotals(sel)) || '…'}</dd>{/if}
                {#if sel.imageMediaMetadata?.width}<dt>Pixels</dt><dd class="num">{sel.imageMediaMetadata.width} × {sel.imageMediaMetadata.height}</dd>{/if}
                {#if sel.videoMediaMetadata}<dt>Length</dt><dd class="num">{duration(sel.videoMediaMetadata.durationMillis)}</dd>{/if}
                <dt>Modified</dt><dd>{sel.modifiedTime ? new Date(sel.modifiedTime).toLocaleString() : ''}</dd>
              </dl>
              <div class="row">
                <button class="primary small" onclick={() => (isFolder(sel!) ? preview(sel!) : open(sel!))}>{isFolder(sel) ? 'Preview all' : 'Open'}</button>
                <button class="small" onclick={() => (sharing = sel!)}>Share link</button>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <footer class="status tiny muted num">
        {#if shown}{shown.length.toLocaleString()} item{shown.length === 1 ? '' : 's'}{/if}
        {#if sel} · <span class="ink">{sel.name}</span> · {sizeOf(sel) >= 0 ? formatBytes(sizeOf(sel)) : ''}{/if}
        <span class="grow"></span>
        <span class="faint keys"><span class="kbd">↵</span> open <span class="kbd">Space</span> preview <span class="kbd">S</span> share <span class="kbd">Del</span> bin {tv.on ? '· hold OK for menu' : '· right-click for more'}</span>
      </footer>

      {#if over}
        <div class="dropzone"><div><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg><p>Drop to upload into <b>{title}</b></p><p class="small muted">Folders keep their structure. Files already here are skipped.</p></div></div>
      {/if}
    </section>
  </div>

  <input type="file" multiple hidden bind:this={filesInput} onchange={(e) => { startUpload(fromInput(e.currentTarget.files)); e.currentTarget.value = ''; }} />
  <input type="file" multiple hidden bind:this={folderInput} webkitdirectory onchange={(e) => { startUpload(fromInput(e.currentTarget.files)); e.currentTarget.value = ''; }} />
{/if}

{#if menu}<Menu x={menu.x} y={menu.y} items={menu.items} onclose={() => { menu = null; focusSel(); }} />{/if}
{#if prompt}<Prompt title={prompt.title} label={prompt.label} value={prompt.value} ok={prompt.ok} danger={prompt.danger} text={prompt.text} onok={prompt.run} oncancel={() => { prompt = null; focusSel(); }} />{/if}
{#if sharing && drive}<ShareDialog {drive} file={sharing} onclose={() => { sharing = null; focusSel(); }} />{/if}
<UploadPanel />
<Toast />

<style>
  .finder { display: grid; grid-template-columns: 15.5rem 1fr; height: calc(100vh - 3.6rem); }
  .side { border-right: 1px solid var(--line); padding: 1rem 0.75rem; display: flex; flex-direction: column; gap: 1.1rem; overflow: auto; background: rgb(18 21 26 / 0.6); }
  .searchbox { display: flex; align-items: center; gap: 0.5rem; background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px; padding: 0 0.7rem; color: var(--faint); }
  .searchbox input { border: 0; background: none; padding: 0.55rem 0; outline: none; }
  .searchbox:focus-within { border-color: var(--accent); }
  .places { display: grid; gap: 0.1rem; }
  .places button, .sect .big { border: 0; background: none; justify-content: flex-start; gap: 0.65rem; color: var(--ink-2); font-weight: 520; padding: 0.5rem 0.6rem; width: 100%; }
  .places button:hover, .sect .big:hover { background: var(--panel-2); }
  .sect .big.on { background: var(--accent-soft); color: var(--accent-2); }
  .places button.on { background: var(--accent-soft); color: var(--accent-2); }
  .sect { display: grid; gap: 0.1rem; }
  .label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); font-weight: 650; padding: 0 0.6rem 0.3rem; }
  .sect .big { display: grid; grid-template-columns: 1fr auto; text-align: left; gap: 0.25rem 0.5rem; font-size: 0.84rem; }
  .sect .big .mini { grid-column: 1 / -1; }
  .mini { display: block; height: 3px; border-radius: 9px; background: var(--raise); overflow: hidden; }
  .mini > span { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); border-radius: 9px; }
  .storage { margin-top: auto; display: grid; gap: 0.45rem; padding: 0.9rem; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
  .idx { line-height: 1.5; }

  .main { position: relative; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
  .bar-top { display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.1rem; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .crumbs { display: flex; align-items: center; gap: 0.15rem; min-width: 0; overflow: hidden; flex: 1 1 14rem; }
  .crumb { border: 0; background: none; padding: 0.35rem 0.45rem; color: var(--muted); font-weight: 560; font-size: 0.95rem; white-space: nowrap; max-width: 16rem; overflow: hidden; text-overflow: ellipsis; display: inline-block; }
  .crumb:hover { color: var(--ink); background: var(--panel-2); }
  .crumb.last { color: var(--ink); font-weight: 680; font-size: 1.1rem; }
  .sep { color: var(--faint); }
  .seg { display: flex; background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px; padding: 0.15rem; }
  .seg button { border: 0; background: none; padding: 0.4rem 0.55rem; color: var(--muted); border-radius: 8px; }
  .seg button.on { background: var(--raise); color: var(--ink); }
  .summary { padding: 0.55rem 1.25rem; font-size: 0.85rem; border-bottom: 1px solid var(--line); background: rgb(23 27 33 / 0.5); }

  .loading { padding: 1rem; display: grid; gap: 0.5rem; }
  .empty { flex: 1; display: grid; place-content: center; justify-items: center; text-align: center; gap: 0.3rem; opacity: 0.9; }
  .empty p { margin: 0; }

  .list { flex: 1; overflow: auto; padding: 0.2rem 0.6rem 1rem; }
  .lh, .lr { display: grid; grid-template-columns: minmax(12rem, 1fr) 9rem 11rem 7rem 7.5rem 2.2rem; align-items: center; gap: 0.75rem; padding: 0 0.6rem; }
  .lh { position: sticky; top: 0; background: var(--bg); z-index: 1; height: 2.2rem; border-bottom: 1px solid var(--line); }
  .lh button, .lh span { border: 0; background: none; padding: 0; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--faint); font-weight: 650; justify-content: flex-start; }
  .lh button:hover { color: var(--ink); background: none; }
  .lr { height: 2.75rem; border-radius: 9px; cursor: default; font-size: 0.88rem; user-select: none; }
  .lr:nth-child(odd) { background: rgb(255 255 255 / 0.012); }
  .lr:hover { background: var(--panel-2); }
  .lr.sel { background: var(--accent-soft); box-shadow: inset 0 0 0 1px rgb(124 156 255 / 0.35); }
  .c-name { display: flex; align-items: center; gap: 0.65rem; min-width: 0; }
  .c-size { display: grid; gap: 0.25rem; }
  .c-items, .c-kind, .c-mod { font-size: 0.8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lthumb { width: 1.6rem; height: 1.6rem; border-radius: 5px; object-fit: cover; flex: none; background: var(--raise); }
  .star { color: var(--warn); font-size: 0.8rem; }
  .more { opacity: 0; width: 1.9rem; height: 1.9rem; }
  .lr:hover .more, .lr.sel .more { opacity: 1; }
  @media (max-width: 1100px) { .lh, .lr { grid-template-columns: minmax(10rem, 1fr) 8rem 9rem 2.2rem; } .c-kind, .c-mod { display: none !important; } }

  .grid { flex: 1; overflow: auto; padding: 1rem 1.1rem 2rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(11.5rem, 1fr)); gap: 1rem; align-content: start; }
  .tile { border-radius: 14px; padding: 0.45rem; cursor: default; user-select: none; display: grid; gap: 0.35rem; }
  .tile:hover { background: var(--panel-2); }
  .tile.sel { background: var(--accent-soft); box-shadow: inset 0 0 0 1px rgb(124 156 255 / 0.4); }
  .art { position: relative; aspect-ratio: 4 / 3; border-radius: 10px; background: var(--panel); display: grid; place-items: center; overflow: hidden; border: 1px solid var(--line); }
  .art img { width: 100%; height: 100%; object-fit: cover; }
  .art.media { background: #000; }
  .dur { position: absolute; right: 0.4rem; bottom: 0.4rem; font-size: 0.68rem; font-weight: 650; background: rgb(0 0 0 / 0.65); padding: 0.1rem 0.4rem; border-radius: 6px; }
  .tl { position: absolute; left: 0.45rem; top: 0.35rem; }
  .tn { font-size: 0.86rem; font-weight: 540; padding: 0 0.15rem; }
  .tm { padding: 0 0.15rem; }

  .cols { flex: 1; display: flex; overflow-x: auto; overflow-y: hidden; }
  .col { flex: 0 0 15rem; border-right: 1px solid var(--line); overflow-y: auto; padding: 0.35rem; }
  .col.cur { flex-basis: 17rem; }
  .ci { text-align: left; display: flex; align-items: center; gap: 0.5rem; width: 100%; border: 0; background: none; padding: 0.4rem 0.5rem; border-radius: 7px; font-size: 0.84rem; color: var(--ink-2); cursor: default; justify-content: flex-start; font-weight: 450; }
  .ci:hover { background: var(--panel-2); }
  .ci.trail { background: var(--raise); color: var(--ink); }
  .ci.sel { background: var(--accent); color: var(--accent-ink); }
  .ci.sel .faint { color: var(--accent-ink); opacity: 0.7; }
  .chev { color: var(--faint); }
  .ci.sel .chev { color: var(--accent-ink); }
  .detail { flex: 1 0 18rem; padding: 1.2rem; display: grid; align-content: start; gap: 0.9rem; }
  .dart { position: relative; aspect-ratio: 4 / 3; border-radius: 12px; background: var(--panel); display: grid; place-items: center; overflow: hidden; border: 1px solid var(--line); }
  .dart img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
  .dn { word-break: break-word; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.35rem 0.9rem; margin: 0; font-size: 0.82rem; }
  dt { color: var(--faint); }
  dd { margin: 0; color: var(--ink-2); }

  .status { display: flex; gap: 0.4rem; align-items: center; padding: 0.45rem 1.2rem; border-top: 1px solid var(--line); background: rgb(18 21 26 / 0.8); }
  .status .ink { color: var(--ink-2); }
  .keys .kbd { margin: 0 0.15rem 0 0.4rem; }
  .dropzone { position: absolute; inset: 0.6rem; border: 2px dashed var(--accent); border-radius: 18px; background: rgb(13 15 18 / 0.85); display: grid; place-items: center; text-align: center; color: var(--accent-2); pointer-events: none; z-index: 5; }
  .dropzone p { margin: 0.4rem 0 0; color: var(--ink); }

  .tvm .lr { height: 3rem; }

  @media (max-width: 760px) {
    .finder { grid-template-columns: 1fr; }
    .side { display: none; }
  }
</style>
