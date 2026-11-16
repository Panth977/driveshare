<script lang="ts">
  // The viewer: every file of a folder, one by one. Arrow keys (or the remote) step through;
  // Delete bins the one on screen (with Undo); C comments; S makes a share link; I shows details.
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { formatBytes } from '@driveshare/backend/shared';
  import { mydrive } from '../lib/mydrive.svelte.ts';
  import { sizes } from '../lib/sizes.svelte.ts';
  import { nav } from '../lib/router.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { activity } from '../lib/activity.svelte.ts';
  import { editable, isBack, tv } from '../lib/tv.svelte.ts';
  import { turnCss, turnOf, warmVideo, ago, bytesOf, driveLink, duration, failText, isAudio, isFolder, isImage, isMedia, isPdf, isVideo, kindOf, originalUrl, sortTv, thumb, type DComment, type DFile } from '../lib/gdrive.ts';
  import { children as cacheChildren, folderMeta, noteUpdate, peek } from '../lib/listcache.ts';
  import { follow, sendToTv } from '../lib/remote.svelte.ts';
  import { profiles } from '../lib/profiles.svelte.ts';
  import { rotateBlob } from '../lib/rotate.ts';
  import { namesIn } from '../lib/people.ts';
  import { noteFolder } from '../lib/recent.ts';
  import { sendFile } from '../lib/upload.ts';
  import FileIcon from '../components/drive/FileIcon.svelte';
  import ShareDialog from '../components/drive/ShareDialog.svelte';
  import TopBar from '../components/TopBar.svelte';
  import Toast from '../components/Toast.svelte';
  import Saving from '../components/Saving.svelte';
  import VideoBar from '../components/VideoBar.svelte';

  let { folderId, fileId }: { folderId: string; fileId: string } = $props();

  const VIRTUAL: Record<string, string> = { recent: 'Recent photos and videos', starred: 'Starred' };
  let all = $state<DFile[] | null>(null);
  let folder = $state<DFile | null>(null);
  let loadError = $state('');
  let index = $state(0);
  let onlyMedia = $state(localStorage.getItem('ds.v.media') !== '0');
  // ?deep=1 (the TV's "with subfolders"): every file below the folder, folder by folder.
  let deep = $state(new URLSearchParams(location.search).get('deep') === '1');
  let panel = $state<'' | 'info' | 'comments'>('');
  let chrome = $state(true);
  let sharing = $state<DFile | null>(null);
  let comments = $state<DComment[] | null>(null);
  let draft = $state('');
  let full = $state<Record<string, string>>({});
  let commentBox = $state<HTMLTextAreaElement | null>(null);
  let stageEl = $state<HTMLElement | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let vbar = $state<VideoBar | null>(null);
  let recents = $state<{ id: string; name: string }[]>(JSON.parse(localStorage.getItem('ds.v.recent') ?? '[]'));

  $effect(() => { void mydrive.start(); });
  const drive = $derived(mydrive.drive);

  const list = $derived(all ? (onlyMedia && all.some(isMedia) ? all.filter(isMedia) : all) : null);
  const cur = $derived(list?.[Math.min(index, (list?.length ?? 1) - 1)]);
  // A video starts loading (and playing) only once you stay on it for a second, so stepping past
  // videos with the arrows does not download each one. OK or a click starts it at once.
  let videoGo = $state(false);
  // (Only the id: starring or renaming the video must not reload it.)
  const videoId = $derived(cur && isVideo(cur) ? cur.id : '');
  // Its first and last bytes are fetched during that second (media-sw.js).
  const curId = $derived(cur?.id ?? '');
  // Who is in it (named on the Mac's photo job; see lib/people.ts).
  let names = $state<string[]>([]);
  $effect(() => {
    const c = untrack(() => cur), d = drive;
    names = [];
    if (!curId || !c || !d || !c.appProperties?.dsFaces) return;
    void namesIn(d, c).then((n) => { if (cur?.id === c.id) names = n; });
  });
  $effect(() => {
    if (!curId) return;
    const c = untrack(() => cur);
    if (c && isVideo(c)) warmVideo(c);
  });
  $effect(() => {
    const id = videoId;
    videoGo = false;
    if (!id) return;
    if (vids.has(id)) { videoGo = true; return; } // seen just now: carry on at once
    const t = setTimeout(() => (videoGo = true), 1000);
    return () => clearTimeout(t);
  });

  async function collect(id: string): Promise<DFile[]> {
    const d = drive!;
    if (id === 'recent') return d.query(`(mimeType contains 'image/' or mimeType contains 'video/') and trashed = false`, { orderBy: 'modifiedTime desc', max: 500 });
    if (id === 'starred') return (await d.query('starred = true and trashed = false')).filter((f) => !isFolder(f));
    if (!deep) return (await cacheChildren(d, id, (l) => { if (folderId === id && !deep) { const keep = cur?.id ?? fileId; const files = l.filter((f) => !isFolder(f)); all = tv.on ? sortTv(files) : files; const k = list?.findIndex((f) => f.id === keep) ?? -1; if (k >= 0) index = k; } }, { orderBy: 'name_natural' })).filter((f) => !isFolder(f));
    // Subfolders too: listed a level at a time (6 folders at once, cached listings), then put in
    // folder order: a folder's own files by name, then each subfolder's, depth first. Up to 20,000.
    const kidsOf = new Map<string, DFile[]>();
    let level = [id];
    let count = 0;
    while (level.length && count < 20000) {
      const next: string[] = [];
      let k = 0;
      await Promise.all(Array.from({ length: Math.min(6, level.length) }, async () => {
        while (k < level.length) {
          const fid = level[k++]!;
          const l = await cacheChildren(d, fid, () => {}, { orderBy: 'name_natural' });
          kidsOf.set(fid, sortTv(l));
          for (const f of l) { if (isFolder(f)) next.push(f.id); else count++; }
        }
      }));
      level = next;
    }
    const out: DFile[] = [];
    const walk = (fid: string, seen: Set<string>) => {
      if (seen.has(fid)) return;
      seen.add(fid);
      const l = kidsOf.get(fid) ?? [];
      for (const f of l) if (!isFolder(f)) out.push(f);
      for (const f of l) if (isFolder(f)) walk(f.id, seen);
    };
    walk(id, new Set());
    return out;
  }

  async function load() {
    if (!drive || !folderId) return;
    loadError = '';
    // Seen lately (this page): draw at once from memory, then settle with the full answer.
    const quick = !deep && !VIRTUAL[folderId] ? peek(folderId, { orderBy: 'name_natural' }) : undefined;
    const known = folderMeta.get(folderId);
    let drawn = false;
    if (quick && known) {
      folder = known;
      const files = quick.filter((f) => !isFolder(f));
      all = tv.on ? sortTv(files) : files;
      if (fileId && !files.some((f) => f.id === fileId && (!onlyMedia || isMedia(f))) && files.some((f) => f.id === fileId)) onlyMedia = false;
      index = Math.max(0, list?.findIndex((f) => f.id === fileId) ?? 0);
      drawn = true;
    } else all = null;
    try {
      folder = VIRTUAL[folderId] ? { id: folderId, name: VIRTUAL[folderId]!, mimeType: 'virtual' } : (known ?? (await drive.get(folderId)));
      if (!VIRTUAL[folderId]) folderMeta.set(folderId, folder);
      // On the TV the viewer steps through files in the same order as the TV grid.
      const files = tv.on && !deep ? sortTv(await collect(folderId)) : await collect(folderId);
      // Already showing (from memory): keep the file on screen, wherever it is in the fresh list.
      const keep = drawn ? (cur?.id ?? fileId) : fileId;
      all = files;
      const wanted = keep ? (onlyMedia && files.some(isMedia) ? files.filter(isMedia) : files).findIndex((f) => f.id === keep) : -1;
      if (keep && wanted < 0 && onlyMedia) { onlyMedia = false; }
      await tick();
      index = Math.max(0, list?.findIndex((f) => f.id === keep) ?? 0);
      if (folder && !VIRTUAL[folderId]) {
        recents = [{ id: folder.id, name: folder.id === mydrive.rootId ? 'My Drive' : folder.name }, ...recents.filter((r) => r.id !== folder!.id)].slice(0, 8);
        localStorage.setItem('ds.v.recent', JSON.stringify(recents));
        noteFolder(recents[0]!, list?.[index], deep);
      }
    } catch (e) { loadError = failText(e); }
  }
  $effect(() => { void folderId; void deep; if (drive) untrack(() => void load()); });
  $effect(() => { localStorage.setItem('ds.v.media', onlyMedia ? '1' : '0'); });

  // A new file id in the address (sent from a phone to this TV, same folder): jump to it.
  // The file named in the address (opened, or sent from a phone to this TV): show it as soon as the
  // list has it, also when it only appears in a fresher listing. Stepping on keeps `shown` as is.
  let shown = '';
  $effect(() => {
    const id = fileId;
    const l = list;
    if (!id || !l || id === shown) return;
    const k = l.findIndex((f) => f.id === id);
    if (k >= 0) { shown = id; index = k; }
  });

  // Follow mode (phone/laptop): the TV shows what this viewer shows.
  let sentId = '';
  $effect(() => {
    const c = cur;
    if (!follow.on || !c || !folderId || c.id === sentId) return;
    const t = setTimeout(() => {
      sentId = c.id;
      sendToTv({ kind: 'file', folderId, fileId: c.id, name: c.name }).catch((e) => toast.show(failText(e)));
    }, 250);
    return () => clearTimeout(t);
  });
  function toggleFollow() {
    follow.toggle();
    sentId = '';
    toast.show(follow.on ? 'The TV now follows this screen' : 'Stopped showing on the TV', undefined, 2500);
  }

  // Keep the URL on the file you are looking at (replace, so Back leaves the viewer), and remember it
  // for Recent (folders you looked through, carrying on from this file).
  $effect(() => {
    const c = cur, fo = folder;
    if (c && fo && folderId && !VIRTUAL[folderId] && fo.id === folderId) {
      const t = setTimeout(() => noteFolder({ id: fo.id, name: fo.id === mydrive.rootId ? 'My Drive' : fo.name }, c, deep), 600);
      return () => clearTimeout(t);
    }
  });
  $effect(() => {
    const c = cur;
    if (c && folderId && c.id !== fileId) history.replaceState(null, '', `/view/${folderId}/${c.id}`);
  });

  // Comments of the file on screen, when the panel is open.
  $effect(() => {
    const c = cur;
    comments = null;
    if (!c || panel !== 'comments' || !drive) return;
    drive.comments(c.id).then((l) => { if (cur?.id === c.id) comments = l; }, (e) => toast.show(failText(e)));
  });

  // Images: a big thumbnail first (fast), then the original file itself (the whole picture at full
  // quality) when the browser can show it and it is not huge. PDFs load as the original too.
  const SHOWABLE = /^image\/(jpeg|png|gif|webp|avif|bmp|svg\+xml)$/;
  const ORIGINAL_MAX = 40 * 1024 * 1024;
  $effect(() => {
    const c = cur;
    if (!c || !drive) return;
    // On a TV a screen-sized picture is all it can show: originals only when there is no thumbnail.
    const original = isPdf(c) || (isImage(c) && (!c.thumbnailLink || (!tv.on && SHOWABLE.test(c.mimeType) && bytesOf(c) <= ORIGINAL_MAX)));
    if (original && !full[c.id]) {
      drive.mediaUrl(c).then((u) => {
        // Keep the last few originals in memory; free the rest.
        const keys = Object.keys(full);
        const next = { ...full, [c.id]: u };
        for (const k of keys.slice(0, Math.max(0, keys.length - 12))) { if (next[k]!.startsWith('blob:')) URL.revokeObjectURL(next[k]!); delete next[k]; }
        full = next;
      }, () => {});
    }
    // Warm the next two pictures (and the next original, which the media worker then keeps).
    for (const n of [index, index + 1, index - 1, index + 2, index - 2, index + 3]) {
      const f = list?.[n];
      const src = f && (isImage(f) || isVideo(f)) ? thumb(f, px(f)) : undefined;
      if (src) warmPic(src);
    }
    const nx = list?.[index + 1];
    if (!tv.on && nx && navigator.serviceWorker?.controller && isImage(nx) && SHOWABLE.test(nx.mimeType) && bytesOf(nx) <= 25 * 1024 * 1024) new Image().src = originalUrl(nx);
  });

  // Pictures around the one on screen, loaded and decoded ahead and kept (the last 16), so stepping
  // back and forth swaps instantly instead of loading again.
  const pics = new Map<string, HTMLImageElement>();
  let ready = $state<Record<string, true>>({});
  function warmPic(src: string) {
    const had = pics.get(src);
    if (had) { pics.delete(src); pics.set(src, had); return; }
    const im = new Image();
    im.referrerPolicy = 'no-referrer';
    im.src = src;
    pics.set(src, im);
    im.decode().then(() => { if (pics.has(src)) ready = { ...ready, [src]: true }; }, () => {});
    while (pics.size > 16) {
      const k = pics.keys().next().value!;
      pics.delete(k);
      if (ready[k]) { const { [k]: _, ...rest } = ready; ready = rest; }
    }
  }

  // Videos: the last three players stay alive (paused, with what they loaded), so going back to a
  // video carries on at once from where it was.
  const vids = new Map<string, HTMLVideoElement>();
  /** Videos this browser cannot play (MPEG-2 .mpg, camcorder .m2t, old .avi…). */
  let cannot = $state<Record<string, true>>({});
  function videoFor(f: DFile): HTMLVideoElement {
    const had = vids.get(f.id);
    if (had) { vids.delete(f.id); vids.set(f.id, had); return had; }
    const v = document.createElement('video');
    v.src = mydrive.drive!.streamUrl(f);
    const poster = thumb(f, px(f));
    if (poster) v.poster = poster;
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('click', (e) => { e.stopPropagation(); vbar?.toggle(); });
    v.addEventListener('error', () => { if (v.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || v.error?.code === MediaError.MEDIA_ERR_DECODE) cannot = { ...cannot, [f.id]: true }; });
    vids.set(f.id, v);
    while (vids.size > 3) {
      const [k, old] = vids.entries().next().value!;
      vids.delete(k);
      old.pause();
      old.removeAttribute('src');
      old.load();
    }
    return v;
  }
  function hostVideo(node: HTMLElement, f: DFile) {
    const v = videoFor(f);
    node.appendChild(v);
    videoEl = v;
    void v.play().catch(() => {});
    return { destroy() { v.pause(); v.remove(); if (videoEl === v) videoEl = null; } };
  }

  /** Thumbnail size: the screen's long edge, never bigger than the picture itself (no blurry upscaling). */
  const px = (f?: DFile) => {
    const screen = Math.min(tv.on ? 1920 : 2560, Math.round(Math.max(innerWidth, innerHeight) * Math.min(2, devicePixelRatio || 1)));
    const m = f?.imageMediaMetadata ?? f?.videoMediaMetadata;
    const own = m?.width && m?.height ? Math.max(m.width, m.height) : 0;
    return own ? Math.min(screen, own) : screen;
  };

  function go(i: number, quiet = false) {
    if (!list?.length) return;
    index = Math.max(0, Math.min(list.length - 1, i));
    if (quiet) flash(); else wake();
  }

  // TV: stepping keeps the picture full screen; a small caption floats over it for a moment.
  let caption = $state(false);
  let captionTimer: ReturnType<typeof setTimeout> | null = null;
  function flash() {
    caption = true;
    if (captionTimer) clearTimeout(captionTimer);
    captionTimer = setTimeout(() => (caption = false), 2200);
  }

  const say = (t: string) => toast.show(t);

  // Bin, star and comment change the screen at once and save in the background (lib/activity), so
  // the buttons never wait: go to the next photo, bin it too, rotate another while those save.
  async function binCurrent() {
    const f = cur;
    if (!f || !drive || !all) return;
    if (!(await profiles.allow('bin', say))) return;
    const at = all.findIndex((x) => x.id === f.id);
    const putBack = () => {
      if (!all || all.some((x) => x.id === f.id)) return;
      const pos = Math.min(Math.max(at, 0), all.length);
      all = [...all.slice(0, pos), { ...f }, ...all.slice(pos)];
    };
    all = all.filter((x) => x.id !== f.id);
    if (index >= (list?.length ?? 0)) index = Math.max(0, (list?.length ?? 1) - 1);
    const saved = activity.run(`Bin ${f.name}`, async () => { await drive!.update(f.id, { trashed: true }); sizes.local({ id: f.id, removed: true }); }, putBack);
    // On a TV, Undo gets the focus: OK undoes, the arrows just carry on.
    if (tv.on) setTimeout(() => document.querySelector<HTMLElement>('.toast button.primary')?.focus(), 50);
    toast.show(tv.on ? `Binned ${f.name} · OK to undo` : `Binned ${f.name}`, { label: 'Undo', run: () => {
      putBack();
      index = list?.findIndex((x) => x.id === f.id) ?? index;
      void activity.run(`Undo bin ${f.name}`, async () => {
        if (!(await saved)) return; // the bin never happened
        sizes.local(await drive!.update(f.id, { trashed: false }));
      }, () => { all = all?.filter((x) => x.id !== f.id) ?? null; });
    } });
  }

  function star() {
    const f = cur;
    if (!f || !drive) return;
    void profiles.allow('edit', say).then((ok) => {
      if (!ok || !all) return;
      const to = !(all.find((x) => x.id === f.id)?.starred ?? f.starred);
      const set = (v: boolean) => { if (all) all = all.map((x) => (x.id === f.id ? { ...x, starred: v } : x)); };
      set(to);
      toast.show(to ? 'Starred' : 'Star removed', undefined, 1500);
      void activity.run(to ? 'Star' : 'Remove star', () => drive!.update(f.id, { starred: to }), () => set(!to));
    });
  }

  async function post(e?: SubmitEvent) {
    e?.preventDefault();
    const f = cur;
    const text = draft.trim();
    if (!f || !drive || !text) return;
    if (!(await profiles.allow('comment', say))) return;
    // Shown at once (as "sending"), swapped for Drive's copy when it lands.
    const temp = { id: `tmp-${crypto.randomUUID()}`, content: text, createdTime: new Date().toISOString(), author: { displayName: 'You', me: true } } satisfies DComment;
    const forFile = f.id;
    comments = [...(comments ?? []), temp];
    draft = '';
    void activity.run('Comment', async () => {
      const c = await drive!.addComment(forFile, text);
      if (cur?.id === forFile) comments = (comments ?? []).map((x) => (x.id === temp.id ? c : x));
    }, () => {
      if (cur?.id === forFile) { comments = (comments ?? []).filter((x) => x.id !== temp.id); if (!draft) draft = text; }
    });
  }

  async function share() {
    if (cur && (await profiles.allow('share', say))) sharing = cur;
  }

  // ── rotate: ↻ turns the picture 90° (shown at once); a moment after the last turn it is saved to
  // Drive as a new version of the same file (JPEG: lossless, only the orientation tag changes).
  // Never blocks: keep turning (this picture or the next) while saves run; each picture saves in
  // order, different pictures in parallel.
  let turns = $state<Record<string, number>>({});
  const rotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const rotFiles = new Map<string, DFile>();
  const rotChain = new Map<string, Promise<unknown>>();
  /** The picture as last saved here, so the next save does not download it again. */
  const lastSaved = new Map<string, Blob>();
  const ROTATABLE = /^image\/(jpeg|jpg|png|webp)$/;
  async function rotate() {
    const f = cur;
    if (!f || !drive || !isImage(f)) return;
    if (!ROTATABLE.test(f.mimeType)) { say('Only JPEG, PNG and WebP pictures can be rotated here.'); return; }
    if (!turns[f.id] && !rotChain.has(f.id) && !(await profiles.allow('edit', say))) return;
    turns = { ...turns, [f.id]: ((turns[f.id] ?? 0) + 1) % 4 };
    clearTimeout(rotTimers.get(f.id));
    rotFiles.set(f.id, f);
    rotTimers.set(f.id, setTimeout(() => { rotTimers.delete(f.id); queueRotation(f); }, 1300));
  }
  function queueRotation(f: DFile) {
    const prev = rotChain.get(f.id) ?? Promise.resolve();
    const next = prev.then(() => saveRotation(f));
    rotChain.set(f.id, next);
    void next.finally(() => { if (rotChain.get(f.id) === next) rotChain.delete(f.id); });
  }
  function saveRotation(f: DFile): Promise<unknown> {
    const t = turns[f.id] ?? 0;
    if (!t || !drive) return Promise.resolve();
    let out: Blob | null = null;
    return activity.run(`Rotate ${f.name}`, async () => {
      const had = lastSaved.get(f.id);
      // A dsTurn label (turned by the photo job, file untouched) goes into the file with these turns.
      const base = had ? 0 : turnOf(all?.find((x) => x.id === f.id) ?? f);
      const src = had ?? (await drive!.download(f));
      out = await rotateBlob(src, f.mimeType, (t + base) % 4);
      const meta = { name: f.name, parents: f.parents ?? [], mimeType: f.mimeType };
      let saved: Partial<DFile> = {};
      if (out.size <= 5 * 1024 * 1024) saved = await drive!.uploadSmall(meta, out, f.id);
      else { const url = await drive!.startUpload(meta, out.size, f.id); await sendFile(url, out, () => {}); saved = await drive!.get(f.id); }
      if (base) saved = { ...saved, appProperties: (await drive!.update(f.id, { appProperties: { dsTurn: null } })).appProperties ?? {} };
      lastSaved.set(f.id, out);
      const old = full[f.id];
      if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
      full = { ...full, [f.id]: URL.createObjectURL(out) };
      // The picture now shows those t turns itself; keep any turns made while it was saving.
      turns = { ...turns, [f.id]: (((turns[f.id] ?? 0) - t) % 4 + 4) % 4 };
      if (all) all = all.map((x) => (x.id === f.id ? { ...x, ...saved, size: String(out!.size) } : x));
      noteUpdate({ ...f, ...saved }, { ...saved, size: String(out!.size) });
    }, () => {
      turns = { ...turns, [f.id]: (((turns[f.id] ?? 0) - t) % 4 + 4) % 4 };
    }).then((ok) => {
      if (ok) toast.show(`Rotated ${f.name}, saved in Drive`, undefined, 2000);
      // More turns made while this one saved: save those too (unless a timer is still running).
      if ((turns[f.id] ?? 0) && !rotTimers.has(f.id)) return saveRotation(f);
    });
  }

  // ── zoom: + / − (or the toolbar), the mouse wheel, double-click; drag (or the arrows) to look
  // around; 0 or Back goes back to the whole picture. Zooming in loads the full-size original.
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let stageW = $state(0);
  let stageH = $state(0);
  const clampPan = () => {
    const mx = ((zoom - 1) * stageW) / 2, my = ((zoom - 1) * stageH) / 2;
    panX = Math.max(-mx, Math.min(mx, panX));
    panY = Math.max(-my, Math.min(my, panY));
  };
  function zoomBy(f: number) {
    zoom = Math.max(1, Math.min(6, Math.round(zoom * f * 100) / 100));
    if (zoom === 1) { panX = 0; panY = 0; } else clampPan();
  }
  function resetZoom() { zoom = 1; panX = 0; panY = 0; }
  function pan(dx: number, dy: number) { panX -= dx * stageW * 0.2; panY -= dy * stageH * 0.2; clampPan(); }
  $effect(() => { void cur?.id; resetZoom(); });
  $effect(() => {
    const c = cur;
    if (zoom > 1 && c && drive && isImage(c) && /^image\/(jpeg|png|gif|webp|avif)$/.test(c.mimeType) && !full[c.id]) {
      drive.mediaUrl(c).then((u) => (full = { ...full, [c.id]: u }), () => {});
    }
  });
  let drag: { x: number; y: number; px: number; py: number } | null = null;
  function picStyle(f: DFile): string {
    const t = (turnOf(f) + (turns[f.id] ?? 0)) % 4;
    const tf = `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${t * 90}deg)`;
    // A quarter turn: lay the picture out in a box with width and height swapped, then turn it.
    const box = t % 2 && stageW && stageH ? `width:${stageH}px;height:${stageW}px;left:${(stageW - stageH) / 2}px;top:${(stageH - stageW) / 2}px;right:auto;bottom:auto;` : '';
    return `${box}transform:${tf};${drag ? '' : 'transition:transform .18s ease;'}`;
  }

  async function openComments() {
    panel = 'comments';
    await tick();
    commentBox?.focus();
  }

  function back() {
    if (zoom > 1) { resetZoom(); return; }
    if (panel) { panel = ''; return; }
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    if (VIRTUAL[folderId]) nav('/view');
    else nav(folderId === mydrive.rootId ? '/drive' : `/drive/${folderId}`);
  }

  /**
   * The remote on a TV. On the picture: ← → step, ↑ opens the toolbar, ↓ shows or hides the bars,
   * OK plays/pauses a video. In the toolbar: ← → move between its buttons, ↓ or Back goes back to
   * the picture. Returns true when it handled the key.
   */
  let topEl = $state<HTMLElement | null>(null);
  let topH = $state(0);
  let stripH = $state(0);
  const toolbar = () => [...(topEl?.querySelectorAll<HTMLElement>('button:not([disabled]), a') ?? [])].filter((b) => b.offsetParent);
  // The toolbar button the remote was on last: ↑ comes back to it (Rotate, ↓, ↑ → Rotate again).
  let lastBar = '';
  const barKey = (b: HTMLElement) => b.getAttribute('aria-label') ?? b.getAttribute('title') ?? b.textContent?.trim() ?? '';
  function toPicture() {
    const a = document.activeElement as HTMLElement | null;
    if (a && topEl?.contains(a)) lastBar = barKey(a);
    a?.blur?.();
    wake();
  }
  function tvKey(e: KeyboardEvent): boolean {
    const a = document.activeElement as HTMLElement | null;
    // Details/comments panel: its own focus moves (page-wide arrow navigation), nothing else here.
    if (panel && a?.closest('.panel')) return e.key.startsWith('Arrow');
    const inBar = !!(a && topEl?.contains(a));
    const stop = () => { e.preventDefault(); e.stopPropagation(); return true; };
    // The video's time bar: ← → jump back/forward, OK plays/pauses, ↑ ↓ or Back leave it.
    if (a?.closest('.vbar')) {
      wake();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { vbar?.seek(e.key === 'ArrowLeft' ? -1 : 1); return stop(); }
      if (e.key === 'Enter') { vbar?.toggle(); return stop(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || isBack(e)) { a.blur(); return stop(); }
    }
    if (inBar) {
      const bs = toolbar();
      const i = bs.indexOf(a!);
      wake();
      if (e.key === 'ArrowRight') { bs[Math.min(bs.length - 1, i + 1)]?.focus(); return stop(); }
      if (e.key === 'ArrowLeft') { bs[Math.max(0, i - 1)]?.focus(); return stop(); }
      if (e.key === 'ArrowDown' || isBack(e)) { toPicture(); return stop(); }
      if (e.key === 'ArrowUp') return stop();
      return false; // OK clicks the focused button
    }
    // The toast's Undo (focused right after binning on a TV): OK presses it.
    if (a?.closest('.toast') && e.key === 'Enter') return false;
    if (a && a !== document.body && !a.closest('.panel')) a.blur(); // nothing on the picture keeps focus
    switch (e.key) {
      case 'ArrowRight': if (zoom > 1) pan(1, 0); else go(index + 1, !chrome); return stop();
      case 'ArrowLeft': if (zoom > 1) pan(-1, 0); else go(index - 1, !chrome); return stop();
      case 'ArrowUp': {
        if (zoom > 1) { pan(0, -1); return stop(); }
        wake();
        // Back on the button used last; else the first action (not Back, so a stray OK does not
        // leave the viewer).
        const bs = toolbar();
        const last = lastBar ? bs.find((b) => barKey(b) === lastBar) : undefined;
        (last ?? bs.find((b) => b.closest('.acts')) ?? bs[0])?.focus();
        return stop();
      }
      case 'ArrowDown':
        if (zoom > 1) pan(0, 1);
        else if (videoEl && vbar) { wake(); vbar.focus(); } // ↓ on a video: its time bar, to seek
        else { chrome = !chrome; if (chrome) wake(); }
        return stop();
      case 'Enter':
        if (videoId && !videoGo) { videoGo = true; wake(); }
        else if (videoEl) { videoEl.paused ? void videoEl.play() : videoEl.pause(); wake(); }
        else { chrome = !chrome; if (chrome) wake(); }
        return stop();
    }
    return false;
  }

  function key(e: KeyboardEvent) {
    if (!folderId || sharing) return;
    if (editable(e.target)) {
      if (e.key === 'Escape') { (e.target as HTMLElement).blur(); e.preventDefault(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) { if (e.key === 'Backspace' && e.metaKey) { e.preventDefault(); void binCurrent(); } return; }
    if (tv.on && tvKey(e)) return;
    // OK/Enter/Space on a focused button is that button's click (Bin, Share…), not a viewer key.
    const a = document.activeElement as HTMLElement | null;
    if ((e.key === 'Enter' || e.key === ' ') && a && a !== document.body && a.matches('button, a, [role="button"], input, select, summary')) return;
    let handled = true;
    if (a?.closest('.vbar')) return; // the time bar has its own keys (← → seek)
    if (videoEl && vbar && (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) { vbar.seek(e.key === 'ArrowLeft' ? -1 : 1); e.preventDefault(); return; }
    switch (e.key) {
      case 'j': case 'J': case 'MediaRewind': if (vbar && videoEl) vbar.seek(-1); else handled = false; break;
      case 'l': case 'L': case 'MediaFastForward': if (vbar && videoEl) vbar.seek(1); else handled = false; break;
      case 'ArrowRight': if (zoom > 1) pan(1, 0); else go(index + 1); break;
      case 'ArrowLeft': if (zoom > 1) pan(-1, 0); else go(index - 1); break;
      case 'PageDown': case 'MediaTrackNext': go(index + 1); break;
      case 'PageUp': case 'MediaTrackPrevious': go(index - 1); break;
      case '+': case '=': zoomBy(1.5); break;
      case '-': case '_': zoomBy(1 / 1.5); break;
      case '0': resetZoom(); break;
      case 'r': case 'R': void rotate(); break;
      case 'Home': go(0); break;
      case 'End': go((list?.length ?? 1) - 1); break;
      case 'Delete': case 'd': case 'D': case 'ColorF0Red': void binCurrent(); break;
      case 'c': case 'C': void openComments(); break;
      case 'i': case 'I': panel = panel === 'info' ? '' : 'info'; break;
      case 's': case 'S': void share(); break;
      case '*': case 'ColorF2Yellow': void star(); break;
      case 'f': case 'F': void toggleFull(); break;
      case ' ': case 'MediaPlayPause': case 'Enter':
        if (videoId && !videoGo) videoGo = true;
        else if (videoEl) { videoEl.paused ? void videoEl.play() : videoEl.pause(); }
        else if (e.key === 'Enter') { chrome = !chrome; }
        else go(index + 1);
        break;
      case 'ArrowUp': case 'ArrowDown':
        wake();
        if (zoom > 1 && !videoEl) { pan(0, e.key === 'ArrowUp' ? -1 : 1); break; }
        if (videoEl && e.key === 'ArrowUp') videoEl.volume = Math.min(1, videoEl.volume + 0.1);
        else if (videoEl) videoEl.volume = Math.max(0, videoEl.volume - 0.1);
        break;
      default:
        if (isBack(e)) back(); else handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  async function toggleFull() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stageEl?.closest('.viewer')?.requestFullscreen().catch(() => {});
  }

  // The toolbar fades away while you watch, and comes back on any movement or key.
  let idle: ReturnType<typeof setTimeout> | null = null;
  function wake() {
    chrome = true;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { if (!panel && !sharing) chrome = false; }, tv.on ? 4500 : 3000);
  }
  onMount(() => {
    wake();
    // Capture phase: the viewer reads the remote before the page-wide arrow-key navigation does.
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  });
  onDestroy(() => {
    for (const v of vids.values()) { v.pause(); v.removeAttribute('src'); v.load(); }
    vids.clear();
    // Back in the folder, the file you left on is the one in focus (TV grid) / selected (My Drive).
    const c = cur;
    if (c && folderId && folderId !== 'recent') {
      const place = folderId === mydrive.rootId ? 'root' : folderId;
      sessionStorage.setItem(`ds.tvfocus.${place}`, c.id);
      sessionStorage.setItem(`ds.sel.${folderId}`, c.id);
      // Seen with subfolders: also its own folder, for when you go there.
      const p = c.parents?.[0];
      if (p && p !== folderId) { sessionStorage.setItem(`ds.tvfocus.${p === mydrive.rootId ? 'root' : p}`, c.id); sessionStorage.setItem(`ds.sel.${p}`, c.id); }
    }
    // Leaving with turns not yet saved: save them now (they run in the background).
    for (const [id, t] of rotTimers) { clearTimeout(t); rotTimers.delete(id); const f = rotFiles.get(id); if (f) queueRotation(f); }
    if (idle) clearTimeout(idle); for (const u of Object.values(full)) if (u.startsWith('blob:')) URL.revokeObjectURL(u); });

  // Swipe on phones and touch screens.
  let touchX = 0;
  const strip = $derived.by(() => {
    if (!list) return [];
    const span = tv.on ? 12 : 30;
    const from = Math.max(0, index - span), to = Math.min(list.length, index + span + 1);
    return list.slice(from, to).map((f, k) => ({ f, i: from + k }));
  });
  $effect(() => {
    void index;
    queueMicrotask(() => document.querySelector('.strip .on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }));
  });
</script>

<svelte:window onmousemove={wake} />

{#if !folderId}
  <TopBar tabs />
  <main class="wrap stack" style="gap:1.4rem">
    <div>
      <h1>Viewer</h1>
      <p class="muted" style="margin:0.3rem 0 0">Look through a folder one file at a time. <span class="kbd">←</span> <span class="kbd">→</span> to move, <span class="kbd">Del</span> to bin, <span class="kbd">C</span> to comment, <span class="kbd">S</span> to share.</p>
    </div>
    <div class="picks">
      <button class="pick hero" onclick={() => nav('/view/recent')}>
        <span class="pi">✦</span><b>Recent photos and videos</b><span class="small muted">The latest 500 across your Drive</span>
      </button>
      <button class="pick" onclick={() => nav('/view/starred')}><span class="pi">★</span><b>Starred</b><span class="small muted">Everything you starred</span></button>
      <button class="pick" onclick={() => nav('/drive')}><span class="pi">⌘</span><b>Pick a folder</b><span class="small muted">In My Drive: right-click › Preview all</span></button>
    </div>
    {#if recents.length}
      <section class="stack" style="gap:0.6rem">
        <h3>Recently viewed folders</h3>
        <div class="picks">
          {#each recents as r (r.id)}
            <button class="pick slim" onclick={() => nav(`/view/${r.id}`)}><FileIcon file={{ mimeType: 'application/vnd.google-apps.folder', name: '' }} size={1.6} /><b class="ellipsis">{r.name}</b>{#if sizes.of(r.id)}<span class="tiny muted num">{formatBytes(sizes.of(r.id)!.bytes)} · {sizes.of(r.id)!.files.toLocaleString()} files</span>{/if}</button>
          {/each}
        </div>
      </section>
    {/if}
  </main>
{:else}
  <div class="viewer" class:hide={!chrome} class:withpanel={!!panel} style:--top="{chrome ? topH : 0}px" style:--bottom="{chrome && list && list.length > 1 ? stripH : 0}px">
    <header class="top" data-chrome bind:this={topEl} bind:clientHeight={topH}>
      <button class="ghost" onclick={back} aria-label="Back">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 18l-6-6 6-6"/></svg>{folder?.id === mydrive.rootId ? 'My Drive' : (folder?.name ?? '')}
      </button>
      <div class="ttl">
        <div class="ellipsis nm">{cur?.name ?? ''}{#if cur?.starred} <span class="star">★</span>{/if}</div>
        {#if list}<div class="tiny muted num">{list.length ? index + 1 : 0} of {list.length}{cur ? ` · ${kindOf(cur)} · ${formatBytes(bytesOf(cur))}` : ''}{names.length ? ` · ${names.join(', ')}` : ''}</div>{/if}
      </div>
      <div class="acts">
        <label class="tog small"><input type="checkbox" bind:checked={onlyMedia} /> Photos & videos only</label>
        {#if !VIRTUAL[folderId]}<label class="tog small"><input type="checkbox" bind:checked={deep} /> Subfolders</label>{/if}
        {#if tv.on && !VIRTUAL[folderId]}<button class="ghost" class:live={deep} aria-pressed={deep} title="Include files in subfolders" onclick={() => (deep = !deep)}>Subfolders</button>{/if}
        {#if cur && isImage(cur)}
          <button class="ghost icon" title="Zoom out (−)" aria-label="Zoom out" disabled={zoom <= 1} onclick={() => zoomBy(1 / 1.5)}>−</button>
          <button class="ghost icon" title="Zoom in (+)" aria-label="Zoom in" onclick={() => zoomBy(1.5)}>+</button>
          {#if profiles.can('edit')}<button class="ghost icon" title="Rotate (R), saved to Drive" aria-label="Rotate" onclick={rotate}>↻</button>{/if}
        {/if}
        {#if profiles.can('edit')}<button class="ghost icon" title="Star (*)" aria-label="Star" onclick={star}>{cur?.starred ? '★' : '☆'}</button>{/if}
        <button class="ghost" title="Comment (C)" onclick={openComments}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/></svg>Comment</button>
        {#if !tv.on}<button class="ghost" class:live={follow.on} title="Show on the TV (it follows as you move)" aria-pressed={follow.on} onclick={toggleFollow}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>{follow.on ? 'On TV' : 'TV'}</button>{/if}
        {#if profiles.can('share')}<button class="ghost" title="Share link (S)" onclick={share}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>Share</button>{/if}
        <button class="ghost icon" title="Details (I)" aria-label="Details" onclick={() => (panel = panel === 'info' ? '' : 'info')}>ⓘ</button>
        {#if cur}<a class="btn ghost icon" title="Open in Google Drive" aria-label="Open in Google Drive" href={driveLink(cur)} target="_blank" rel="noopener">↗</a>{/if}
        {#if profiles.can('bin')}<button class="ghost danger" title="Move to bin (Del)" onclick={binCurrent}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>Bin</button>{/if}
      </div>
    </header>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="stage" bind:this={stageEl} bind:clientWidth={stageW} bind:clientHeight={stageH}
      onwheel={(e) => { if (!cur || !isImage(cur)) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15); }}
      ondblclick={() => { if (cur && isImage(cur)) { if (zoom > 1) resetZoom(); else zoomBy(2.5); } }}
      onpointerdown={(e) => { if (zoom > 1) { drag = { x: e.clientX, y: e.clientY, px: panX, py: panY }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } }}
      onpointermove={(e) => { if (drag) { panX = drag.px + e.clientX - drag.x; panY = drag.py + e.clientY - drag.y; clampPan(); } }}
      onpointerup={() => (drag = null)}
      ontouchstart={(e) => (touchX = e.touches[0]?.clientX ?? 0)}
      ontouchend={(e) => { const dx = (e.changedTouches[0]?.clientX ?? 0) - touchX; if (Math.abs(dx) > 50) go(index + (dx < 0 ? 1 : -1)); else wake(); }}>
      {#if loadError}
        <div class="msg"><p class="error">{loadError}</p></div>
      {:else if !list || !mydrive.drive}
        <div class="msg"><span class="spin"></span></div>
      {:else if !cur}
        <div class="msg"><p class="muted">Nothing to show here{onlyMedia ? ' (photos and videos only is on)' : ''}.</p></div>
      {:else}
        {#key cur.id}
          {#if isVideo(cur)}
            <!-- svelte-ignore a11y_media_has_caption -->
            {#if cannot[cur.id]}
              <div class="msg">
                {#if thumb(cur, px(cur))}<img class="pic small-pic" src={thumb(cur, px(cur))} alt="" referrerpolicy="no-referrer" />{/if}
                <p>This video's format ({cur.name.split('.').pop()?.toUpperCase()}) cannot play in a browser or on the TV. A playable MP4 copy is on its way (old videos are being converted).</p>
                <a class="btn" href={driveLink(cur)} target="_blank" rel="noopener" onclick={(e) => e.stopPropagation()}>Open in Google Drive</a>
              </div>
            {:else if videoGo}
              <div class="vhost" use:hostVideo={cur}></div>
              {#if videoEl}<VideoBar bind:this={vbar} video={videoEl} show={chrome} onwake={wake} />{/if}
            {:else}
              <!-- Passing by: only the picture; the video loads once you stay a second (or press OK). -->
              {#if thumb(cur, px(cur))}<img class="pic" class:ready={ready[thumb(cur, px(cur))!]} src={thumb(cur, px(cur))} alt={cur.name} referrerpolicy="no-referrer" decoding="async" draggable="false" />{/if}
              <button class="vwait" aria-label="Play" onclick={(e) => { e.stopPropagation(); videoGo = true; }}><svg viewBox="0 0 24 24" width="1em" height="1em"><path d="M8 5v14l11-7z" fill="currentColor" /></svg></button>
            {/if}
          {:else if isImage(cur)}
            <img class="pic" class:zoomed={zoom > 1} class:ready={ready[full[cur.id] ?? thumb(cur, px(cur)) ?? '']} src={full[cur.id] ?? thumb(cur, px(cur))} alt={cur.name} referrerpolicy="no-referrer" decoding="async" draggable="false" style={picStyle(cur)} />
          {:else if isAudio(cur)}
            <div class="msg"><FileIcon file={cur} size={6} /><audio src={mydrive.drive.streamUrl(cur)} controls autoplay onclick={(e) => e.stopPropagation()}></audio></div>
          {:else if isPdf(cur) && full[cur.id]}
            <iframe class="doc" src={full[cur.id]} title={cur.name}></iframe>
          {:else if cur.mimeType.startsWith('application/vnd.google-apps') || isPdf(cur) || cur.mimeType.startsWith('text/')}
            <iframe class="doc" src={`https://drive.google.com/file/d/${cur.id}/preview`} title={cur.name} allow="autoplay"></iframe>
          {:else}
            <div class="msg">
              {#if thumb(cur, 900)}<img class="pic small-pic" src={thumb(cur, 900)} alt="" referrerpolicy="no-referrer" />{:else}<FileIcon file={cur} size={7} />{/if}
              <p class="muted">{cur.name}</p>
              <a class="btn" href={driveLink(cur)} target="_blank" rel="noopener" onclick={(e) => e.stopPropagation()}>Open in Google Drive</a>
            </div>
          {/if}
        {/key}
        {#if index > 0}<button class="nav l" data-chrome tabindex={tv.on ? -1 : 0} aria-label="Previous" onclick={(e) => { e.stopPropagation(); go(index - 1); }}>‹</button>{/if}
        {#if index < list.length - 1}<button class="nav r" data-chrome tabindex={tv.on ? -1 : 0} aria-label="Next" onclick={(e) => { e.stopPropagation(); go(index + 1); }}>›</button>{/if}
      {/if}
    </div>

    {#if list && list.length > 1}
      <div class="strip" data-chrome data-nav-skip bind:clientHeight={stripH}>
        {#each strip as { f, i } (f.id)}
          <button class:on={i === index} tabindex="-1" onclick={() => go(i)} aria-label={f.name}>
            {#if thumb(f, 160)}<img src={thumb(f, 160)} style:transform={turnCss(f, 4.2 / 3.1)} alt="" loading="lazy" referrerpolicy="no-referrer" />{:else}<FileIcon file={f} size={1.6} />{/if}
            {#if isVideo(f)}<span class="pl">▶</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if panel && cur}
      <aside class="panel" data-chrome>
        <div class="row spread">
          <div class="seg">
            <button class:on={panel === 'info'} onclick={() => (panel = 'info')}>Details</button>
            <button class:on={panel === 'comments'} onclick={() => void openComments()}>Comments</button>
          </div>
          <button class="ghost icon" aria-label="Close" onclick={() => (panel = '')}>✕</button>
        </div>
        {#if panel === 'info'}
          <h3 class="pn">{cur.name}</h3>
          <dl>
            <dt>Kind</dt><dd>{kindOf(cur)}</dd>
            <dt>Size</dt><dd class="num">{formatBytes(bytesOf(cur))}</dd>
            {#if cur.imageMediaMetadata?.width}<dt>Pixels</dt><dd class="num">{cur.imageMediaMetadata.width} × {cur.imageMediaMetadata.height}</dd>{/if}
            {#if cur.imageMediaMetadata?.cameraModel}<dt>Camera</dt><dd>{cur.imageMediaMetadata.cameraModel}</dd>{/if}
            {#if cur.imageMediaMetadata?.time}<dt>Taken</dt><dd>{cur.imageMediaMetadata.time}</dd>{/if}
            {#if cur.videoMediaMetadata}<dt>Length</dt><dd class="num">{duration(cur.videoMediaMetadata.durationMillis)}</dd><dt>Video</dt><dd class="num">{cur.videoMediaMetadata.width} × {cur.videoMediaMetadata.height}</dd>{/if}
            <dt>Created</dt><dd>{cur.createdTime ? new Date(cur.createdTime).toLocaleString() : ''}</dd>
            <dt>Modified</dt><dd>{cur.modifiedTime ? new Date(cur.modifiedTime).toLocaleString() : ''}</dd>
            <dt>Shared</dt><dd>{cur.shared ? 'Yes' : 'No'}</dd>
          </dl>
          <div class="row">
            {#if profiles.can('share')}<button class="small" onclick={share}>Share link</button>{/if}
            <a class="btn small" href={driveLink(cur)} target="_blank" rel="noopener">Open in Drive</a>
          </div>
        {:else}
          <div class="comments">
            {#if comments === null}<p class="muted small"><span class="spin"></span></p>
            {:else if comments.length === 0}<p class="muted small">No comments yet.</p>
            {:else}
              {#each comments as c (c.id)}
                <div class="cm">
                  <div class="tiny muted">{c.author?.displayName ?? 'Someone'} · {ago(c.createdTime)}{c.resolved ? ' · resolved' : ''}</div>
                  <div class="small">{c.content}</div>
                </div>
              {/each}
            {/if}
          </div>
          <form class="stack" style="gap:0.5rem" onsubmit={post}>
            <textarea bind:this={commentBox} bind:value={draft} rows="3" placeholder="Add a comment (saved on the file in Google Drive)"></textarea>
            <div class="row spread"><span class="tiny faint"><span class="kbd">⌘ ↵</span> to post · <span class="kbd">Esc</span> back</span><button class="primary small" disabled={!draft.trim()}>Post</button></div>
          </form>
        {/if}
      </aside>
    {/if}

    {#if tv.on && caption && !chrome && cur && list}
      <div class="caption num"><b>{index + 1}</b> / {list.length} · {cur.name}</div>
    {/if}
    <div class="keys tiny faint" data-chrome>
      <span class="kbd">←</span><span class="kbd">→</span> move · <span class="kbd">Del</span> bin · <span class="kbd">C</span> comment · <span class="kbd">S</span> share · <span class="kbd">I</span> details · <span class="kbd">F</span> full screen · <span class="kbd">Esc</span> back
    </div>
  </div>
{/if}

{#if sharing && drive}<ShareDialog {drive} file={sharing} onclose={() => (sharing = null)} />{/if}
<Toast />
<Saving />

<style>
  .picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 0.9rem; }
  .pick { display: grid; justify-items: start; gap: 0.35rem; padding: 1.2rem; border-radius: 16px; background: var(--panel); border: 1px solid var(--line); text-align: left; font-weight: 500; }
  .pick b { font-size: 1rem; }
  .pick.hero { background: linear-gradient(135deg, rgb(124 156 255 / 0.22), rgb(79 209 161 / 0.08)), var(--panel); border-color: rgb(124 156 255 / 0.35); }
  .pick.slim { grid-template-columns: auto 1fr; align-items: center; padding: 0.8rem 1rem; }
  .pick.slim .tiny { grid-column: 2; }
  .pi { font-size: 1.4rem; color: var(--accent-2); }

  /* The bars float over the picture. While they show, the picture sits between them (nothing is
     covered); when they hide, it takes the whole screen. */
  .viewer { --top: 0px; --bottom: 0px; --side: 0px; position: fixed; inset: 0; background: #050607; z-index: 30; overflow: hidden; }
  .viewer.withpanel { --side: 22rem; }
  .top { position: absolute; top: 0; left: 0; right: var(--side); display: flex; align-items: center; gap: 0.8rem; padding: 0.6rem 0.9rem; background: linear-gradient(180deg, rgb(5 6 7 / 0.95), rgb(5 6 7 / 0.6)); border-bottom: 1px solid rgb(255 255 255 / 0.05); z-index: 3; transition: opacity 0.25s; }
  .ttl { flex: 1; min-width: 0; text-align: center; }
  .nm { font-weight: 640; }
  .star { color: var(--warn); }
  .acts { display: flex; align-items: center; gap: 0.25rem; flex-wrap: wrap; justify-content: flex-end; }
  .live { color: var(--good); background: rgb(79 209 161 / 0.12); }
  .tog { display: inline-flex; flex-direction: row; align-items: center; gap: 0.35rem; color: var(--muted); font-weight: 500; padding: 0 0.4rem; white-space: nowrap; }
  .stage { position: absolute; top: var(--top); bottom: var(--bottom); left: 0; right: var(--side); display: grid; place-items: center; overflow: hidden; transition: top 0.25s ease, bottom 0.25s ease; }
  /* Absolutely placed: a percentage height does not resolve inside the grid stage, which made
     pictures fill the width and get cropped. Now the whole picture always fits. */
  .pic.zoomed { cursor: grab; }
  .vwait { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 4.5rem; height: 4.5rem; border-radius: 50%; display: grid; place-items: center; font-size: 2rem; color: #fff; background: rgb(0 0 0 / 0.45); border: 2px solid rgb(255 255 255 / 0.7); }
  .vwait::after { content: ''; position: absolute; inset: -6px; border-radius: 50%; border: 3px solid transparent; border-top-color: #fff; animation: vwait 1s linear forwards; }
  @keyframes vwait { from { transform: rotate(0); } to { transform: rotate(360deg); } }
  .pic, .vhost :global(video) { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; animation: fade 0.18s ease-out; }
  .pic.ready { animation: none; }
  .vhost { position: absolute; inset: 0; }
  .small-pic { position: static; width: auto; height: auto; max-width: 100%; max-height: 50vh; border-radius: 12px; }
  @keyframes fade { from { opacity: 0.2; } }
  .doc { width: min(1100px, 100%); height: 100%; border: 0; background: #fff; }
  .msg { display: grid; justify-items: center; gap: 1rem; text-align: center; padding: 2rem; }
  .nav { position: absolute; top: 50%; transform: translateY(-50%); width: 3.4rem; height: 5rem; font-size: 2.6rem; line-height: 1; border-radius: 14px; background: rgb(0 0 0 / 0.35); border: 1px solid rgb(255 255 255 / 0.08); color: #fff; justify-content: center; transition: opacity 0.25s; }
  .nav:hover { background: rgb(0 0 0 / 0.6); }
  .nav.l { left: 1rem; }
  .nav.r { right: 1rem; }
  .strip { position: absolute; bottom: 0; left: 0; right: var(--side); z-index: 3; display: flex; gap: 0.35rem; padding: 0.55rem 0.8rem 0.7rem; overflow-x: auto; background: linear-gradient(0deg, rgb(5 6 7 / 0.95), rgb(5 6 7 / 0.7)); transition: opacity 0.25s; scrollbar-width: none; }
  .strip button { position: relative; flex: none; width: 4.2rem; height: 3.1rem; padding: 0; border-radius: 8px; overflow: hidden; border: 2px solid transparent; background: var(--panel); opacity: 0.55; display: grid; place-items: center; }
  .strip button.on { border-color: var(--accent); opacity: 1; transform: scale(1.06); }
  .strip button:hover { opacity: 0.9; }
  .strip img { width: 100%; height: 100%; object-fit: cover; }
  .pl { position: absolute; font-size: 0.7rem; color: #fff; text-shadow: 0 1px 4px #000; }
  .panel { position: absolute; top: 0; bottom: 0; right: 0; width: 22rem; z-index: 4; background: var(--panel); border-left: 1px solid var(--line); padding: 1rem; display: flex; flex-direction: column; gap: 1rem; overflow: auto; }
  .seg { display: flex; background: var(--bg-2); border-radius: 9px; padding: 0.15rem; border: 1px solid var(--line); }
  .seg button { border: 0; background: none; font-size: 0.8rem; padding: 0.35rem 0.7rem; color: var(--muted); border-radius: 7px; }
  .seg button.on { background: var(--raise); color: var(--ink); }
  .pn { word-break: break-word; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 0.9rem; margin: 0; font-size: 0.84rem; }
  dt { color: var(--faint); }
  dd { margin: 0; color: var(--ink-2); }
  .comments { flex: 1; display: grid; gap: 0.6rem; align-content: start; }
  .cm { padding: 0.65rem 0.75rem; border-radius: 10px; background: var(--panel-2); display: grid; gap: 0.25rem; }
  .keys { position: absolute; left: 50%; bottom: 4.6rem; transform: translateX(-50%); background: rgb(0 0 0 / 0.55); padding: 0.35rem 0.7rem; border-radius: 99px; white-space: nowrap; transition: opacity 0.25s; pointer-events: none; }
  .keys .kbd { margin: 0 0.1rem; }
  .caption { position: absolute; left: 1.2rem; top: 1rem; z-index: 4; padding: 0.35rem 0.8rem; border-radius: 0.6rem; background: rgb(0 0 0 / 0.55); color: #fff; font-size: 0.8rem; pointer-events: none; animation: fade 0.2s ease-out; max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hide .top, .hide .strip, .hide .nav, .hide .keys { opacity: 0; pointer-events: none; }
  .hide { cursor: none; }
  :global(html.tv) .acts .tog, :global(html.tv) .keys { display: none; }
  :global(html.tv) .strip button { width: 5.4rem; height: 3.4rem; }
  @media (max-width: 760px) {
    .viewer.withpanel { --side: 0px; }
    .panel { position: fixed; inset: auto 0 0 0; width: auto; top: auto; max-height: 60vh; border-radius: 16px 16px 0 0; z-index: 5; }
    .acts .tog, .keys { display: none; }
    .acts button:not(.icon) { font-size: 0; gap: 0; }
  }
</style>
