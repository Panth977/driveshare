<script lang="ts">
  import { formatBytes, room } from '@driveshare/backend/shared';
  import { errorCode, errorText, finishUpload, shareInfo, startUpload } from '../lib/icebase.ts';
  import { sendFile } from '../lib/upload.ts';
  import Usage from '../components/Usage.svelte';

  let { shareId }: { shareId: string } = $props();
  const secret = decodeURIComponent(location.hash.slice(1));

  type Info = Awaited<ReturnType<typeof shareInfo>>;
  interface Item { file: File; sent: number; state: 'waiting' | 'sending' | 'done' | 'failed' | 'cancelled'; error?: string; abort?: AbortController }

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

  async function send(item: Item) {
    if (by.trim()) localStorage.setItem('ds.by', by.trim());
    item.abort = new AbortController();
    try {
      if (info?.maxFileBytes && item.file.size > info.maxFileBytes) throw new Error(`Larger than ${formatBytes(info.maxFileBytes)}, the most this link takes per file.`);
      const s = await startUpload({
        shareId, secret, name: item.file.name, size: item.file.size,
        ...(item.file.type ? { mime: item.file.type } : {}),
        ...(password ? { password } : {}),
        ...(by.trim() ? { by: by.trim() } : {}),
      });
      void refresh();
      const r = await sendFile(s.url, item.file, (n) => (item.sent = n), item.abort.signal);
      await finishUpload({ shareId, secret, uploadId: s.uploadId, ...(r.id ? { fileId: r.id } : {}) });
      item.state = 'done';
      item.sent = item.file.size;
    } catch (e) {
      if ((e as Error).name === 'AbortError') { item.state = 'cancelled'; return; }
      item.state = 'failed';
      const code = errorCode(e);
      item.error = code === 'resource-exhausted' ? 'Not enough room left under the cap.' : code === 'unauthenticated' ? 'Wrong password.' : errorText(e);
    } finally {
      void refresh();
    }
  }

  async function refresh() {
    try { info = await shareInfo({ shareId, secret }); } catch { /* keep the last one */ }
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
