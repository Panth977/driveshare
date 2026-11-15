<script lang="ts">
  // "Saving 3…" while background actions run (bin, star, rotate, comment).
  import { activity } from '../lib/activity.svelte.ts';
</script>

{#if activity.pending}
  <div class="saving" role="status"><span class="spin"></span> Saving {activity.pending}…</div>
{/if}

<style>
  .saving { position: fixed; right: 1rem; bottom: 1rem; z-index: 70; display: flex; gap: 0.5rem; align-items: center; padding: 0.35rem 0.8rem; border-radius: 99px; background: rgb(23 27 33 / 0.92); border: 1px solid var(--line-2); font-size: 0.78rem; color: var(--ink-2); pointer-events: none; }
</style>
