<script lang="ts">
  // "Who is watching?" on a TV with household profiles.
  import { onMount } from 'svelte';
  import { profiles } from '../../lib/profiles.svelte.ts';
  let first = $state<HTMLButtonElement | null>(null);
  onMount(() => { setTimeout(() => first?.focus(), 60); });
</script>

<div class="who">
  <h1>Who is watching?</h1>
  <div class="row">
    {#each profiles.list as p, i (p.id)}
      {#if i === 0}
        <button class="p" bind:this={first} onclick={() => profiles.pick(p)}><span class="av" style:background={p.color}>{p.name[0]?.toUpperCase()}</span><b>{p.name}</b>{#if p.pin}<small>🔒 PIN</small>{/if}</button>
      {:else}
        <button class="p" onclick={() => profiles.pick(p)}><span class="av" style:background={p.color}>{p.name[0]?.toUpperCase()}</span><b>{p.name}</b>{#if p.pin}<small>🔒 PIN</small>{/if}</button>
      {/if}
    {/each}
  </div>
</div>

<style>
  .who { min-height: 100vh; display: grid; place-content: center; justify-items: center; gap: 2.4rem; background: radial-gradient(50rem 25rem at 50% 0, rgb(124 156 255 / 0.15), transparent 60%), var(--bg); }
  h1 { font-size: 2.2rem; }
  .row { display: flex; gap: 2rem; flex-wrap: wrap; justify-content: center; }
  .p { display: grid; justify-items: center; gap: 0.6rem; border: 0; background: none; padding: 0.6rem; border-radius: 1rem; }
  .p:hover { background: none; }
  .av { width: 7rem; height: 7rem; border-radius: 1.4rem; display: grid; place-items: center; font-size: 3rem; font-weight: 800; color: #0d0f12; transition: transform 0.15s; }
  .p:focus { outline: none; box-shadow: none; }
  .p:focus .av { transform: scale(1.08); box-shadow: 0 0 0 0.25rem #fff; }
  b { font-size: 1.05rem; }
  small { color: var(--muted); font-size: 0.75rem; }
</style>
