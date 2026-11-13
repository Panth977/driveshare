<script lang="ts">
  import { FOLDER_MIME, type DFile } from '../../lib/gdrive.ts';
  let { file, size = 1.25, shared = false }: { file: Pick<DFile, 'mimeType' | 'name'>; size?: number; shared?: boolean } = $props();
  const m = $derived(file.mimeType);
  const kind = $derived(
    m === FOLDER_MIME ? 'folder'
    : m.startsWith('image/') ? 'image'
    : m.startsWith('video/') ? 'video'
    : m.startsWith('audio/') ? 'audio'
    : m === 'application/pdf' ? 'pdf'
    : m.includes('spreadsheet') || /\.(xlsx?|csv)$/i.test(file.name) ? 'sheet'
    : m.includes('presentation') || /\.pptx?$/i.test(file.name) ? 'slides'
    : m.includes('document') || /\.(docx?|txt|md|rtf)$/i.test(file.name) || m.startsWith('text/') ? 'doc'
    : /zip|compressed|tar|rar|7z|gzip/.test(m) ? 'zip'
    : 'file');
  const COLORS: Record<string, string> = { folder: 'var(--folder)', image: '#f59e8b', video: '#c18cff', audio: '#ffc66d', pdf: '#ff7b7b', sheet: '#4fd1a1', slides: '#ffb454', doc: '#7cb7ff', zip: '#b8a07e', file: '#8b94a1' };
</script>

<svg width="{size}rem" height="{size}rem" viewBox="0 0 24 24" aria-hidden="true" style:color={COLORS[kind]}>
  {#if kind === 'folder'}
    <path d="M2.5 6.5A2 2 0 0 1 4.5 4.5h4.6l2 2h8.4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill="currentColor" opacity=".9"/>
    <path d="M2.5 9h19v8.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill="currentColor"/>
    {#if shared}<circle cx="17.5" cy="15.5" r="3.2" fill="#0d0f12"/><circle cx="17.5" cy="15.5" r="1.6" fill="currentColor"/>{/if}
  {:else}
    <path d="M6 2.5h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z" fill="currentColor" opacity=".18"/>
    <path d="M6 2.5h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.3"/>
    <path d="M14 2.5v5h5" fill="none" stroke="currentColor" stroke-width="1.3"/>
    {#if kind === 'image'}<circle cx="10" cy="12" r="1.4" fill="currentColor"/><path d="M7.5 18.5l3-3.5 2 2 2-2.5 2.5 4z" fill="currentColor"/>
    {:else if kind === 'video'}<path d="M10 11.5v6l5-3z" fill="currentColor"/>
    {:else if kind === 'audio'}<path d="M11 18.2a1.6 1.6 0 1 1-1.6-1.6c.6 0 1.6.3 1.6.6v-6l4-1v5.6a1.6 1.6 0 1 1-1.6-1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>
    {:else if kind === 'pdf'}<text x="12" y="17.6" font-size="5.2" font-weight="800" text-anchor="middle" fill="currentColor" font-family="system-ui">PDF</text>
    {:else if kind === 'sheet'}<path d="M8 11h8v7H8zM8 13.5h8M8 16h8M11 11v7" fill="none" stroke="currentColor" stroke-width="1.1"/>
    {:else if kind === 'slides'}<rect x="8" y="11.5" width="8" height="5.5" rx=".6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    {:else if kind === 'doc'}<path d="M8 11.5h8M8 14h8M8 16.5h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    {:else if kind === 'zip'}<path d="M11 3v2h2v2h-2v2h2v2h-2v2" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="10.5" y="13" width="3" height="3.5" rx=".6" fill="currentColor"/>
    {/if}
  {/if}
</svg>

<style>svg { flex: none; display: block; }</style>
