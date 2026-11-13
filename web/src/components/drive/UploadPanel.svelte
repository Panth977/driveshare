<script lang="ts">
  import { formatBytes } from '@driveshare/backend/shared';
  import { uploader, type Job } from '../../lib/uploader.svelte.ts';

  let collapsed = $state(false);
  let filter = $state<'all' | 'active' | 'failed'>('all');
  const t = $derived(uploader.totals);
  const pct = $derived(t.size ? Math.min(100, (t.sent / t.size) * 100) : 100);
  const eta = $derived(uploader.speed > 1 ? (t.size - t.sent) / uploader.speed : 0);
  const shown = $derived.by(() => {
    const order = { sending: 0, checking: 1, failed: 2, waiting: 3, cancelled: 4, done: 5, skipped: 6 } as const;
    const list = uploader.jobs.filter((j) => filter === 'all' || (filter === 'failed' ? j.state === 'failed' : ['sending', 'checking', 'waiting'].includes(j.state)));
    return [...list].sort((a, b) => order[a.state] - order[b.state]).slice(0, 200);
  });
  const time = (s: number) => (s < 60 ? `${Math.ceil(s)} s` : s < 3600 ? `${Math.ceil(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
  const label = (j: Job) => ({ waiting: 'Waiting', checking: 'Checking', sending: j.resumed ? 'Resuming' : 'Sending', done: j.resumedFrom ? `Done · carried on from ${formatBytes(j.resumedFrom)}` : 'Done', skipped: 'Already in Drive', failed: j.error ?? 'Failed', cancelled: 'Cancelled' })[j.state];
</script>

{#if uploader.open && uploader.jobs.length}
  <section class="panel" class:collapsed aria-label="Uploads">
    <header>
      <div class="ring" style="--p:{pct}">
        <span class="num">{Math.floor(pct)}<small>%</small></span>
      </div>
      <div class="grow">
        <div class="ttl">
          {#if t.active}{uploader.paused ? 'Paused' : `Uploading ${t.active} file${t.active === 1 ? '' : 's'}`}{:else if t.failed}{t.failed} failed{:else}Upload finished{/if}
        </div>
        <div class="tiny muted num">
          {formatBytes(t.sent)} of {formatBytes(t.size)}
          {#if t.active && uploader.speed > 1} · {formatBytes(uploader.speed)}/s · {time(eta)} left{/if}
        </div>
        <div class="tiny faint num">{t.done} sent · {t.skipped} already there{t.failed ? ` · ${t.failed} failed` : ''}</div>
      </div>
      <button class="ghost icon" aria-label={collapsed ? 'Expand' : 'Collapse'} onclick={() => (collapsed = !collapsed)}>{collapsed ? '▴' : '▾'}</button>
      {#if !t.active}<button class="ghost icon" aria-label="Close" onclick={() => uploader.clear()}>✕</button>{/if}
    </header>
    {#if !collapsed}
      <div class="tools">
        <div class="seg">
          {#each [['all', 'All'], ['active', 'In progress'], ['failed', 'Failed']] as [k, l]}
            <button class:on={filter === k} onclick={() => (filter = k as typeof filter)}>{l}</button>
          {/each}
        </div>
        <span class="grow"></span>
        {#if t.active}
          {#if uploader.paused}<button class="small" onclick={() => uploader.resume()}>Resume</button>{:else}<button class="small" onclick={() => uploader.pause()}>Pause</button>{/if}
          <button class="small ghost danger" onclick={() => uploader.cancelAll()}>Cancel all</button>
        {:else if t.failed}
          <button class="small" onclick={() => uploader.retry()}>Retry failed</button>
        {/if}
      </div>
      <div class="list">
        {#each shown as j (j.key)}
          <div class="job" class:fail={j.state === 'failed'}>
            <div class="grow">
              <div class="ellipsis small">{j.name}</div>
              <div class="tiny faint ellipsis">{j.dir || 'loose file'} · {formatBytes(j.size)}</div>
              {#if j.state === 'sending'}<div class="bar thin"><div class="used" style:width="{j.size ? (j.sent / j.size) * 100 : 100}%"></div></div>{/if}
            </div>
            <span class="tiny st" class:good={j.state === 'done' || j.state === 'skipped'} title={j.error ?? ''}>{label(j)}</span>
            {#if j.state === 'failed' || j.state === 'cancelled'}<button class="ghost tiny" onclick={() => uploader.retry(j)}>Retry</button>
            {:else if j.state === 'sending' || j.state === 'waiting'}<button class="ghost icon tiny" aria-label="Cancel" onclick={() => uploader.cancel(j)}>✕</button>{/if}
          </div>
        {/each}
        {#if uploader.jobs.length > 200}<p class="tiny faint" style="text-align:center">Showing 200 of {uploader.jobs.length}</p>{/if}
      </div>
      <p class="tiny faint hint">Stopped half way? Drop the same folder again: files already in Drive are skipped and half-sent ones carry on.</p>
    {/if}
  </section>
{/if}

<style>
  .panel { position: fixed; right: 1.25rem; bottom: 1.25rem; z-index: 40; width: min(26rem, calc(100vw - 2rem)); background: rgb(23 27 33 / 0.97); backdrop-filter: blur(16px); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: 0 30px 80px -20px rgb(0 0 0 / 0.85); overflow: hidden; }
  header { display: flex; gap: 0.8rem; align-items: center; padding: 0.9rem 0.8rem 0.9rem 1rem; }
  .ttl { font-weight: 650; font-size: 0.95rem; }
  .ring { --p: 0; width: 3rem; height: 3rem; border-radius: 50%; display: grid; place-items: center; flex: none;
    background: radial-gradient(closest-side, var(--panel) 78%, transparent 80% 100%), conic-gradient(var(--accent) calc(var(--p) * 1%), var(--raise) 0); }
  .ring span { font-weight: 700; font-size: 0.8rem; }
  .ring small { font-size: 0.6rem; color: var(--muted); }
  .tools { display: flex; gap: 0.4rem; align-items: center; padding: 0 0.8rem 0.6rem; }
  .seg { display: flex; background: var(--bg-2); border-radius: 9px; padding: 0.15rem; border: 1px solid var(--line); }
  .seg button { border: 0; background: none; font-size: 0.72rem; padding: 0.3rem 0.55rem; color: var(--muted); border-radius: 7px; }
  .seg button.on { background: var(--raise); color: var(--ink); }
  .list { max-height: 18rem; overflow: auto; border-top: 1px solid var(--line); padding: 0.3rem; }
  .job { display: flex; gap: 0.6rem; align-items: center; padding: 0.45rem 0.55rem; border-radius: 9px; }
  .job:hover { background: var(--panel-2); }
  .st { color: var(--muted); max-width: 11rem; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st.good { color: var(--good); }
  .fail .st { color: var(--bad); }
  .bar.thin { height: 4px; margin-top: 0.3rem; }
  .hint { margin: 0; padding: 0.6rem 1rem 0.8rem; border-top: 1px solid var(--line); }
  .collapsed header { padding-bottom: 0.9rem; }
</style>
