#!/usr/bin/env node
// Makes MP4 copies of the Drive's videos that no browser or TV can play (MPEG-2 .mpg, camcorder
// .m2t/.mts, .avi…), on this Mac, so the DriveShare viewer can play them.
//
//   node tools/convert-videos.mjs            convert everything still to do (safe to stop and rerun)
//   node tools/convert-videos.mjs --list     only list what would be converted
//   node tools/convert-videos.mjs --one <id> convert one file (a test)
//
// Each copy is H.264 + AAC MP4 (deinterlaced, at most 1080p, index at the front so it starts at
// once), made with the Mac's hardware encoder. Each copy goes next to its original, in the same
// folder and with the same date ("Party.MPG" + "Party.mp4"; "Party (converted).mp4" when that name is
// taken). The original stays as it is and gets two small labels (appProperties dsPlay = the copy's
// id, dsPlaySize = its size), which the viewer reads to play the copy instead.
//
//   node tools/convert-videos.mjs --move-copies   move copies made before this out of the old
//                                                 "DriveShare previews" folder, next to their originals
//   MIN_FREE_GB=5 node tools/convert-videos.mjs   keep less disk spare (default 30 GB)
//
// Drive access: the owner's token, taken from a signed-in DriveShare page in a headless Chrome
// (the profile in .convert/profile; the app renews the token there, once an hour).
// Work files, the state and the log live in .convert/ (not in git).
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, statfsSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = join(ROOT, '.convert');
const WORK = join(HOME, 'work');
const STATE = join(HOME, 'state.json');
const LOG = join(HOME, 'convert.log');
const PROFILE = join(HOME, 'profile');
const SITE = 'https://driveshare-p977.web.app';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MIMES = ['video/mpeg', 'video/mp2t', 'video/vnd.dlna.mpeg-tts', 'video/avi', 'video/x-msvideo', 'video/x-ms-wmv', 'video/x-flv', 'video/3gpp'];
const MIN_FREE = Number(process.env.MIN_FREE_GB || 30) * 1e9;
mkdirSync(WORK, { recursive: true });

const log = (...a) => {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${a.join(' ')}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
};
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { done: {}, failed: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the token, from the signed-in app ──
let browser = null, page = null, token = { value: '', until: 0 };
async function getToken() {
  if (Date.now() < token.until - 5 * 60e3) return token.value;
  if (!browser) {
    const root = process.env.PWROOT || join(execSync('npm root -g').toString().trim(), '@playwright/cli/node_modules');
    const { chromium } = createRequire(root + '/')('playwright-core');
    browser = await chromium.launchPersistentContext(PROFILE, { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    page = browser.pages()[0] ?? (await browser.newPage());
  }
  for (let i = 0; i < 4; i++) {
    await page.goto(`${SITE}/drive?tv=0`).catch(() => {}); // /drive starts Drive, which renews the token
    for (let j = 0; j < 30; j++) {
      const t = await page.evaluate(() => JSON.parse(localStorage.getItem('ds.driveToken') ?? 'null')).catch(() => null);
      if (t && t.until > Date.now() + 10 * 60e3) { token = { value: t.value, until: t.until }; return t.value; }
      // Old token in the page: drop it so the app asks for a new one.
      if (t && j === 0) await page.evaluate(() => localStorage.removeItem('ds.driveToken')).then(() => page.reload()).catch(() => {});
      await sleep(1000);
    }
  }
  throw new Error('No Drive token: open DriveShare in .convert/profile and sign in again');
}

async function api(method, url, body, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${await getToken()}`, ...(body && typeof body === 'string' ? { 'content-type': 'application/json' } : {}), ...headers }, body });
    if (res.status === 401 && attempt < 2) { token.until = 0; continue; }
    if ((res.status === 429 || res.status >= 500 || (res.status === 403 && /rate|quota/i.test(await res.clone().text()))) && attempt < 6) { await sleep(2000 * 2 ** attempt); continue; }
    if (!res.ok) throw new Error(`${method} ${url.split('?')[0]} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  }
}
const json = async (...a) => (await api(...a)).json();

// ── what to convert ──
async function candidates() {
  const q = `(${MIMES.map((m) => `mimeType='${m}'`).join(' or ')}) and trashed=false and 'me' in owners`;
  const out = [];
  let pageToken = '';
  do {
    const r = await json('GET', `${API}/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,size,mimeType,parents,modifiedTime,appProperties,videoMediaMetadata(width,height,durationMillis))${pageToken ? `&pageToken=${pageToken}` : ''}`);
    out.push(...r.files);
    pageToken = r.nextPageToken;
  } while (pageToken);
  // Real videos only: Drive measures a duration for those (TypeScript .ts/.mts files also come
  // back as "video/mp2t").
  return out.filter((f) => !f.appProperties?.dsPlay && Number(f.size || 0) > 0 && Number(f.videoMediaMetadata?.durationMillis || 0) > 0 && !/\.d\.[mc]?ts$|\.[mc]?tsx?$/i.test(f.name) || /\.(m2t|m2ts|mts|mpg|mpeg|vob|avi)$/i.test(f.name) && !f.appProperties?.dsPlay && Number(f.size || 0) > 1e6 && !/\.d\.mts$/i.test(f.name))
    .sort((a, b) => Number(a.size) - Number(b.size));
}

async function previewsFolder() {
  if (state.folder) return state.folder;
  const r = await json('GET', `${API}/files?q=${encodeURIComponent("appProperties has { key='dsPreviews' and value='1' } and trashed=false")}&fields=files(id)`);
  if (r.files[0]) return (state.folder = r.files[0].id);
  const f = await json('POST', `${API}/files?fields=id`, JSON.stringify({ name: 'DriveShare previews', mimeType: 'application/vnd.google-apps.folder', description: 'MP4 copies of old videos (.mpg, .m2t…) so DriveShare can play them on the TV. Made by DriveShare; the originals are untouched.', appProperties: { dsPreviews: '1' } }));
  save();
  return (state.folder = f.id);
}

// ── where a copy goes: next to its original ──
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function copyPlace(orig, copyId = null) {
  const parent = orig.parents?.[0];
  if (!parent) return { parent: await previewsFolder(), name: `${orig.name.replace(/\.[^.]+$/, '')}.mp4` };
  const base = orig.name.replace(/\.[^.]+$/, '');
  for (const name of [`${base}.mp4`, `${base} (converted).mp4`, `${base} (converted ${orig.id.slice(-4)}).mp4`]) {
    const r = await json('GET', `${API}/files?q=${encodeURIComponent(`'${parent}' in parents and name='${esc(name)}' and trashed=false`)}&fields=files(id)`);
    if (!r.files.some((x) => x.id !== copyId)) return { parent, name };
  }
  throw new Error('no free name for the copy');
}

async function moveCopies() {
  const old = await previewsFolder();
  let moved = 0, same = 0;
  const ids = Object.keys(state.done);
  const work = async (id) => {
    const d = state.done[id];
    const orig = await json('GET', `${API}/files/${id}?fields=id,name,parents,modifiedTime,trashed`).catch(() => null);
    const copy = await json('GET', `${API}/files/${d.mp4}?fields=id,name,parents`).catch(() => null);
    if (!orig || !copy || orig.trashed) { log(`  skip ${d.name}: ${!orig ? 'original gone' : !copy ? 'copy gone' : 'original in the bin'}`); return; }
    if (copy.parents?.[0] === orig.parents?.[0]) { same++; return; }
    const at = await copyPlace(orig, copy.id);
    const q = `addParents=${at.parent}&removeParents=${(copy.parents ?? [old]).join(',')}&fields=id`;
    await api('PATCH', `${API}/files/${copy.id}?${q}`, JSON.stringify({ name: at.name, modifiedTime: orig.modifiedTime }));
    moved++;
    if (moved % 25 === 0) log(`  moved ${moved}…`);
  };
  for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map((id) => work(id).catch((e) => log(`  ✗ ${state.done[id].name}: ${e.message}`))));
  log(`copies next to their originals: ${moved} moved, ${same} were already there`);
  const left = await json('GET', `${API}/files?q=${encodeURIComponent(`'${old}' in parents and trashed=false`)}&fields=files(id,name)`);
  if (!left.files.length) { await api('PATCH', `${API}/files/${old}?fields=id`, JSON.stringify({ trashed: true })); log('"DriveShare previews" is empty: moved to the bin'); delete state.folder; save(); }
  else log(`"DriveShare previews" still holds ${left.files.length} files; left as it is`);
}

// ── download (resumable, to disk) ──
async function download(f, path) {
  const size = Number(f.size);
  for (let attempt = 0; attempt < 8; attempt++) {
    const have = existsSync(path) ? statSync(path).size : 0;
    if (have >= size) return;
    try {
      const res = await api('GET', `${API}/files/${f.id}?alt=media`, undefined, { range: `bytes=${have}-` });
      const out = createWriteStream(path, { flags: 'a' });
      let got = have, last = Date.now();
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        got += chunk.length;
        if (Date.now() - last > 60e3) { last = Date.now(); log(`  ↓ ${f.name} ${(got / 1e9).toFixed(2)}/${(size / 1e9).toFixed(2)} GB`); }
      }
      await new Promise((r) => out.end(r));
    } catch (e) { log(`  ↓ retry (${e.message})`); await sleep(5000 * (attempt + 1)); }
  }
  if (statSync(path).size < size) throw new Error('download incomplete');
}

// ── convert ──
function probe(path) {
  try { return JSON.parse(execSync(`ffprobe -v error -show_streams -show_format -of json "${path}"`, { maxBuffer: 1 << 24 }).toString()); } catch { return null; }
}
function convert(src, dst, info) {
  const v = info?.streams?.find((s) => s.codec_type === 'video');
  const a = info?.streams?.find((s) => s.codec_type === 'audio');
  const h = Number(v?.height || 576);
  const interlaced = v && v.field_order && !/progressive|unknown/.test(v.field_order);
  const filters = [interlaced ? 'bwdif=mode=send_frame' : 'bwdif=mode=send_frame:deint=interlaced', h > 1080 ? 'scale=-2:1080' : null, 'format=yuv420p'].filter(Boolean).join(',');
  const rate = h >= 1000 ? '6M' : h >= 700 ? '4M' : '2500k';
  const args = ['-hide_banner', '-loglevel', 'error', '-stats_period', '30', '-y', '-fflags', '+genpts+discardcorrupt', '-i', src,
    '-map', '0:v:0', ...(a ? ['-map', '0:a:0'] : []),
    '-vf', filters, '-c:v', 'h264_videotoolbox', '-b:v', rate, '-maxrate', rate.replace(/\d+/, (n) => String(Math.round(Number(n) * 1.5))), '-profile:v', 'high', '-tag:v', 'avc1',
    ...(a ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : []),
    '-movflags', '+faststart', dst];
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

// ── upload (resumable) ──
async function upload(path, name, parent, source) {
  const size = statSync(path).size;
  const start = await api('POST', `${UPLOAD}/files?uploadType=resumable&fields=id,size`, JSON.stringify({ name, parents: [parent], mimeType: 'video/mp4', appProperties: { dsSource: source } }), { 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(size) });
  const url = start.headers.get('location');
  const CHUNK = 32 * 1024 * 1024;
  let sent = 0, last = Date.now();
  const fd = openSync(path, 'r');
  try {
    while (sent < size) {
      const n = Math.min(CHUNK, size - sent);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, sent);
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetch(url, { method: 'PUT', headers: { 'content-range': `bytes ${sent}-${sent + n - 1}/${size}` }, body: buf });
          if (res.status === 308 || res.ok) break;
          if (res.status >= 500 && attempt < 6) { await sleep(3000 * (attempt + 1)); continue; }
          throw new Error(`upload ${res.status} ${(await res.text()).slice(0, 200)}`);
        } catch (e) {
          if (attempt >= 6) throw e;
          await sleep(3000 * (attempt + 1));
          // Ask where Drive got to, and carry on from there.
          const q = await fetch(url, { method: 'PUT', headers: { 'content-range': `bytes */${size}` } }).catch(() => null);
          const r = q?.headers.get('range');
          if (q?.ok) return q.json();
          if (r) { sent = Number(r.split('-')[1]) + 1; break; }
        }
      }
      if (res?.ok) return res.json();
      const r = res?.headers.get('range');
      sent = r ? Number(r.split('-')[1]) + 1 : sent + n;
      if (Date.now() - last > 60e3) { last = Date.now(); log(`  ↑ ${name} ${(sent / 1e9).toFixed(2)}/${(size / 1e9).toFixed(2)} GB`); }
    }
  } finally { closeSync(fd); }
  throw new Error('upload ended without an answer');
}

async function fetchSource(f) {
  const src = join(WORK, `${f.id}.src`);
  while (statfsSync(HOME).bavail * statfsSync(HOME).bsize < MIN_FREE + Number(f.size) * 1.3) { log('  waiting for free disk space'); await sleep(10 * 60e3); }
  await download(f, src);
}

async function one(f, fetched) {
  const src = join(WORK, `${f.id}.src`);
  const dst = join(WORK, `${f.id}.mp4`);
  const t0 = Date.now();
  log(`▶ ${f.name} (${(Number(f.size) / 1e9).toFixed(2)} GB, ${Math.round((f.videoMediaMetadata?.durationMillis ?? 0) / 60000)} min)`);
  await (fetched ?? fetchSource(f));
  const t1 = Date.now();
  await convert(src, dst, probe(src));
  const t2 = Date.now();
  const at = await copyPlace(f);
  const up = await upload(dst, at.name, at.parent, f.id);
  // Same date as the original, so the two sit together when sorted by date too.
  if (f.modifiedTime) await api('PATCH', `${API}/files/${up.id}?fields=id`, JSON.stringify({ modifiedTime: f.modifiedTime }));
  // (modifiedTime given back as it was: a label must not make the original look edited today.)
  await api('PATCH', `${API}/files/${f.id}?fields=id`, JSON.stringify({ appProperties: { dsPlay: up.id, dsPlaySize: String(up.size ?? statSync(dst).size) }, ...(f.modifiedTime ? { modifiedTime: f.modifiedTime } : {}) }));
  const mb = (statSync(dst).size / 1e6).toFixed(0);
  rmSync(src, { force: true });
  rmSync(dst, { force: true });
  state.done[f.id] = { name: f.name, mp4: up.id, mb: Number(mb), at: new Date().toISOString() };
  delete state.failed[f.id];
  save();
  log(`✓ ${f.name} → ${mb} MB · down ${Math.round((t1 - t0) / 1000)} s, convert ${Math.round((t2 - t1) / 1000)} s, up ${Math.round((Date.now() - t2) / 1000)} s`);
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--move-copies') {
    await moveCopies();
  } else if (args[0] === '--fix-dates') {
    // Originals labelled before the line above: put their date back to their last content change.
    for (const id of Object.keys(state.done)) {
      const f = await json('GET', `${API}/files/${id}?fields=id,name,modifiedTime`);
      const revs = await json('GET', `${API}/files/${id}/revisions?fields=revisions(modifiedTime)&pageSize=1000`).catch(() => null);
      const last = revs?.revisions?.at(-1)?.modifiedTime;
      if (last && last !== f.modifiedTime) { await api('PATCH', `${API}/files/${id}?fields=id`, JSON.stringify({ modifiedTime: last })); log(`date ${f.name}: ${f.modifiedTime} → ${last}`); }
    }
  } else if (args[0] === '--one') {
    const f = await json('GET', `${API}/files/${args[1]}?fields=id,name,size,mimeType,parents,modifiedTime,appProperties,videoMediaMetadata(width,height,durationMillis)`);
    await one(f);
  } else {
    const list = await candidates();
    const gb = list.reduce((s, f) => s + Number(f.size), 0) / 1e9;
    log(`${list.length} videos to convert (${gb.toFixed(0)} GB), ${Object.keys(state.done).length} done before`);
    if (args[0] === '--list') { for (const f of list) console.log(f.id, f.mimeType, (Number(f.size) / 1e6).toFixed(0) + 'MB', f.name); }
    else {
      const todo = list.filter((f) => (state.failed[f.id]?.tries ?? 0) < 3);
      // Download the next video while this one is converted and sent (down and up run side by side).
      let ahead = todo[0] ? fetchSource(todo[0]) : null;
      for (let i = 0; i < todo.length; i++) {
        const f = todo[i];
        const mine = ahead;
        mine?.catch(() => {});
        ahead = null;
        try {
          await mine;
          ahead = todo[i + 1] ? fetchSource(todo[i + 1]) : null;
          ahead?.catch(() => {});
          await one(f, Promise.resolve());
        } catch (e) {
          if (!ahead && todo[i + 1]) { ahead = fetchSource(todo[i + 1]); ahead.catch(() => {}); }
          state.failed[f.id] = { name: f.name, error: String(e.message ?? e).slice(0, 300), tries: (state.failed[f.id]?.tries ?? 0) + 1 };
          save();
          log(`✗ ${f.name}: ${state.failed[f.id].error}`);
        }
      }
      log(`finished: ${Object.keys(state.done).length} done, ${Object.keys(state.failed).length} failed`);
    }
  }
} finally {
  await browser?.close().catch(() => {});
}
