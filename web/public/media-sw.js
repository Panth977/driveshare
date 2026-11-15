// DriveShare media worker. Everything here goes browser ↔ Google directly; no function is involved.
//
//   /__media/<id>?size=   video/audio: forwards the Range request to Drive with the owner's token
//                         (a <video> cannot send an Authorization header). Not cached.
//   /__thumb/<id>?s=&v=&u= thumbnails, cache first. Key = file, size and version, so a new listing
//                         (new signed link) still hits the cache. An expired link is renewed here.
//   /__orig/<id>?v=&size= original files (the viewer's full picture, PDFs), cache first, up to 25 MB each.
//
// Caches are trimmed oldest-first; signing out deletes them.
const THUMBS = 'ds-thumb-v1';
const ORIGS = 'ds-orig-v1';
const MAX_THUMBS = 4000;
const MAX_ORIGS = 300;
const ORIG_MAX_BYTES = 25 * 1024 * 1024;
const API = 'https://www.googleapis.com/drive/v3/files/';
let token = '';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'token') token = e.data.token;
  // The viewer is about to show a video: fetch its first and last bytes now (see warm()).
  if (e.data && e.data.type === 'warm' && e.data.id && e.data.size) e.waitUntil(warm({ clientId: e.source && e.source.id }, e.data.id, Number(e.data.size)).catch(() => {}));
});

// ── video start-up: a video needs its first bytes and, for most phone videos, its index (the
// "moov" box), which sits at the very end. Each request to Drive takes about a second to answer,
// and playing used to need three in a row. While the viewer waits its one second on a video (or
// shows the file before it), we fetch the first 256 KB and the last 1 MB and keep them in memory, so
// the start (and the index) are answered at once and only the rest of the stream waits on Drive.
const HEAD = 256 << 10;
const TAIL = 1 << 20;
const warmed = new Map(); // id -> { size, head: Promise<Uint8Array|null>, tail: Promise<{start, bytes}|null> }
function warm(e, id, size) {
  if (!size || size < 2 * (HEAD + TAIL)) return Promise.resolve();
  let w = warmed.get(id);
  if (w && w.size === size) { warmed.delete(id); warmed.set(id, w); return Promise.all([w.head, w.tail]); }
  const grab = (start, end) => authed(e, `${API}${encodeURIComponent(id)}?alt=media`, { range: `bytes=${start}-${end}` })
    .then((r) => (r.status === 206 ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)).catch(() => null);
  const tailStart = size - TAIL;
  w = { size, head: grab(0, HEAD - 1), tail: grab(tailStart, size - 1).then((bytes) => (bytes ? { start: tailStart, bytes } : null)) };
  warmed.set(id, w);
  while (warmed.size > 12) warmed.delete(warmed.keys().next().value);
  return Promise.all([w.head, w.tail]);
}

function ranged(bytes, start, end, size, type) {
  return new Response(bytes, { status: 206, headers: { 'content-type': type, 'content-length': String(bytes.length), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' } });
}

/** Answer a range from the warmed head/tail when possible (the head continues with a live stream). */
async function fromWarm(e, id, range, size, type) {
  const w = warmed.get(id);
  const m = /bytes=(\d+)-(\d*)/.exec(range || 'bytes=0-');
  if (!w || w.size !== size || !m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  // Only wait for the part this request needs (and only if it is the warmed part at all).
  if (start >= size - TAIL) {
    const tail = await w.tail;
    return tail ? ranged(tail.bytes.subarray(start - tail.start, end - tail.start + 1), start, end, size, type) : null;
  }
  if (start >= HEAD) return null;
  const head = await w.head;
  if (!head || start >= head.length) return null;
  if (end < head.length) return ranged(head.subarray(start, end + 1), start, end, size, type);
  // The cached start at once, then the rest straight from Drive.
  const first = head.subarray(start);
  // Ask Drive for the rest right away (its answer takes about a second), and hand out the
  // cached start meanwhile.
  const ctrl = new AbortController();
  const rest = authed(e, `${API}${encodeURIComponent(id)}?alt=media`, { range: `bytes=${head.length}-${end}` }, ctrl.signal);
  rest.catch(() => {});
  let reader = null;
  const body = new ReadableStream({
    start(c) { c.enqueue(first); },
    async pull(c) {
      if (!reader) {
        const res = await rest;
        if (res.status !== 206 || !res.body) { c.error(new Error(`Drive ${res.status}`)); return; }
        reader = res.body.getReader();
      }
      const { done, value } = await reader.read();
      if (done) c.close(); else c.enqueue(value);
    },
    cancel() { ctrl.abort(); if (reader) reader.cancel().catch(() => {}); },
  });
  return new Response(body, { status: 206, headers: { 'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' } });
}

async function askToken(clientId, stale) {
  const list = clientId ? [await self.clients.get(clientId)] : await self.clients.matchAll({ type: 'window' });
  for (const c of list) {
    if (!c) continue;
    const t = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(''), 8000);
      ch.port1.onmessage = (m) => { clearTimeout(timer); resolve((m.data && m.data.token) || ''); };
      c.postMessage({ type: 'need-token', stale: stale || '' }, [ch.port2]);
    });
    if (t) return t;
  }
  return '';
}

/** fetch with the owner's token; asks the page for a new one once if Google says 401. */
async function authed(e, url, headers = {}, signal) {
  const client = e.clientId || e.resultingClientId;
  if (!token) token = await askToken(client);
  let res = await fetch(url, { headers: { ...headers, authorization: `Bearer ${token}` }, signal });
  if (res.status === 401) {
    token = await askToken(client, token);
    res = await fetch(url, { headers: { ...headers, authorization: `Bearer ${token}` }, signal });
  }
  return res;
}

let puts = 0;
async function trim(name, max) {
  if (++puts % 40) return;
  const c = await caches.open(name);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await c.delete(k);
}

/** A plain same-origin copy of a response, with only the headers we need. */
function plain(res, extra = {}) {
  const h = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers.get(k);
    if (v) h.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function media(e, url) {
  const id = decodeURIComponent(url.pathname.slice('/__media/'.length));
  const range = e.request.headers.get('range');
  const size0 = Number(url.searchParams.get('size') || 0);
  const hit = await fromWarm(e, id, range, size0, url.searchParams.get('type') || 'video/mp4').catch(() => null);
  if (hit) return hit;
  const res = await authed(e, `${API}${encodeURIComponent(id)}?alt=media`, range ? { range } : {});
  const out = plain(res, { 'accept-ranges': 'bytes' });
  // Google's CORS answer hides Content-Range, which a <video> needs to seek: rebuild it from the
  // range we asked for, the length we got and the file size the page put in the URL.
  if (res.status === 206 && !out.headers.has('content-range')) {
    const size = Number(url.searchParams.get('size') || 0);
    const m = /bytes=(\d+)-(\d*)/.exec(range || '');
    const start = m ? Number(m[1]) : 0;
    const len = Number(res.headers.get('content-length') || 0);
    const end = len ? start + len - 1 : (m && m[2] ? Number(m[2]) : size - 1);
    if (size) out.headers.set('content-range', `bytes ${start}-${end}/${size}`);
  }
  return out;
}

async function thumb(e, url) {
  const id = decodeURIComponent(url.pathname.slice('/__thumb/'.length));
  const s = url.searchParams.get('s') || '400';
  const key = `/__thumb/${encodeURIComponent(id)}?s=${s}&v=${encodeURIComponent(url.searchParams.get('v') || '')}`;
  const cache = await caches.open(THUMBS);
  const hit = await cache.match(key);
  if (hit) return hit;
  let link = url.searchParams.get('u') || '';
  let res = link ? await fetch(link, { mode: 'cors' }).catch(() => 'blocked') : null;
  if (res === 'blocked') {
    // Some browsers (older Android TV web views) get no CORS answer from Google's image server:
    // let the <img> load it itself (the browser's HTTP cache keeps it for a day).
    return Response.redirect(link, 302);
  }
  if (!res || !res.ok) {
    // The signed link expired (they last hours): ask Drive for a new one.
    const meta = await authed(e, `${API}${encodeURIComponent(id)}?fields=thumbnailLink`).then((r) => r.json()).catch(() => null);
    link = meta && meta.thumbnailLink ? meta.thumbnailLink.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${s}`) : '';
    if (!link) return new Response('', { status: 404 });
    res = await fetch(link, { mode: 'cors' }).catch(() => null);
    if (!res || !res.ok) return Response.redirect(link, 302);
  }
  const body = await res.blob();
  const out = new Response(body, { headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg' } });
  await cache.put(key, out.clone());
  void trim(THUMBS, MAX_THUMBS);
  return out;
}

async function original(e, url) {
  const id = decodeURIComponent(url.pathname.slice('/__orig/'.length));
  const key = `/__orig/${encodeURIComponent(id)}?v=${encodeURIComponent(url.searchParams.get('v') || '')}`;
  const cache = await caches.open(ORIGS);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await authed(e, `${API}${encodeURIComponent(id)}?alt=media`);
  if (!res.ok) return plain(res);
  const size = Number(url.searchParams.get('size') || res.headers.get('content-length') || 0);
  if (size > ORIG_MAX_BYTES) return plain(res);
  const body = await res.blob();
  const out = new Response(body, { headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream' } });
  await cache.put(key, out.clone());
  void trim(ORIGS, MAX_ORIGS);
  return out;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/__media/')) e.respondWith(media(e, url));
  else if (url.pathname.startsWith('/__thumb/')) e.respondWith(thumb(e, url));
  else if (url.pathname.startsWith('/__orig/')) e.respondWith(original(e, url));
});
