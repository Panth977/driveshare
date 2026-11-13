// Sends one file to a Drive resumable-upload session, in chunks, straight from the browser.
// The session was opened by the backend with the owner's token; its URL is the only credential.
import { CHUNK, nextOffset } from '@driveshare/backend/shared';

export interface Sent { id?: string }

function put(url: string, body: Blob | null, range: string, onProgress: (n: number) => void, signal?: AbortSignal): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Content-Range', range);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => resolve(x);
    x.onerror = () => reject(new Error('Network error'));
    x.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => x.abort(), { once: true });
    x.send(body);
  });
}

const done = (x: XMLHttpRequest) => x.status === 200 || x.status === 201;
const idOf = (x: XMLHttpRequest): Sent => { try { return { id: JSON.parse(x.responseText).id }; } catch { return {}; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `resume`: the session may already hold some bytes (an upload that stopped half way); ask Drive
 * how far it got and carry on from there.
 */
export async function sendFile(url: string, file: Blob, onProgress: (sent: number) => void, signal?: AbortSignal, resume = false, onResume?: (from: number) => void): Promise<Sent> {
  const size = file.size;
  let offset = 0;
  if (resume && size > 0) {
    const q = await put(url, null, `bytes */${size}`, () => {}, signal);
    if (done(q)) { onProgress(size); return idOf(q); }
    if (q.status === 404 || q.status === 410) throw new Error('The upload expired. Start it again.');
    if (q.status !== 308) throw new Error(`Drive answered ${q.status}`);
    offset = nextOffset(q.getResponseHeader('Range'), 0);
    onResume?.(offset);
    onProgress(offset);
  }
  if (size === 0) {
    const x = await put(url, null, 'bytes */0', () => {}, signal);
    if (!done(x)) throw new Error(`Drive answered ${x.status}`);
    return idOf(x);
  }
  let tries = 0;
  while (offset < size) {
    const end = Math.min(offset + CHUNK, size);
    try {
      const x = await put(url, file.slice(offset, end), `bytes ${offset}-${end - 1}/${size}`, (n) => onProgress(offset + n), signal);
      if (done(x)) { onProgress(size); return idOf(x); }
      if (x.status === 308) { offset = nextOffset(x.getResponseHeader('Range'), end); tries = 0; onProgress(offset); continue; }
      if (x.status === 404 || x.status === 410) throw new Error('The upload expired. Start it again.');
      if (x.status < 500 && x.status !== 429) throw new Error(`Drive answered ${x.status}`);
      throw new Error(`Drive answered ${x.status}`);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || /expired|answered 4/.test((e as Error).message) && !/answered 429/.test((e as Error).message)) throw e;
      if (++tries > 6) throw e;
      await wait(Math.min(30_000, 1000 * 2 ** tries));
      // Ask Drive how much it has, then carry on from there.
      const q = await put(url, null, `bytes */${size}`, () => {}, signal).catch(() => null);
      if (q && done(q)) { onProgress(size); return idOf(q); }
      if (q?.status === 308) offset = nextOffset(q.getResponseHeader('Range'), 0);
    }
  }
  return {};
}
