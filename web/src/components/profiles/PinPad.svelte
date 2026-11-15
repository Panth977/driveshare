<script lang="ts">
  // A 4-digit PIN pad the remote can use: arrows + OK on the keys, or the remote's number keys.
  import { onMount } from 'svelte';
  import { profiles } from '../../lib/profiles.svelte.ts';
  import { isBack } from '../../lib/tv.svelte.ts';

  let digits = $state('');
  let first = $state<HTMLButtonElement | null>(null);
  const ask = $derived(profiles.ask);
  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✕'];

  function press(k: string) {
    if (k === '✕') return done(null);
    if (k === '⌫') { digits = digits.slice(0, -1); return; }
    if (digits.length >= 4) return;
    digits += k;
    if (digits.length === 4) setTimeout(() => done(digits), 120);
  }
  function done(v: string | null) { const a = ask; digits = ''; a?.resolve(v); }
  function key(e: KeyboardEvent) {
    if (!ask) return;
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); press('⌫'); }
    else if (isBack(e)) { e.preventDefault(); e.stopPropagation(); done(null); }
  }
  onMount(() => { setTimeout(() => first?.focus(), 50); });
</script>

<svelte:window onkeydowncapture={key} />

{#if ask}
  <div class="scrim" data-modal>
    <div class="pad">
      <h2>{ask.title}</h2>
      <div class="dots">{#each [0, 1, 2, 3] as i}<span class:on={digits.length > i}></span>{/each}</div>
      <div class="keys">
        {#each KEYS as k, i}
          {#if i === 0}<button bind:this={first} onclick={() => press(k)}>{k}</button>
          {:else}<button class:soft={k === '⌫' || k === '✕'} onclick={() => press(k)}>{k}</button>{/if}
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 90; background: rgb(5 6 8 / 0.75); display: grid; place-items: center; }
  .pad { width: 20rem; max-width: 92vw; background: var(--panel); border: 1px solid var(--line-2); border-radius: 1.2rem; padding: 1.4rem; display: grid; gap: 1rem; justify-items: center; }
  h2 { font-size: 1.05rem; text-align: center; }
  .dots { display: flex; gap: 0.8rem; }
  .dots span { width: 0.9rem; height: 0.9rem; border-radius: 50%; border: 2px solid var(--muted); }
  .dots span.on { background: var(--accent-2); border-color: var(--accent-2); }
  .keys { display: grid; grid-template-columns: repeat(3, 4.2rem); gap: 0.6rem; }
  .keys button { height: 3.4rem; font-size: 1.3rem; justify-content: center; border-radius: 0.8rem; font-weight: 700; }
  .keys button.soft { color: var(--muted); }
  .keys button:focus { background: #fff; color: #0d0f12; outline: none; box-shadow: none; }
</style>
