// DriveShare media worker. A <video> element cannot send an Authorization header, so the viewer
// points it at /__media/<fileId> and this worker forwards the request (with its Range header) to
// Drive with the owner's short-lived access token. Bytes go Google → browser; nothing else is cached.
let token = '';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'token') token = e.data.token;
});

async function askToken(clientId) {
  const list = clientId ? [await self.clients.get(clientId)] : await self.clients.matchAll({ type: 'window' });
  for (const c of list) {
    if (!c) continue;
    const t = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(''), 3000);
      ch.port1.onmessage = (m) => { clearTimeout(timer); resolve((m.data && m.data.token) || ''); };
      c.postMessage({ type: 'need-token' }, [ch.port2]);
    });
    if (t) return t;
  }
  return '';
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__media/')) return;
  e.respondWith((async () => {
    const id = decodeURIComponent(url.pathname.slice('/__media/'.length));
    const go = async () => {
      const headers = { authorization: `Bearer ${token}` };
      const range = e.request.headers.get('range');
      if (range) headers.range = range;
      return fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers });
    };
    if (!token) token = await askToken(e.clientId || e.resultingClientId);
    let res = await go();
    if (res.status === 401) { token = await askToken(e.clientId || e.resultingClientId); res = await go(); }
    // Hand the body back as a plain same-origin response (keeps Content-Range for seeking).
    const h = new Headers();
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = res.headers.get(k);
      if (v) h.set(k, v);
    }
    if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes');
    // Google's CORS answer hides Content-Range, which a <video> needs to seek: rebuild it from the
    // range we asked for, the length we got and the file size the page put in the URL.
    if (res.status === 206 && !h.has('content-range')) {
      const size = Number(url.searchParams.get('size') || 0);
      const m = /bytes=(\d+)-(\d*)/.exec(e.request.headers.get('range') || '');
      const start = m ? Number(m[1]) : 0;
      const len = Number(res.headers.get('content-length') || 0);
      const end = len ? start + len - 1 : (m && m[2] ? Number(m[2]) : size - 1);
      if (size) h.set('content-range', `bytes ${start}-${end}/${size}`);
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  })());
});
