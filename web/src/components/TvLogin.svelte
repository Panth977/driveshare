<script lang="ts">
  // The TV side of phone sign-in: a QR code the owner scans with a signed-in phone.
  import { onMount } from 'svelte';
  import { collection, doc, onSnapshot } from '@panth977/icebase/firestore';
  import { tvLogins } from '@driveshare/backend/schema';
  import { account } from '../lib/account.svelte.ts';
  import { db, errorText, tvClaim, tvStart } from '../lib/icebase.ts';
  import QrCode from './QrCode.svelte';

  let { size = 260 }: { size?: number } = $props();
  let req = $state<{ id: string; secret: string; code: string; expiresAt: number } | null>(null);
  let status = $state<'loading' | 'waiting' | 'approved' | 'error'>('loading');
  let error = $state('');
  let left = $state(0);

  const link = $derived(req ? `${location.origin}/tv#${req.id}.${req.secret}` : '');
  const device = () => {
    const ua = navigator.userAgent;
    const m = /(Tizen|Web0S|WebOS|BRAVIA|AFT\w+|CrKey|Android TV|GoogleTV|Macintosh|Windows|iPhone|iPad|Android|Linux)/i.exec(ua);
    const b = /(Edg|Chrome|Firefox|Safari)\/[\d.]+/.exec(ua)?.[1];
    return [m?.[1], b].filter(Boolean).join(' · ') || 'A browser';
  };

  async function claim(r: NonNullable<typeof req>) {
    try {
      const c = await tvClaim({ id: r.id, secret: r.secret });
      if (c.token) { status = 'approved'; await account.signInWithToken(c.token); }
      else if (c.state === 'expired' || c.state === 'used') void start();
    } catch (e) { error = errorText(e); }
  }

  async function start() {
    status = 'loading';
    error = '';
    try {
      req = await tvStart({ device: device() });
      status = 'waiting';
    } catch (e) {
      status = 'error';
      error = errorText(e);
    }
  }

  onMount(() => { void start(); });

  // Watch the request; when the phone approves it, trade it for a session.
  $effect(() => {
    const r = req;
    if (!r) return;
    let poll: ReturnType<typeof setInterval> | null = null;
    const stop = onSnapshot(doc(collection(db, tvLogins), r.id), (s) => {
      if ((s.data() as { state?: string } | undefined)?.state === 'approved') void claim(r);
    }, () => { poll ??= setInterval(() => void claim(r), 4000); });
    const tick = setInterval(() => {
      left = Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000));
      if (left === 0) void start();
    }, 1000);
    return () => { stop(); clearInterval(tick); if (poll) clearInterval(poll); };
  });
</script>

<div class="tvlogin">
  {#if req && status !== 'error'}
    <div class="qrwrap" class:dim={status === 'approved'}>
      <QrCode text={link} {size} />
      {#if status === 'approved'}<div class="ok"><span class="spin"></span> Signing in…</div>{/if}
    </div>
    <div class="stack" style="gap:0.9rem">
      <h2>Sign in with your phone</h2>
      <ol class="steps">
        <li>Scan the code with your phone's camera.</li>
        <li>Sign in there with Google, if it asks.</li>
        <li>Check the code matches, tap <b>Approve</b>.</li>
      </ol>
      <div class="code num" aria-label="Code">{req.code}</div>
      <p class="tiny faint" style="margin:0">New code in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · <button class="link tiny" onclick={start}>Refresh</button></p>
    </div>
  {:else if status === 'error'}
    <p class="error">{error}</p>
    <button onclick={start}>Try again</button>
  {:else}
    <div class="skeleton" style:width="{size / 16}rem" style:height="{size / 16}rem"></div>
  {/if}
</div>

<style>
  .tvlogin { display: flex; gap: 2rem; align-items: center; text-align: left; flex-wrap: wrap; justify-content: center; }
  .qrwrap { position: relative; }
  .qrwrap.dim :global(.qr) { opacity: 0.25; }
  .ok { position: absolute; inset: 0; display: grid; place-items: center; font-weight: 600; }
  .steps { margin: 0; padding-left: 1.2rem; color: var(--ink-2); line-height: 1.7; font-size: 0.95rem; }
  .code { font-family: var(--mono); font-size: 2rem; font-weight: 700; letter-spacing: 0.35em; color: var(--accent-2); }
</style>
