<script lang="ts">
  import { formatBytes, room } from '@driveshare/backend/shared';
  import { errorCode, errorText, finishUploads, shareInfo, startUploads } from '../lib/icebase.ts';
  import { sendFile } from '../lib/upload.ts';
  import Usage from '../components/Usage.svelte';

  let { shareId }: { shareId: string } = $props();
  const secret = decodeURIComponent(location.hash.slice(1));

  type Info = Awaited<ReturnType<typeof shareInfo>>;
  interface Item { file: File; sent: number; state: 'waiting' | 'sending' | 'done' | 'failed' | 'cancelled'; error?: string; abort?: AbortController; session?: { uploadId: string; url: string }; batch?: Promise<void> }

  let info = $state<Info | null>(null);
  let loadError = $state('');
  let password = $state('');
  let by = $state(localStorage.getItem('ds.by') ?? '');
  let items = $state<Item[]>([]);
  let over = $state(false);
  let running = 0;
  const PARALLEL = 2;

  async function load() {
    try {
      info = await shareInfo({ shareId, secret });
    } catch (e) {
      loadError = errorCode(e) === 'not-found' ? 'This upload link is wrong, or its owner turned it off.' : errorText(e);
    }
  }
  void load();

  const left = $derived(info ? room(info.capBytes, info.usedBytes, info.reservedBytes) : 0);
  const queued = $derived(items.filter((i) => i.state === 'waiting' || i.state === 'sending').reduce((n, i) => n + i.file.size - i.sent, 0));

  function add(files: FileList | File[] | null) {
    if (!files || !info) return;
    for (const file of files) items.push({ file, sent: 0, state: 'waiting' });
    pump();
  }

  function pump() {
    while (running < PARALLEL) {
      const next = items.find((i) => i.state === 'waiting');
      if (!next) return;
      running++;
      next.state = 'sending';
      void send(next).finally(() => { running--; pump(); });
    }
  }

  // Function calls are batched: one call opens Drive sessions for up to 8 files, one call counts up
  // to 50 finished files. Bytes always go from this browser straight to Google.
  const BATCH = 8;
  const BATCH_BYTES = 2 * 1024 ** 3;
  const why = (code: string, text: string) => (code === 'resource-exhausted' ? 'Not enough room left under the cap.' : code === 'unauthenticated' ? 'Wrong password.' : code === 'out-of-range' && info?.maxFileBytes ? `Larger than ${formatBytes(info.maxFileBytes)}, the most this link takes per file.` : text);

  function sessionFor(item: Item): Promise<void> {
    if (item.session) return Promise.resolve();
    if (item.batch) return item.batch;
    const group: Item[] = [item];
    let bytes = item.file.size;
    for (const i of items) {
      if (group.length >= BATCH) break;
      if (i === item || i.state !== 'waiting' || i.session || i.batch) continue;
      if (bytes + i.file.size > BATCH_BYTES) continue;
      group.push(i);
      bytes += i.file.size;
    }
    const p = (async () => {
      try {
        const r = await startUploads({
          shareId, secret,
          ...(password ? { password } : {}),
          ...(by.trim() ? { by: by.trim() } : {}),
          files: group.map((i) => ({ name: i.file.name, size: i.file.size, ...(i.file.type ? { mime: i.file.type } : {}) })),
        });
        group.forEach((i, k) => {
          const u = r.uploads[k];
          if (u?.uploadId && u.url) i.session = { uploadId: u.uploadId, url: u.url };
          else { i.state = 'failed'; i.error = why(u?.code ?? '', u?.error ?? 'Could not start'); }
        });
      } catch (e) {
        for (const i of group) { i.state = 'failed'; i.error = why(errorCode(e), errorText(e)); }
      } finally {
        for (const i of group) i.batch = undefined;
      }
    })();
    for (const i of group) i.batch = p;
    return p;
  }

  let finished: { item: Item; uploadId: string; fileId?: string }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  async function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const batch = finished.splice(0, 50);
    if (!batch.length) return;
    try {
      const r = await finishUploads({ shareId, secret, items: batch.map((b) => ({ uploadId: b.uploadId, ...(b.fileId ? { fileId: b.fileId } : {}) })) });
      if (info) info = { ...info, usedBytes: r.usedBytes, reservedBytes: r.reservedBytes, capBytes: r.capBytes };
      for (const res of r.results) if (!res.ok) { const b = batch.find((x) => x.uploadId === res.uploadId); if (b) { b.item.state = 'failed'; b.item.error = res.error ?? 'Not counted'; } }
    } catch (e) {
      for (const b of batch) { b.item.state = 'failed'; b.item.error = errorText(e); }
    }
    if (finished.length) void flush();
  }
  function finish(item: Item, uploadId: string, fileId?: string) {
    finished.push({ item, uploadId, ...(fileId ? { fileId } : {}) });
    const busy = items.some((i) => i.state === 'waiting' || i.state === 'sending');
    if (finished.length >= 20 || !busy) void flush();
    else flushTimer ??= setTimeout(() => void flush(), 3000);
  }

  async function send(item: Item) {
    if (by.trim()) localStorage.setItem('ds.by', by.trim());
    item.abort = new AbortController();
    try {
      if (info?.maxFileBytes && item.file.size > info.maxFileBytes) throw new Error(`Larger than ${formatBytes(info.maxFileBytes)}, the most this link takes per file.`);
      const resumed = !!item.session;
      await sessionFor(item);
      if (!item.session) return;
      const r = await sendFile(item.session.url, item.file, (n) => (item.sent = n), item.abort.signal, resumed);
      item.state = 'done';
      item.sent = item.file.size;
      finish(item, item.session.uploadId, r.id);
    } catch (e) {
      if ((e as Error).name === 'AbortError') { item.state = 'cancelled'; return; }
      item.state = 'failed';
      item.error = why(errorCode(e), errorText(e));
      if (/expired/.test(item.error)) item.session = undefined;
    }
  }

  function retry(i: Item) { i.state = 'waiting'; i.sent = 0; i.error = undefined; pump(); }
  const pct = (i: Item) => (i.file.size ? Math.round((i.sent / i.file.size) * 100) : 100);
</script>

<main class="wrap narrow stack" style="gap:18px">
  <div class="row" style="gap:10px"><img src="/icon.svg" alt="" style="width:30px" /><span class="muted small">DriveShare</span></div>
  {#if loadError}
    <div class="card"><h2>Link not available</h2><p class="muted">{loadError}</p></div>
  {:else if !info}
    <p class="muted">Loading…</p>
  {:else}
    <div class="stack" style="gap:6px">
      <h1>{info.name}</h1>
      <p class="muted" style="margin:0">Files you send here go into the owner's Google Drive and use their storage, not yours. No account needed.</p>
    </div>
    <div class="card stack">
      <Usage cap={info.capBytes} used={info.usedBytes} held={info.reservedBytes} />
      {#if info.maxFileBytes}<p class="small muted" style="margin:0">Up to {formatBytes(info.maxFileBytes)} per file.</p>{/if}
      <div class="grid2">
        <label>Your name (optional, shown to the owner)<input bind:value={by} maxlength="80" placeholder="Anonymous" /></label>
        {#if info.needsPassword}<label>Password<input type="password" bind:value={password} autocomplete="current-password" /></label>{/if}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="drop" class:over
        ondragover={(e) => { e.preventDefault(); over = true; }}
        ondragleave={() => (over = false)}
        ondrop={(e) => { e.preventDefault(); over = false; add(e.dataTransfer?.files ?? null); }}>
        <p style="margin:0 0 10px; font-size:16px">Drop files here</p>
        <label class="btn primary" style="display:inline-flex">Choose files<input type="file" multiple hidden onchange={(e) => { add(e.currentTarget.files); e.currentTarget.value = ''; }} /></label>
        <p class="small muted" style="margin:10px 0 0">{formatBytes(left)} left{queued ? ` · ${formatBytes(queued)} still to send` : ''}</p>
      </div>
      {#if info.folderUrl}<p class="small" style="margin:0"><a href={info.folderUrl} target="_blank" rel="noopener">See the folder in Google Drive</a></p>{/if}
    </div>

    {#if items.length}
      <div class="card stack" style="gap:10px">
        {#each items as i}
          <div class="stack" style="gap:5px">
            <div class="row spread small">
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:60%">{i.file.name}</span>
              <span class="muted">
                {#if i.state === 'sending'}{formatBytes(i.sent)} / {formatBytes(i.file.size)} · {pct(i)}% <button class="link small" onclick={() => i.abort?.abort()}>Cancel</button>
                {:else if i.state === 'done'}<span style="color:var(--good)">Sent · {formatBytes(i.file.size)}</span>
                {:else if i.state === 'failed'}<span class="error">{i.error}</span> <button class="link small" onclick={() => retry(i)}>Retry</button>
                {:else if i.state === 'cancelled'}Cancelled <button class="link small" onclick={() => retry(i)}>Retry</button>
                {:else}Waiting{/if}
              </span>
            </div>
            <div class="bar"><div class="used" style:width={`${pct(i)}%`}></div></div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</main>
