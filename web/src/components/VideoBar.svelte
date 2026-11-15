<script lang="ts">
  // A YouTube-style bar for the viewer's video: a red played line over grey "loaded" parts, a
  // knob, the time, play/pause, back/forward 10 s and speed. Click or drag the line to jump (a
  // tooltip shows the time under the mouse). On a TV the line takes the remote's focus:
  // ← → jump back/forward (faster the more you press), OK plays/pauses.
  let { video, show, onwake }: { video: HTMLVideoElement; show: boolean; onwake: () => void } = $props();

  let now = $state(0);
  let dur = $state(0);
  let paused = $state(true);
  let loaded = $state<[number, number][]>([]);
  let rate = $state(1);
  let hoverX = $state<number | null>(null);
  let trackW = $state(0);
  let dragging = $state(false);
  let flash = $state<{ text: string; dir: -1 | 1; n: number } | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let trackEl = $state<HTMLElement | null>(null);

  $effect(() => {
    const v = video;
    const sync = () => {
      if (!dragging) now = v.currentTime;
      dur = Number.isFinite(v.duration) ? v.duration : 0;
      paused = v.paused;
      rate = v.playbackRate;
      const b: [number, number][] = [];
      for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i), v.buffered.end(i)]);
      loaded = b;
    };
    const evs = ['timeupdate', 'durationchange', 'loadedmetadata', 'progress', 'play', 'pause', 'ratechange', 'seeking'];
    for (const ev of evs) v.addEventListener(ev, sync);
    sync();
    return () => { for (const ev of evs) v.removeEventListener(ev, sync); };
  });

  export function fmt(s: number): string {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
  }

  // Pressing again quickly jumps further: 10 s, 10 s, 20 s, 30 s, then a minute at a time.
  let lastSeek = 0, streak = 0, sum = 0;
  export function seek(dir: -1 | 1) {
    const t = Date.now();
    if (t - lastSeek < 700 && flash?.dir === dir) streak++; else { streak = 0; sum = 0; }
    lastSeek = t;
    const step = [10, 10, 20, 30][streak] ?? 60;
    sum += step;
    jump(video.currentTime + dir * step);
    flash = { text: `${dir < 0 ? '−' : '+'}${sum >= 60 ? `${Math.floor(sum / 60)}:${String(sum % 60).padStart(2, '0')}` : `${sum} s`}`, dir, n: (flash?.n ?? 0) + 1 };
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = null), 800);
    onwake();
  }
  export function toggle() {
    if (video.paused) video.play().catch(() => {}); else video.pause();
    onwake();
  }
  export function focus() { trackEl?.focus(); }
  function jump(t: number) {
    const d = Number.isFinite(video.duration) ? video.duration : 0;
    video.currentTime = Math.max(0, d ? Math.min(d - 0.25, t) : t);
    now = video.currentTime;
  }
  function speed() {
    const steps = [1, 1.25, 1.5, 2, 0.5];
    video.playbackRate = steps[(steps.indexOf(video.playbackRate) + 1) % steps.length]!;
    onwake();
  }

  const at = (e: PointerEvent) => {
    const r = trackEl!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  function down(e: PointerEvent) {
    e.stopPropagation();
    if (!dur) return;
    dragging = true;
    trackEl!.setPointerCapture(e.pointerId);
    now = at(e) * dur;
  }
  function move(e: PointerEvent) {
    hoverX = at(e) * trackW;
    if (dragging) now = at(e) * dur;
    onwake();
  }
  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    jump(at(e) * dur);
  }
  function keys(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { seek(e.key === 'ArrowLeft' ? -1 : 1); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Enter' || e.key === ' ') { toggle(); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Home') { jump(0); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'End') { jump(dur); e.preventDefault(); e.stopPropagation(); }
  }
  const pct = (t: number) => (dur ? `${(t / dur) * 100}%` : '0%');
</script>

{#if flash}
  {#key flash.n}<div class="flash" class:back={flash.dir < 0}><span>{flash.dir < 0 ? '⏪' : '⏩'}</span>{flash.text}</div>{/key}
{/if}
{#if paused && !dragging && dur && now > 0}<div class="bigplay" aria-hidden="true"><svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M8 5v14l11-7z" fill="currentColor" /></svg></div>{/if}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="vbar" class:show={show || paused || dragging} data-chrome onclick={(e) => e.stopPropagation()}>
  <div class="track" bind:this={trackEl} bind:clientWidth={trackW} tabindex="0" role="slider" aria-label="Video time"
    aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(now)} aria-valuetext={`${fmt(now)} of ${fmt(dur)}`}
    onpointerdown={down} onpointermove={move} onpointerup={up} onpointerleave={() => (hoverX = null)} onkeydown={keys}>
    <div class="rail">
      {#each loaded as [a, b]}<div class="buf" style:left={pct(a)} style:width={pct(b - a)}></div>{/each}
      <div class="played" style:width={pct(now)}></div>
    </div>
    <div class="knob" style:left={pct(now)}></div>
    {#if hoverX !== null && dur}<div class="tip num" style:left="{Math.max(24, Math.min(trackW - 24, hoverX))}px">{fmt((hoverX / (trackW || 1)) * dur)}</div>{/if}
  </div>
  <div class="row">
    <button class="ghost icon" tabindex="-1" aria-label={paused ? 'Play' : 'Pause'} onclick={toggle}>
      {#if paused}<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
      {:else}<svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" /></svg>{/if}
    </button>
    <button class="ghost icon" tabindex="-1" aria-label="Back 10 seconds" title="Back 10 s (J)" onclick={() => seek(-1)}>⟲<small>10</small></button>
    <button class="ghost icon" tabindex="-1" aria-label="Forward 10 seconds" title="Forward 10 s (L)" onclick={() => seek(1)}>⟳<small>10</small></button>
    <span class="time num">{fmt(now)} <span class="faint">/ {fmt(dur)}</span></span>
    <span class="grow"></span>
    <button class="ghost small" tabindex="-1" title="Speed" onclick={speed}>{rate}×</button>
  </div>
</div>

<style>
  .vbar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; padding: 1.6rem 1rem 0.5rem; background: linear-gradient(0deg, rgb(0 0 0 / 0.75), transparent); opacity: 0; transition: opacity 0.25s; pointer-events: none; }
  .vbar.show { opacity: 1; pointer-events: auto; }
  .track { position: relative; height: 1.1rem; display: flex; align-items: center; cursor: pointer; outline: none; touch-action: none; }
  .rail { position: relative; height: 4px; width: 100%; background: rgb(255 255 255 / 0.22); border-radius: 2px; transition: height 0.12s; }
  .track:hover .rail, .track:focus-visible .rail, .track:focus .rail { height: 7px; }
  .buf { position: absolute; top: 0; bottom: 0; background: rgb(255 255 255 / 0.4); border-radius: 2px; }
  .played { position: absolute; left: 0; top: 0; bottom: 0; background: #ff2d2d; border-radius: 2px; }
  .knob { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #ff2d2d; transform: scale(0); transition: transform 0.12s; }
  .track:hover .knob, .track:focus .knob { transform: scale(1); }
  .track:focus .knob { transform: scale(1.35); box-shadow: 0 0 0 4px rgb(255 255 255 / 0.35); }
  .tip { position: absolute; bottom: 1.4rem; transform: translateX(-50%); padding: 0.15rem 0.45rem; border-radius: 4px; background: rgb(20 20 20 / 0.9); font-size: 0.78rem; color: #fff; pointer-events: none; white-space: nowrap; }
  .row { display: flex; align-items: center; gap: 0.3rem; margin-top: 0.25rem; color: #fff; }
  .row button { color: #fff; }
  .row small { font-size: 0.55em; margin-left: -0.1em; }
  .time { font-size: 0.85rem; margin-left: 0.4rem; }
  .grow { flex: 1; }
  .flash { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 5; display: flex; align-items: center; gap: 0.6rem; padding: 0.8rem 1.4rem; border-radius: 99px; background: rgb(0 0 0 / 0.6); color: #fff; font-size: 1.4rem; font-weight: 600; pointer-events: none; animation: flash 0.8s ease-out forwards; }
  .flash.back { left: 30%; }
  .flash:not(.back) { left: 70%; }
  @keyframes flash { 0% { opacity: 0; } 12% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }
  .bigplay { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 3; width: 4.5rem; height: 4.5rem; border-radius: 50%; display: grid; place-items: center; font-size: 2.2rem; color: #fff; background: rgb(0 0 0 / 0.5); pointer-events: none; }
</style>
