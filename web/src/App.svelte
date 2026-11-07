<script lang="ts">
  import Admin from './routes/Admin.svelte';
  import Upload from './routes/Upload.svelte';
  import Link from './routes/Link.svelte';

  let path = $state(location.pathname);
  addEventListener('popstate', () => (path = location.pathname));
  const upload = $derived(/^\/s\/([\w-]+)\/?$/.exec(path));
</script>

{#if upload}
  <Upload shareId={upload[1]!} />
{:else if path.startsWith('/link')}
  <Link />
{:else}
  <Admin />
{/if}
