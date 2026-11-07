<script lang="ts">
  import { parseBytes } from '@driveshare/backend/shared';
  import { createShare, errorText } from '../lib/icebase.ts';
  let { onclose }: { onclose: () => void } = $props();

  let name = $state('');
  let cap = $state('15 GB');
  let maxFile = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const capBytes = parseBytes(cap);
    const maxFileBytes = maxFile.trim() ? parseBytes(maxFile) : 0;
    if (!name.trim()) return void (error = 'Give the share a name.');
    if (!(capBytes > 0)) return void (error = 'Cap: write a size like 20 GB or 1 TB.');
    if (Number.isNaN(maxFileBytes)) return void (error = 'Largest file: write a size like 4 GB, or leave it empty.');
    busy = true;
    error = '';
    try {
      await createShare({ name: name.trim(), capBytes, maxFileBytes, ...(password.trim() ? { password: password.trim() } : {}) });
      onclose();
    } catch (err) {
      error = errorText(err);
    } finally {
      busy = false;
    }
  }
</script>

<form class="card stack" onsubmit={submit}>
  <h3>New share</h3>
  <label>Name (also the folder name in your Drive)<input bind:value={name} placeholder="Wedding photos" maxlength="120" /></label>
  <div class="grid2">
    <label>Cap for the whole folder<input bind:value={cap} placeholder="15 GB" /></label>
    <label>Largest single file (optional)<input bind:value={maxFile} placeholder="no limit" /></label>
  </div>
  <label>Link password (optional)<input bind:value={password} type="password" autocomplete="new-password" placeholder="none" /></label>
  {#if error}<p class="error">{error}</p>{/if}
  <div class="row">
    <button class="primary" disabled={busy}>{busy ? 'Creating…' : 'Create share'}</button>
    <button type="button" onclick={onclose}>Cancel</button>
  </div>
</form>
