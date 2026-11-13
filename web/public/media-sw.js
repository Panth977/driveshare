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
});

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
async function authed(e, url, headers = {}) {
  const client = e.clientId || e.resultingClientId;
  if (!token) token = await askToken(client);
  let res = await fetch(url, { headers: { ...headers, authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    token = await askToken(client, token);
    res = await fetch(url, { headers: { ...headers, authorization: `Bearer ${token}` } });
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
  let res = await fetch(url.searchParams.get('u') || '', { mode: 'cors' }).catch(() => null);
  if (!res || !res.ok) {
    // The signed link expired (they last hours): ask Drive for a new one.
    const meta = await authed(e, `${API}${encodeURIComponent(id)}?fields=thumbnailLink`).then((r) => r.json()).catch(() => null);
    const link = meta && meta.thumbnailLink ? meta.thumbnailLink.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${s}`) : '';
    res = link ? await fetch(link, { mode: 'cors' }).catch(() => null) : null;
  }
  if (!res || !res.ok) return new Response('', { status: 404 });
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
