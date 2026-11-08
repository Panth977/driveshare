<script lang="ts">
  import { formatBytes, parseBytes } from '@driveshare/backend/shared';
  import { account } from '../lib/account.svelte.ts';
  import { deleteShare, errorCode, errorText, sweepNow, syncShare, updateShare } from '../lib/icebase.ts';
  import { folderUrl, uploadUrl, watchTransfers, watchUploads, when, type ShareView } from '../lib/shares.svelte.ts';
  import Usage from './Usage.svelte';

  let { share: s }: { share: ShareView } = $props();

  let open = $state(false);
  let busy = $state('');
  let note = $state('');
  let error = $state('');
  let copied = $state(false);
  let ups = $state<Awaited<Parameters<Parameters<typeof watchUploads>[1]>[0]>>([]);
  let moves = $state<Awaited<Parameters<Parameters<typeof watchTransfers>[1]>[0]>>([]);

  // edit fields
  let name = $state('');
  let cap = $state('');
  let maxFile = $state('');
  let password = $state('');
  let emails = $state('');

  function reset() {
    name = s.name;
    cap = formatBytes(s.capBytes);
    maxFile = s.maxFileBytes ? formatBytes(s.maxFileBytes) : '';
    password = '';
    emails = s.linkedEmails.join('\n');
  }

  $effect(() => {
    if (!open) return;
    reset();
    const a = watchUploads(s.id, (l) => (ups = l));
    const b = watchTransfers(s.id, (l) => (moves = l));
    return () => { a(); b(); };
  });

  async function run(label: string, fn: () => Promise<unknown>) {
    busy = label;
    error = '';
    note = '';
    try {
      await fn();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = '';
    }
  }

  const copy = () => navigator.clipboard.writeText(uploadUrl(s)).then(() => { copied = true; setTimeout(() => (copied = false), 1500); });

  async function save() {
    const capBytes = parseBytes(cap);
    const maxFileBytes = maxFile.trim() ? parseBytes(maxFile) : 0;
    if (!(capBytes > 0) || Number.isNaN(maxFileBytes)) return void (error = 'Sizes: write them like 20 GB, 500 MB or 1 TB.');
    const linkedEmails = emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
    const input = {
      shareId: s.id,
      ...(name.trim() !== s.name ? { name: name.trim() } : {}),
      ...(capBytes !== s.capBytes ? { capBytes } : {}),
      ...(maxFileBytes !== s.maxFileBytes ? { maxFileBytes } : {}),
      ...(password.trim() ? { password: password.trim() } : {}),
      ...(linkedEmails.join() !== s.linkedEmails.join() ? { linkedEmails } : {}),
    };
    await run('save', async () => {
      try {
        const r = await updateShare(input);
        note = r.warnings.length ? r.warnings.join(' · ') : 'Saved.';
      } catch (e) {
        if (errorCode(e) !== 'failed-precondition' || !/needs-full-drive/.test(errorText(e))) throw e;
        // Accepting files from linked accounts needs full Drive access for the owner: one more consent.
        if (!confirm('Linked accounts hand their files to you, and accepting them needs DriveShare to manage your whole Drive. Continue to Google?')) return;
        if (!(await account.signIn('full'))) throw new Error(account.error || 'Full Drive access was not granted.');
        const r = await updateShare(input);
        note = r.warnings.length ? r.warnings.join(' · ') : 'Saved.';
      }
      password = '';
    });
  }
</script>

<article class="card stack">
  <div class="row spread">
    <div class="stack" style="gap:4px">
      <h2>{s.name}</h2>
      <div class="row small">
        <span class="pill" class:on={s.enabled && s.uploadLink}>{s.enabled && s.uploadLink ? 'Link on' : 'Link off'}</span>
        {#if s.passwordHash}<span class="pill">Password</span>{/if}
        {#if s.publicView}<span class="pill">Folder viewable</span>{/if}
        {#if s.linkedEmails.length}<span class="pill on">{s.linkedEmails.length} linked</span>{/if}
        {#if s.lastError}<span class="pill warn" title={s.lastError}>Needs attention</span>{/if}
        {#if s.sweepLeft}<span class="pill">{s.sweepLeft} waiting</span>{/if}
        <span class="muted">{s.fileCount} files{s.maxFileBytes ? ` · max ${formatBytes(s.maxFileBytes)} each` : ''}</span>
      </div>
    </div>
    <div class="row">
      <a class="btn" href={folderUrl(s.folderId)} target="_blank" rel="noopener">Open in Drive</a>
      <button onclick={() => (open = !open)}>{open ? 'Close' : 'Manage'}</button>
    </div>
  </div>

  <Usage cap={s.capBytes} used={s.usedBytes} held={s.reservedBytes} />

  <div class="row">
    <input class="mono" readonly value={uploadUrl(s)} style="flex:1; min-width:220px" onfocus={(e) => e.currentTarget.select()} />
    <button class="primary" onclick={copy}>{copied ? 'Copied' : 'Copy upload link'}</button>
  </div>

  {#if open}
    <hr style="border:0; border-top:1px solid var(--line); width:100%" />
    <div class="row">
      <button disabled={!!busy} onclick={() => run('link', () => updateShare({ shareId: s.id, uploadLink: !s.uploadLink }))}>{s.uploadLink ? 'Turn link off' : 'Turn link on'}</button>
      <button disabled={!!busy} onclick={() => run('rotate', () => updateShare({ shareId: s.id, rotateSecret: true }))}>New link (old one stops)</button>
      <button disabled={!!busy} onclick={() => run('view', () => updateShare({ shareId: s.id, publicView: !s.publicView }))}>{s.publicView ? 'Hide folder from link holders' : 'Let link holders view the folder'}</button>
      <button disabled={!!busy} onclick={() => run('sync', async () => { const r = await syncShare({ shareId: s.id }); note = `Counted ${r.fileCount} files, ${formatBytes(r.usedBytes)}.`; })}>{busy === 'sync' ? 'Counting…' : 'Recount usage'}</button>
    </div>

    <div class="grid2">
      <label>Name<input bind:value={name} maxlength="120" /></label>
      <label>Cap<input bind:value={cap} /></label>
      <label>Largest single file<input bind:value={maxFile} placeholder="no limit" /></label>
      <label>{s.passwordHash ? 'New password (empty = keep)' : 'Password (optional)'}<input bind:value={password} type="password" autocomplete="new-password" /></label>
    </div>
    {#if s.passwordHash}<div><button class="link small" disabled={!!busy} onclick={() => run('pw', () => updateShare({ shareId: s.id, password: '' }))}>Remove the password</button></div>{/if}

    <label>
      Linked Google accounts (one per line)
      <textarea bind:value={emails} rows="3" placeholder="my.other.account@gmail.com"></textarea>
      <span class="small" style="font-weight:400">They get edit access to the Drive folder and can drop files in from Google Drive itself. Once they sign in at <a href="/link">/link</a>, files they add move to your Drive (every 5 minutes, or “Move now”), so they stop using their storage. Files over the cap stay with them.</span>
    </label>

    {#if error}<p class="error">{error}</p>{/if}
    {#if note}<p class="small muted">{note}</p>{/if}
    <div class="row">
      <button class="primary" disabled={!!busy} onclick={save}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
      {#if s.linkedEmails.length}
        <button disabled={!!busy} onclick={() => run('sweep', async () => { const r = await sweepNow({ shareId: s.id }); note = `Moved ${r.moved}, over cap ${r.overCap}, failed ${r.failed}${r.left ? `, ${r.left} still waiting (runs again in 5 min, or press Move now)` : ''}.${r.errors.length ? ' ' + r.errors.join(' · ') : ''}`; })}>{busy === 'sweep' ? 'Moving…' : 'Move now'}</button>
      {/if}
      <span style="flex:1"></span>
      <button class="danger" disabled={!!busy} onclick={() => { const t = confirm(`Delete “${s.name}”?\n\nOK = also move its Drive folder to the bin.\nCancel = keep it.`); if (t || confirm('Forget the share but keep the folder in Drive?')) run('delete', () => deleteShare({ shareId: s.id, trashFolder: t })); }}>Delete</button>
    </div>
    {#if s.lastError}<p class="small" style="color:var(--warn); white-space:pre-line">{s.lastError}</p>{/if}

    <div class="grid2" style="align-items:start">
      <div class="stack" style="gap:6px">
        <h3>Recent uploads</h3>
        {#if ups.length === 0}<p class="small muted">None yet.</p>{:else}
          <table><tbody>{#each ups as u (u.id)}<tr><td>{u.name}{#if u.by}<div class="small muted">by {u.by}</div>{/if}</td><td class="small">{formatBytes(u.size)}</td><td class="small muted">{u.state === 'done' ? when(u.createdAt) : u.state}</td></tr>{/each}</tbody></table>
        {/if}
      </div>
      <div class="stack" style="gap:6px">
        <h3>From linked accounts</h3>
        <p class="small muted" style="margin:0">Last run: {when(s.lastSweep)}{s.sweepLeft ? ` · ${s.sweepLeft} files still waiting (next run continues)` : ''}</p>
        {#if moves.length === 0}<p class="small muted">Nothing moved yet.</p>{:else}
          <table><tbody>{#each moves as m (m.id)}<tr><td>{m.name}<div class="small muted">{m.from}</div></td><td class="small">{formatBytes(m.size)}</td><td class="small" title={m.error ?? ''} style:color={m.state === 'moved' ? 'var(--accent)' : 'var(--warn)'}>{m.state}</td></tr>{/each}</tbody></table>
        {/if}
      </div>
    </div>
  {/if}
</article>
