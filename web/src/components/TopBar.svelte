<script lang="ts">
  import { account } from '../lib/account.svelte.ts';
  import { router, nav } from '../lib/router.svelte.ts';
  import { tv } from '../lib/tv.svelte.ts';
  import { demoMode } from '../lib/mydrive.svelte.ts';
  let { title = 'DriveShare', tabs = false }: { title?: string; tabs?: boolean } = $props();
  const TABS = [
    { id: 'shares', label: 'Shares', to: '/' },
    { id: 'drive', label: 'My Drive', to: '/drive' },
    { id: 'view', label: 'Viewer', to: '/view' },
  ];
  const current = $derived(router.path.startsWith('/drive') ? 'drive' : router.path.startsWith('/view') ? 'view' : 'shares');
  let menu = $state(false);
</script>

<header class="topbar">
  <a class="brand" href="/" onclick={(e) => { e.preventDefault(); nav('/'); }}><img src="/icon.svg" alt="" />{title}</a>
  {#if tabs}
    <nav class="tabs" aria-label="Sections">
      {#each TABS as t}
        <button class:on={current === t.id} aria-current={current === t.id ? 'page' : undefined} onclick={() => nav(t.to)}>{t.label}</button>
      {/each}
    </nav>
  {/if}
  <span class="grow"></span>
  <button class="ghost small" title="TV mode: bigger interface, remote-friendly" aria-pressed={tv.on} onclick={() => tv.toggle()}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
    {tv.on ? 'TV on' : 'TV'}
  </button>
  {#if account.user || demoMode}
    <div class="who">
      <button class="ghost me" onclick={() => (menu = !menu)} aria-expanded={menu}>
        {#if account.user?.photo}<img class="avatar" src={account.user.photo} alt="" referrerpolicy="no-referrer" />{:else}<span class="avatar ph">{(account.user?.email ?? 'D')[0]?.toUpperCase()}</span>{/if}
      </button>
      {#if menu}
        <div class="menu" style="right:1rem; top:3.4rem" data-modal>
          <div class="small muted" style="padding:0.5rem 0.65rem">{account.user?.email ?? 'demo'}</div>
          <hr />
          <button onclick={() => { menu = false; void account.signOut(); }}>Sign out</button>
        </div>
      {/if}
    </div>
  {/if}
</header>

<style>
  .me { padding: 0.2rem; border-radius: 99px; }
  .ph { display: inline-grid; place-items: center; background: var(--raise); font-weight: 700; font-size: 0.8rem; }
  @media (max-width: 640px) { .brand { font-size: 0; gap: 0; } .topbar { gap: 0.5rem; padding: 0.6rem 0.75rem; } }
</style>
