<script lang="ts">
  import { onMount } from 'svelte';
  import { failText, type DFile, type DriveApi } from '../../lib/gdrive.ts';
  import { isBack } from '../../lib/tv.svelte.ts';
  import QrCode from '../QrCode.svelte';
  let { drive, file, onclose }: { drive: DriveApi; file: DFile; onclose: () => void } = $props();
  let url = $state('');
  let error = $state('');
  let copied = $state(false);
  let stopped = $state(false);

  onMount(() => {
    drive.shareAnyone(file.id).then((u) => {
      url = u;
      navigator.clipboard?.writeText(u).then(() => (copied = true), () => {});
    }, (e) => (error = failText(e)));
  });
  const copy = () => navigator.clipboard.writeText(url).then(() => { copied = true; setTimeout(() => (copied = false), 1500); });
  async function stop() {
    try { await drive.unshareAnyone(file.id); stopped = true; } catch (e) { error = failText(e); }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" data-modal onkeydown={(e) => { if (isBack(e)) { e.preventDefault(); e.stopPropagation(); onclose(); } }} onpointerdown={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="dialog stack share">
    <div>
      <h2>Share link</h2>
      <p class="muted small ellipsis" style="margin:0.3rem 0 0">{file.name}</p>
    </div>
    {#if error}
      <p class="error">{error}</p>
    {:else if stopped}
      <p class="muted">Link turned off. Only people you shared with directly can open it.</p>
    {:else if !url}
      <p class="muted"><span class="spin"></span> Making a link…</p>
    {:else}
      <div class="body">
        <QrCode text={url} size={176} />
        <div class="stack grow" style="gap:0.6rem">
          <p class="small muted" style="margin:0">Anyone with this link can view{file.mimeType.endsWith('.folder') ? ' everything in this folder' : ''}. Scan it or send it.</p>
          <input class="mono" readonly value={url} onfocus={(e) => e.currentTarget.select()} />
          <div class="row">
            <button class="primary" onclick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
            <button class="ghost danger" onclick={stop}>Stop sharing</button>
          </div>
        </div>
      </div>
    {/if}
    <div class="row" style="justify-content:flex-end"><button class="ghost" onclick={onclose}>Done</button></div>
  </div>
</div>

<style>
  .share { width: min(36rem, 100%); }
  .body { display: flex; gap: 1.2rem; align-items: center; flex-wrap: wrap; }
</style>
