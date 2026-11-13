<script lang="ts" module>
  export interface MenuItem { label: string; run: () => void; key?: string; danger?: boolean; sep?: boolean; disabled?: boolean }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { isBack } from '../../lib/tv.svelte.ts';
  let { x, y, items, onclose }: { x: number; y: number; items: MenuItem[]; onclose: () => void } = $props();
  let el: HTMLDivElement;
  let pos = $state({ left: 0, top: 0 });

  onMount(() => {
    const r = el.getBoundingClientRect();
    pos = { left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) };
    el.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    const away = (e: Event) => { if (!el.contains(e.target as Node)) onclose(); };
    setTimeout(() => { addEventListener('pointerdown', away); addEventListener('blur', onclose); });
    return () => { removeEventListener('pointerdown', away); removeEventListener('blur', onclose); };
  });

  function key(e: KeyboardEvent) {
    const bs = [...el.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length]?.focus(); }
    else if (isBack(e) || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); onclose(); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu" bind:this={el} style:left="{pos.left}px" style:top="{pos.top}px" role="menu" tabindex="-1" onkeydown={key} data-modal oncontextmenu={(e) => e.preventDefault()}>
  {#each items as it}
    {#if it.sep}<hr />{/if}
    <button role="menuitem" class:danger={it.danger} disabled={it.disabled} onclick={() => { onclose(); it.run(); }}>
      {it.label}{#if it.key}<span class="kbd">{it.key}</span>{/if}
    </button>
  {/each}
</div>
