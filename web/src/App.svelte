<script lang="ts">
  import Home from './routes/Home.svelte';
  import Upload from './routes/Upload.svelte';
  import Link from './routes/Link.svelte';
  import TvApprove from './routes/TvApprove.svelte';
  import { router } from './lib/router.svelte.ts';
  import { installSpatialNav } from './lib/tv.svelte.ts';

  installSpatialNav();
  const upload = $derived(/^\/s\/([\w-]+)\/?$/.exec(router.path));
</script>

{#if upload}
  <Upload shareId={upload[1]!} />
{:else if router.path.startsWith('/link')}
  <Link />
{:else if router.path === '/tv'}
  <TvApprove />
{:else}
  <Home />
{/if}
