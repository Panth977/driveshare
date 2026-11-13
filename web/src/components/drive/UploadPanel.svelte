<script lang="ts">
  // Progress of the running upload or sync. Only counters and the few files in flight are drawn,
  // so a job over a million files costs the page the same as one over ten.
  import { formatBytes } from '@driveshare/backend/shared';
  import { transfers } from '../../lib/transfer.svelte.ts';
  import { mydrive } from '../../lib/mydrive.svelte.ts';

  let collapsed = $state(false);
  let showFailures = $state(false);
  const v = $derived(transfers.view);
  const handled = $derived(v ? v.same + v.uploaded + v.failed : 0);
  const pctFiles = $derived(v && v.files ? Math.min(100, (handled / v.files) * 100) : 0);
  const pctBytes = $derived(v && v.toSendBytes ? Math.min(100, (v.sentBytes / v.toSendBytes) * 100) : v?.phase === 'done' ? 100 : 0);
  const eta = $derived(v && v.speed > 1 ? Math.max(0, v.toSendBytes - v.sentBytes) / v.speed : 0);
  const time = (s: number) => (s < 60 ? `${Math.ceil(s)} s` : s < 3600 ? `${Math.ceil(s / 60)} min` : s < 86400 * 2 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);
  const n = (x: number) => x.toLocaleString();
  const waitLeft = $derived(v ? Math.max(0, Math.ceil((v.waitUntil - Date.now()) / 1000)) : 0);
  const title = $derived.by(() => {
    if (!v) return '';
    const what = v.job.kind === 'sync' ? 'Sync' : 'Upload';
    return ({ comparing: `${what}: comparing with Drive`, sending: `${what}: sending`, paused: `${what} paused`, done: v.failed ? `${what} finished with ${n(v.failed)} failed` : v.uploaded ? `${what} finished` : 'Already in sync', stopped: `${what} stopped`, failed: `${what} failed` })[v.phase];
  });
  const running = $derived(!!v && (v.phase === 'comparing' || v.phase === 'sending' || v.phase === 'paused'));
</script>

{#if transfers.saved && !transfers.busy}
  <section class="panel resume" aria-label="Unfinished transfer">
    <div class="grow">
      <div class="ttl">Unfinished {transfers.saved.kind}: “{transfers.saved.localName}” → {transfers.saved.targetName}</div>
      <div class="tiny muted num">
        {#if transfers.saved.stats}{n(transfers.saved.stats.uploaded)} sent · {n(transfers.saved.stats.same)} already there{transfers.saved.stats.failed ? ` · ${n(transfers.saved.stats.failed)} failed` : ''} · {/if}last run {new Date(transfers.saved.updatedAt).toLocaleString()}
      </div>
      {#if !transfers.saved.handle}<div class="tiny faint">Pick the same folder again with Sync folder: folders already done are skipped.</div>{/if}
      {#if transfers.error}<div class="tiny error">{transfers.error}</div>{/if}
    </div>
    {#if transfers.saved.handle && mydrive.drive}<button class="primary small" onclick={() => transfers.resumeSaved(mydrive.drive!)}>Resume</button>{/if}
    <button class="ghost small" onclick={() => transfers.forgetSaved()}>Forget</button>
  </section>
{/if}

{#if v}
  <section class="panel" class:collapsed aria-label="Transfer">
    <header>
      <div class="ring" style="--p:{v.toSendBytes ? pctBytes : pctFiles}">
        <span class="num">{Math.floor(v.toSendBytes ? pctBytes : pctFiles)}<small>%</small></span>
      </div>
      <div class="grow">
        <div class="ttl">{title}</div>
        <div class="tiny muted ellipsis">“{v.job.localName}” → {v.job.targetName}</div>
        <div class="tiny muted num">
          {formatBytes(v.sentBytes)} of {formatBytes(v.toSendBytes)} to send
          {#if v.phase === 'sending' || v.phase === 'comparing'}{#if v.speed > 1} · {formatBytes(v.speed)}/s{/if}{#if eta && !v.walking} · {time(eta)} left{/if}{/if}
        </div>
      </div>
      <button class="ghost icon" aria-label={collapsed ? 'Expand' : 'Collapse'} onclick={() => (collapsed = !collapsed)}>{collapsed ? '▴' : '▾'}</button>
      {#if !running}<button class="ghost icon" aria-label="Close" onclick={() => transfers.close()}>✕</button>{/if}
    </header>

    {#if !collapsed}
      <div class="grid num">
        <div><b>{n(v.files)}</b><span>files compared{v.walking ? '…' : ''}</span></div>
        <div><b>{n(v.same)}</b><span>already in Drive</span></div>
        <div class="hot"><b>{n(v.missing)}</b><span>new</span></div>
        <div class="hot"><b>{n(v.changed)}</b><span>changed</span></div>
        <div class="good"><b>{n(v.uploaded)}</b><span>sent</span></div>
        <div class:bad={v.failed}><b>{n(v.failed)}</b><span>failed</span></div>
      </div>
      <div class="bars">
        <div class="tiny muted row spread"><span>Compared</span><span class="num">{n(handled)} / {n(v.files)}{v.walking ? '+' : ''} · {n(v.folders)} folders{v.foldersSkipped ? ` · ${n(v.foldersSkipped)} done before` : ''}</span></div>
        <div class="bar thin"><div class="used" style:width="{pctFiles}%"></div></div>
        <div class="tiny muted row spread"><span>Sent</span><span class="num">{formatBytes(v.sentBytes)} / {formatBytes(v.toSendBytes)}{v.walking ? '+' : ''}</span></div>
        <div class="bar thin"><div class="used" style:width="{pctBytes}%"></div></div>
      </div>

      {#if waitLeft > 0}<p class="tiny warn">Google asked to slow down: waiting {waitLeft} s, then {v.parallel} at a time.</p>{/if}

      {#if v.current.length}
        <div class="list">
          {#each v.current as c (c.path)}
            <div class="job">
              <div class="grow">
                <div class="ellipsis small">{c.path}</div>
                <div class="bar thin"><div class="used" style:width="{c.size ? (c.sent / c.size) * 100 : 0}%"></div></div>
              </div>
              <span class="tiny muted num">{formatBytes(c.size)}</span>
            </div>
          {/each}
        </div>
      {:else if v.recent.length}
        <div class="tiny faint recent ellipsis">Last sent: {v.recent[0]}</div>
      {/if}

      {#if v.failed}
        <button class="link tiny fl" onclick={() => (showFailures = !showFailures)}>{showFailures ? 'Hide' : 'Show'} failed files</button>
        {#if showFailures}
          <div class="list fails">
            {#each v.failures as f (f.path)}<div class="tiny"><span class="ellipsis">{f.path}</span><span class="error"> · {f.error}</span></div>{/each}
            {#if v.failed > v.failures.length}<div class="tiny faint">…and {n(v.failed - v.failures.length)} more</div>{/if}
          </div>
        {/if}
      {/if}

      <div class="tools">
        {#if v.phase === 'paused'}<button class="small primary" onclick={() => transfers.resume()}>Resume</button>
        {:else if running}<button class="small" onclick={() => transfers.pause()}>Pause</button>{/if}
        {#if running}<button class="small ghost danger" onclick={() => transfers.stop()}>Stop</button>{/if}
        {#if running && v.failed}<button class="small ghost" onclick={() => transfers.retryFailed()}>Retry failed</button>{/if}
        <span class="grow"></span>
        <span class="tiny faint num">{v.parallel} at a time</span>
      </div>
      <p class="tiny faint hint">Keep this tab open; it may sit in the background. Stopped or closed? Resume here, or sync the same folder again: folders already done are skipped and half-sent files carry on.</p>
    {/if}
  </section>
{/if}

<style>
  .panel { position: fixed; right: 1.25rem; bottom: 1.25rem; z-index: 40; width: min(28rem, calc(100vw - 2rem)); background: rgb(23 27 33 / 0.97); backdrop-filter: blur(16px); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: 0 30px 80px -20px rgb(0 0 0 / 0.85); overflow: hidden; }
  .panel.resume { display: flex; gap: 0.6rem; align-items: center; padding: 0.8rem 0.9rem; }
  header { display: flex; gap: 0.8rem; align-items: center; padding: 0.9rem 0.8rem 0.8rem 1rem; }
  .ttl { font-weight: 650; font-size: 0.95rem; }
  .ring { --p: 0; width: 3rem; height: 3rem; border-radius: 50%; display: grid; place-items: center; flex: none;
    background: radial-gradient(closest-side, var(--panel) 78%, transparent 80% 100%), conic-gradient(var(--accent) calc(var(--p) * 1%), var(--raise) 0); }
  .ring span { font-weight: 700; font-size: 0.8rem; }
  .ring small { font-size: 0.6rem; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.4rem; padding: 0 1rem 0.7rem; }
  .grid div { background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px; padding: 0.45rem 0.6rem; display: grid; }
  .grid b { font-size: 1rem; }
  .grid span { font-size: 0.68rem; color: var(--muted); }
  .grid .hot b { color: var(--accent-2); }
  .grid .good b { color: var(--good); }
  .grid .bad b { color: var(--bad); }
  .bars { display: grid; gap: 0.3rem; padding: 0 1rem 0.7rem; }
  .bar.thin { height: 5px; }
  .warn { color: var(--warn); margin: 0 1rem 0.5rem; }
  .list { max-height: 12rem; overflow: auto; border-top: 1px solid var(--line); padding: 0.3rem; }
  .job { display: flex; gap: 0.6rem; align-items: center; padding: 0.4rem 0.55rem; border-radius: 9px; }
  .job .bar { margin-top: 0.25rem; height: 3px; }
  .recent { padding: 0.4rem 1rem; border-top: 1px solid var(--line); }
  .fl { margin: 0.3rem 1rem; }
  .fails div { display: flex; gap: 0.2rem; padding: 0.2rem 0.5rem; }
  .tools { display: flex; gap: 0.4rem; align-items: center; padding: 0.6rem 0.8rem; border-top: 1px solid var(--line); }
  .hint { margin: 0; padding: 0.6rem 1rem 0.8rem; border-top: 1px solid var(--line); }
</style>
