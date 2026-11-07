<script lang="ts">
  import { formatBytes } from '@driveshare/backend/shared';
  let { cap, used, held = 0 }: { cap: number; used: number; held?: number } = $props();
  const pct = (n: number) => `${Math.min(100, (n / Math.max(cap, 1)) * 100)}%`;
  const full = $derived(used + held >= cap);
</script>

<div class="stack" style="gap:6px">
  <div class="bar" class:full><div class="used" style:width={pct(used)}></div><div class="held" style:width={pct(held)}></div></div>
  <div class="row spread small muted">
    <span>{formatBytes(used)} used{held ? ` · ${formatBytes(held)} uploading` : ''}</span>
    <span>{formatBytes(Math.max(0, cap - used - held))} left of {formatBytes(cap)}</span>
  </div>
</div>
