<script lang="ts">
  import { toast } from '../lib/toast.svelte.ts';
</script>

{#if toast.text}
  <div class="toast" role="status">
    <span>{toast.text}</span>
    {#if toast.action}<button class="primary small" onclick={() => { toast.action?.run(); toast.hide(); }}>{toast.action.label}</button>{/if}
    <button class="ghost icon small" aria-label="Close" onclick={() => toast.hide()}>✕</button>
  </div>
{/if}
