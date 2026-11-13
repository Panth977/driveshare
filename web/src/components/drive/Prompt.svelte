<script lang="ts">
  import { onMount } from 'svelte';
  import { isBack } from '../../lib/tv.svelte.ts';
  let { title, label = '', value = '', ok = 'OK', danger = false, text = '', onok, oncancel }:
    { title: string; label?: string; value?: string; ok?: string; danger?: boolean; text?: string; onok: (v: string) => void; oncancel: () => void } = $props();
  // svelte-ignore state_referenced_locally
  let v = $state(value);
  let input = $state<HTMLInputElement | null>(null);
  let okBtn = $state<HTMLButtonElement | null>(null);
  onMount(() => {
    if (input) { input.focus(); const dot = v.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : v.length); }
    else okBtn?.focus();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" data-modal onkeydown={(e) => { if (isBack(e) && !(e.key === 'Backspace')) { e.stopPropagation(); oncancel(); } }} onpointerdown={(e) => { if (e.target === e.currentTarget) oncancel(); }}>
  <form class="dialog stack" onsubmit={(e) => { e.preventDefault(); onok(v.trim()); }}>
    <h2>{title}</h2>
    {#if text}<p class="muted" style="margin:0">{text}</p>{/if}
    {#if label}<label>{label}<input bind:this={input} bind:value={v} /></label>{/if}
    <div class="row" style="justify-content:flex-end; margin-top:0.4rem">
      <button type="button" class="ghost" onclick={oncancel}>Cancel</button>
      <button bind:this={okBtn} class={danger ? 'danger' : 'primary'} disabled={!!label && !v.trim()}>{ok}</button>
    </div>
  </form>
</div>
