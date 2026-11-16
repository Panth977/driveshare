#!/usr/bin/env python3
"""DriveShare photo jobs, run on this Mac, with a local dashboard (http://localhost:4390).

  * Rotation ("Share TB" folder): finds photos stored sideways or upside down. Sure ones get the
    label dsTurn=1|2|3 (quarter turns clockwise) and DriveShare shows them the right way up; unsure
    ones wait in the dashboard for you to pick.
  * Faces (every photo): finds faces, gives each a fingerprint, groups alike faces into people. You
    name people and answer "same person?" in the dashboard. Each photo gets the label
    dsFaces="<index file id>:<face ids>"; the index file (in "DriveShare faces") says which person
    each face is, and people.json gives the names.

Works from Drive's small copies of each photo (1024 px), never the originals. Everything is kept in
.photoai/photoai.db, so it can stop and carry on at any time. Labels never change a photo's
"modified" date.

  ~/.venvs/photoai/bin/python tools/photo-ai/engine.py          # run (dashboard + jobs)
"""
import io, json, os, sqlite3, subprocess, sys, threading, time, traceback, queue, random, ssl
import urllib.request, urllib.parse, urllib.error
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageOps

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
HOME = os.path.join(ROOT, '.photoai')
THUMBS = os.path.join(HOME, 'thumbs')
DB = os.path.join(HOME, 'photoai.db')
PORT = int(os.environ.get('PORT', '4390'))
SHARE_TB = '1NEHP7FWhcYXndEak0vlr3jT9_ZH_BQJg'
API = 'https://www.googleapis.com/drive/v3'
UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
SURE = 0.9          # orientation model: at least this sure (and faces agree) → fixed without asking
FACE_MIN = 0.6      # face detector score to keep a face
FACE_PX = 36        # smallest face side kept (pixels in the 1024 copy)
SAME = 0.6          # fingerprints this alike → same person without asking
ASK_LOW = 0.42      # between ASK_LOW and SAME → ask you
SHARD = 2000        # faces per index file
os.makedirs(THUMBS, exist_ok=True)

# ───────────────────────────── store ─────────────────────────────
_db_lock = threading.RLock()
def db():
    c = sqlite3.connect(DB, timeout=60, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c
CONN = db()
CONN.executescript('''
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY, name TEXT, parent TEXT, mime TEXT, mtime TEXT, thumb TEXT,
  w INT, h INT, share INT DEFAULT 0, state TEXT DEFAULT 'new', err TEXT, faces_label TEXT);
CREATE INDEX IF NOT EXISTS photos_state ON photos(state);
CREATE TABLE IF NOT EXISTS rot(id TEXT PRIMARY KEY, k_model INT, p REAL, fk TEXT, k INT, status TEXT, answer INT, applied INT DEFAULT 0, at REAL);
CREATE INDEX IF NOT EXISTS rot_status ON rot(status);
CREATE TABLE IF NOT EXISTS faces(fid INTEGER PRIMARY KEY AUTOINCREMENT, photo TEXT, x REAL, y REAL, w REAL, h REAL,
  score REAL, emb BLOB, crop BLOB, person INT, locked INT DEFAULT 0);
CREATE INDEX IF NOT EXISTS faces_photo ON faces(photo);
CREATE INDEX IF NOT EXISTS faces_person ON faces(person);
CREATE TABLE IF NOT EXISTS people(pid INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, cover INT, n INT DEFAULT 0, hidden INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS answers(a INT, b INT, same INT, at REAL, PRIMARY KEY(a, b));
CREATE TABLE IF NOT EXISTS shards(n INT PRIMARY KEY, file TEXT, dirty INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS log(at REAL, msg TEXT);
''')
def q(sql, args=(), one=False):
    with _db_lock:
        cur = CONN.execute(sql, args)
        rows = cur.fetchall()
        CONN.commit()
    return (rows[0] if rows else None) if one else rows
def kv(k, v=None):
    if v is None:
        r = q('SELECT v FROM kv WHERE k=?', (k,), one=True)
        return json.loads(r['v']) if r else None
    q('INSERT OR REPLACE INTO kv VALUES(?,?)', (k, json.dumps(v)))
def log(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)
    q('INSERT INTO log VALUES(?,?)', (time.time(), msg))

# Jobs: scan (fetch + look), write (labels to Drive), group (faces → people). Each can be paused.
JOBS = {'scan': 'running', 'write': 'running', 'group': 'idle'}
for j, s in (kv('jobs') or {}).items():
    if j in JOBS and s in ('running', 'paused'): JOBS[j] = s
STAGE = {'scan': 'starting', 'write': 'waiting', 'group': 'not run yet', 'list': ''}
RATE = {'scan': []}
def paused(job):
    return JOBS[job] == 'paused'

# ───────────────────────────── Drive ─────────────────────────────
_tok = {'value': '', 'until': 0}
_tok_lock = threading.Lock()
def token(force=False):
    with _tok_lock:
        if not force and time.time() * 1000 < _tok['until'] - 10 * 60e3:
            return _tok['value']
        for attempt in range(5):
            try:
                out = subprocess.run(['node', os.path.join(ROOT, 'tools/photo-ai/token.mjs')], capture_output=True, text=True, timeout=120).stdout
                t = json.loads(out)
                _tok.update(t)
                return t['value']
            except Exception as e:
                log(f'token: {e} (try {attempt + 1})')
                time.sleep(20 * (attempt + 1))
        raise RuntimeError('No Drive token: open DriveShare in .photoai/profile and sign in again')

_ctx = ssl.create_default_context()
def http(method, url, body=None, headers=None, auth=True, raw=False, tries=6):
    for attempt in range(tries):
        h = dict(headers or {})
        if auth: h['Authorization'] = 'Bearer ' + token(force=attempt > 0 and getattr(http, 'last401', False))
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        if body is not None and not isinstance(body, bytes): h.setdefault('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=h), timeout=60, context=_ctx) as r:
                http.last401 = False
                b = r.read()
                return b if raw else (json.loads(b) if b else {})
        except urllib.error.HTTPError as e:
            msg = e.read()[:300].decode('utf8', 'replace')
            http.last401 = e.code == 401
            if e.code in (401, 429, 500, 502, 503, 504) or (e.code == 403 and ('rate' in msg.lower() or 'quota' in msg.lower())):
                time.sleep(min(60, 2 ** attempt + random.random())); continue
            raise RuntimeError(f'{method} {url.split("?")[0]} → {e.code} {msg}')
        except (urllib.error.URLError, TimeoutError, ConnectionError, ssl.SSLError) as e:
            time.sleep(min(60, 2 ** attempt + random.random())); continue
    raise RuntimeError(f'{method} {url.split("?")[0]}: gave up')

def label(fid, mtime, props):
    """Set appProperties on a file (None removes one), keeping its modified date."""
    body = {'appProperties': props}
    if mtime: body['modifiedTime'] = mtime
    http('PATCH', f'{API}/files/{fid}?fields=id', body)

def put_json(name, parent, obj, file_id=None, props=None):
    data = json.dumps(obj, separators=(',', ':')).encode()
    if file_id:
        r = http('PATCH', f'{UPLOAD}/files/{file_id}?uploadType=media&fields=id', data, {'Content-Type': 'application/json'})
        return r['id']
    boundary = 'dsb' + str(random.random())[2:]
    meta = json.dumps({'name': name, 'parents': [parent], 'mimeType': 'application/json', **({'appProperties': props} if props else {})}).encode()
    body = b''.join([f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'.encode(), meta,
                     f'\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n'.encode(), data, f'\r\n--{boundary}--'.encode()])
    r = http('POST', f'{UPLOAD}/files?uploadType=multipart&fields=id', body, {'Content-Type': f'multipart/related; boundary={boundary}'})
    return r['id']

def faces_folder():
    f = kv('facesFolder')
    if f: return f
    qq = "appProperties has { key='dsFacesHome' and value='1' } and trashed=false"
    r = http('GET', f'{API}/files?q={urllib.parse.quote(qq)}&fields=files(id)')
    if r.get('files'):
        f = r['files'][0]['id']
    else:
        f = http('POST', f'{API}/files?fields=id', {'name': 'DriveShare faces', 'mimeType': 'application/vnd.google-apps.folder',
                 'description': 'Who is in which photo, for DriveShare (made on the Mac by tools/photo-ai). Safe to keep; small.', 'appProperties': {'dsFacesHome': '1'}})['id']
    kv('facesFolder', f)
    return f

# ───────────────────────────── listing ─────────────────────────────
def list_photos():
    if kv('listedAt') and time.time() - kv('listedAt') < 12 * 3600:
        return
    STAGE['list'] = 'listing folders of Share TB'
    folders, level = {SHARE_TB}, [SHARE_TB]
    if kv('shareFolders'): folders, level = set(kv('shareFolders')), []   # listed before this restart
    while level:
        nxt = []
        for i in range(0, len(level), 25):
            ch = level[i:i + 25]
            qq = '(' + ' or '.join(f"'{x}' in parents" for x in ch) + ") and mimeType='application/vnd.google-apps.folder' and trashed=false"
            pt = ''
            while True:
                r = http('GET', f'{API}/files?q={urllib.parse.quote(qq)}&pageSize=1000&fields=nextPageToken,files(id)' + (f'&pageToken={pt}' if pt else ''))
                for f in r.get('files', []):
                    if f['id'] not in folders: folders.add(f['id']); nxt.append(f['id'])
                pt = r.get('nextPageToken')
                if not pt: break
        level = nxt
        STAGE['list'] = f'listing folders of Share TB ({len(folders):,})'
    kv('shareFolders', sorted(folders))
    STAGE['list'] = 'listing photos'
    qq = "mimeType contains 'image/' and trashed=false and 'me' in owners"
    pt, n = kv('listToken') or '', q('SELECT COUNT(*) c FROM photos', one=True)['c'] if kv('listToken') else 0
    while True:
        r = http('GET', f'{API}/files?q={urllib.parse.quote(qq)}&pageSize=1000&fields=nextPageToken,files(id,name,parents,mimeType,modifiedTime,thumbnailLink,imageMediaMetadata(width,height))' + (f'&pageToken={pt}' if pt else ''))
        rows = []
        for f in r.get('files', []):
            if not f.get('thumbnailLink'): continue
            m = f.get('imageMediaMetadata') or {}
            par = (f.get('parents') or [''])[0]
            rows.append((f['id'], f['name'], par, f['mimeType'], f.get('modifiedTime'), f['thumbnailLink'], m.get('width'), m.get('height'), int(par in folders)))
        with _db_lock:
            CONN.executemany('''INSERT INTO photos(id,name,parent,mime,mtime,thumb,w,h,share) VALUES(?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent=excluded.parent, mtime=excluded.mtime, thumb=excluded.thumb, share=excluded.share''', rows)
            CONN.commit()
        n += len(rows)
        STAGE['list'] = f'listing photos ({n:,})'
        pt = r.get('nextPageToken')
        kv('listToken', pt or '')
        if not pt: break
    kv('listedAt', time.time())
    STAGE['list'] = f'listed {n:,} photos'
    log(f'listed {n:,} photos; {len(folders):,} folders in Share TB')

# ───────────────────────────── models ─────────────────────────────
MODELS = {}
def models():
    if MODELS: return MODELS
    import logging, warnings
    warnings.filterwarnings('ignore'); logging.disable(logging.WARNING)
    import torch, albumentations as A
    from check_orientation.pre_trained_models import create_model
    from insightface.app import FaceAnalysis
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    MODELS['torch'] = torch
    MODELS['dev'] = dev
    MODELS['orient'] = create_model('swsl_resnext50_32x4d').eval().to(dev)
    MODELS['tf'] = A.Compose([A.Resize(224, 224), A.Normalize(p=1)])
    det = FaceAnalysis(name='buffalo_l', allowed_modules=['detection'], providers=['CoreMLExecutionProvider', 'CPUExecutionProvider'])
    det.prepare(ctx_id=0, det_size=(640, 640))
    full = FaceAnalysis(name='buffalo_l', allowed_modules=['detection', 'recognition'], providers=['CoreMLExecutionProvider', 'CPUExecutionProvider'])
    full.prepare(ctx_id=0, det_size=(640, 640))
    MODELS['det'], MODELS['full'] = det, full
    return MODELS

def orient(im):
    m = models(); torch = m['torch']
    x = torch.from_numpy(m['tf'](image=np.asarray(im))['image']).permute(2, 0, 1)[None].to(m['dev'])
    with torch.no_grad(): p = m['orient'](x)[0].float().cpu().numpy()
    c = int(p.argmax())
    # Class c = the picture is turned c quarter turns anticlockwise, so it needs c turns clockwise.
    return c, float(p.max())

def face_turns(im):
    """Sum of face scores when the picture is turned 0, 1, 2, 3 quarter turns clockwise."""
    out = []
    for k in range(4):
        r = models()['det'].get(np.asarray(im.rotate(-90 * k, expand=True))[:, :, ::-1])
        out.append(float(sum(f.det_score for f in r if f.det_score > FACE_MIN)))
    return out

def decide(k_model, p, fk):
    fk = np.array(fk)
    strong = fk.max() > 0.6 and np.sort(fk)[-2] < fk.max() * 0.5
    kf = int(fk.argmax())
    if strong:
        if kf == k_model: return k_model, 'sure'
        return (kf if p < SURE else k_model), 'ask'
    # No clear faces. Nearly every photo is the right way up, so "upright" needs no proof; a turn
    # without faces to back it is done only when the model is very sure.
    if k_model == 0: return 0, 'sure'
    # Upside down is rare from a real camera, and maps, signs and cave roofs fool the model: ask.
    if k_model == 2: return 2, 'ask'
    return k_model, ('sure' if p >= SURE else 'ask')

def find_faces(im):
    m = models()
    arr = np.asarray(im)[:, :, ::-1]
    out = []
    W, H = im.size
    for f in m['full'].get(arr):
        x1, y1, x2, y2 = [float(v) for v in f.bbox]
        if f.det_score < FACE_MIN or min(x2 - x1, y2 - y1) < FACE_PX or f.normed_embedding is None: continue
        mx, my = (x2 - x1) * 0.25, (y2 - y1) * 0.25
        crop = im.crop((max(0, x1 - mx), max(0, y1 - my), min(W, x2 + mx), min(H, y2 + my))).resize((96, 96))
        b = io.BytesIO(); crop.save(b, 'JPEG', quality=80)
        out.append(dict(x=x1 / W, y=y1 / H, w=(x2 - x1) / W, h=(y2 - y1) / H, score=float(f.det_score),
                        emb=np.asarray(f.normed_embedding, dtype=np.float32).tobytes(), crop=b.getvalue()))
    return out

# ───────────────────────────── scan ─────────────────────────────
def fetch(row):
    url = row['thumb'].split('=s')[0] + '=s1024'
    try:
        return http('GET', url, auth=False, raw=True, tries=3)
    except Exception:
        # The signed link expired (they last hours): ask Drive for a new one.
        f = http('GET', f"{API}/files/{row['id']}?fields=thumbnailLink")
        if not f.get('thumbnailLink'): raise
        q('UPDATE photos SET thumb=? WHERE id=?', (f['thumbnailLink'], row['id']))
        return http('GET', f['thumbnailLink'].split('=s')[0] + '=s1024', auth=False, raw=True)

def analyse(row, data):
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert('RGB')
    small = im.copy(); small.thumbnail((512, 512))
    k = 0
    done = q('SELECT status, answer FROM rot WHERE id=?', (row['id'],), one=True)
    if done and done['status'] == 'answered':
        k = done['answer'] or 0            # you said which way is up
    elif row['share']:
        km, p = orient(small)
        fk = [0, 0, 0, 0]
        if km != 0 or p < SURE: fk = face_turns(small)
        k, verdict = decide(km, p, fk)
        status = 'upright' if (k == 0 and verdict == 'sure') else ('auto' if verdict == 'sure' else 'ask')
        q('INSERT OR REPLACE INTO rot(id,k_model,p,fk,k,status,applied,at) VALUES(?,?,?,?,?,?,COALESCE((SELECT applied FROM rot WHERE id=?),0),?)',
          (row['id'], km, p, json.dumps(fk), k, status, row['id'], time.time()))
        if status != 'upright':
            small.save(os.path.join(THUMBS, row['id'] + '.jpg'), 'JPEG', quality=82)
        if status == 'ask': k = km   # best guess for finding faces; done again once you answer
    upright = im.rotate(-90 * k, expand=True) if k else im
    faces = find_faces(upright)
    with _db_lock:
        CONN.execute('DELETE FROM faces WHERE photo=?', (row['id'],))
        CONN.executemany('INSERT INTO faces(photo,x,y,w,h,score,emb,crop) VALUES(?,?,?,?,?,?,?,?)',
                         [(row['id'], f['x'], f['y'], f['w'], f['h'], f['score'], f['emb'], f['crop']) for f in faces])
        CONN.execute("UPDATE photos SET state='done', err=NULL, faces_label=NULL WHERE id=?", (row['id'],))
        CONN.commit()

LISTING = {'on': False}
def lister():
    LISTING['on'] = True
    try: list_photos()
    except Exception:
        kv('listToken', '')   # a stale page token: list again from the start (rows are kept)
        raise
    finally: LISTING['on'] = False

def scan_loop():
    threading.Thread(target=lambda: guard(lister, once=True), daemon=True).start()
    pool = ThreadPoolExecutor(8)
    apool = ThreadPoolExecutor(3)   # the models release Python's lock while they run
    models()
    while True:
        if paused('scan'):
            STAGE['scan'] = 'paused'; time.sleep(1); continue
        rows = q("SELECT * FROM photos WHERE state IN ('new','redo') ORDER BY share DESC, rowid LIMIT 64")
        if not rows and LISTING['on']:
            time.sleep(3); continue
        if not rows:
            STAGE['scan'] = 'done'
            if JOBS['group'] == 'idle' and kv('groupedAt') is None: JOBS['group'] = 'running'
            time.sleep(10); continue
        STAGE['scan'] = 'looking at photos' + (' (still listing)' if LISTING['on'] else '')
        futs = {pool.submit(fetch, r): r for r in rows}
        def work(fu, r):
            while paused('scan'): STAGE['scan'] = 'paused'; time.sleep(1)
            try:
                analyse(r, fu.result())
                RATE['scan'].append(time.time())
            except Exception as e:
                q("UPDATE photos SET state='error', err=? WHERE id=?", (str(e)[:300], r['id']))
        for f in [apool.submit(work, fu, r) for fu, r in futs.items()]: f.result()
        RATE['scan'] = [t for t in RATE['scan'] if t > time.time() - 300]

# ───────────────────────────── grouping ─────────────────────────────
def group():
    STAGE['group'] = 'loading fingerprints'
    rows = q('SELECT fid, emb, person, locked FROM faces')
    if not rows: return
    fids = np.array([r['fid'] for r in rows])
    E = np.frombuffer(b''.join(r['emb'] for r in rows), dtype=np.float32).reshape(len(rows), -1)
    person = np.array([r['person'] if r['person'] is not None else -1 for r in rows])
    locked = np.array([r['locked'] for r in rows], dtype=bool)
    no = {(r['a'], r['b']) for r in q('SELECT a,b FROM answers WHERE same=0')}
    n = len(rows)
    parent = np.arange(n)
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    import torch
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    T = torch.from_numpy(E).to(dev)
    B = 512
    for s in range(0, n, B):
        STAGE['group'] = f'comparing faces {s:,}/{n:,}'
        S = T[s:s + B] @ T[s:].T            # each pair once: this block against itself and everything after
        idx = (S >= SAME).nonzero().cpu().numpy()
        idx[:, 1] += s
        for a, b in idx:
            i, j = s + int(a), int(b)
            if j <= i: continue
            # Never merge two people you named apart, or that you said are different.
            pi, pj = person[i], person[j]
            if locked[i] and locked[j] and pi != pj: continue
            ri, rj = find(i), find(j)
            if ri != rj: parent[rj] = ri
    roots = np.array([find(i) for i in range(n)])
    STAGE['group'] = 'naming groups'
    # Each group joins the person most of its locked faces belong to, else a new (unnamed) person.
    with _db_lock:
        cur = CONN.cursor()
        groups = {}
        for i, r in enumerate(roots): groups.setdefault(int(r), []).append(i)
        new_person = {}
        for r, members in groups.items():
            lk = [person[i] for i in members if locked[i] and person[i] >= 0]
            if lk:
                pid = max(set(lk), key=lk.count)
            else:
                old = [person[i] for i in members if person[i] >= 0]
                pid = max(set(old), key=old.count) if old else None
                if pid is not None and pid in new_person.values(): pid = None   # that person went to a bigger group
                if pid is None:
                    cur.execute('INSERT INTO people(name) VALUES(NULL)'); pid = cur.lastrowid
            new_person[r] = pid
            unl = [int(fids[i]) for i in members if not locked[i]]
            for k in range(0, len(unl), 900):
                ch = unl[k:k + 900]
                cur.execute(f'UPDATE faces SET person=? WHERE fid IN ({",".join("?" * len(ch))})', [pid, *ch])
        cur.execute('UPDATE people SET n=(SELECT COUNT(*) FROM faces WHERE faces.person=people.pid)')
        cur.execute('''UPDATE people SET cover=(SELECT fid FROM faces WHERE faces.person=people.pid ORDER BY score*w*h DESC LIMIT 1)
                       WHERE cover IS NULL OR cover NOT IN (SELECT fid FROM faces WHERE faces.person=people.pid)''')
        cur.execute('DELETE FROM people WHERE n=0')
        cur.execute('UPDATE shards SET dirty=1')
        CONN.commit()
    kv('groupedAt', time.time())
    build_questions()
    log(f'grouped {n:,} faces into {q("SELECT COUNT(*) c FROM people", one=True)["c"]:,} people')

QUESTIONS = []
def build_questions():
    """Pairs of people whose faces look alike but not alike enough to be sure: ask you."""
    ppl = q('SELECT pid, n FROM people WHERE n>=2 AND hidden=0 ORDER BY n DESC LIMIT 3000')
    if len(ppl) < 2: QUESTIONS.clear(); return
    cents, ids = [], []
    for p in ppl:
        rows = q('SELECT emb FROM faces WHERE person=? ORDER BY score DESC LIMIT 30', (p['pid'],))
        e = np.frombuffer(b''.join(r['emb'] for r in rows), dtype=np.float32).reshape(len(rows), -1).mean(0)
        cents.append(e / (np.linalg.norm(e) + 1e-9)); ids.append(p['pid'])
    C = np.stack(cents); S = C @ C.T
    done = {(r['a'], r['b']) for r in q('SELECT a,b FROM answers')}
    out = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            if ASK_LOW <= S[i, j] < 0.99 and (ids[i], ids[j]) not in done and (ids[j], ids[i]) not in done:
                out.append((float(S[i, j]), ids[i], ids[j]))
    out.sort(reverse=True)
    QUESTIONS[:] = out[:500]

def group_loop():
    while True:
        # Group again every ~15,000 new faces, so people show up while the scan goes on.
        nf = q('SELECT COUNT(*) c FROM faces', one=True)['c']
        if JOBS['group'] == 'idle' and nf - (kv('groupedFaces') or 0) >= 15000: JOBS['group'] = 'running'
        if JOBS['group'] == 'running':
            kv('groupedFaces', nf)
            try: group()
            except Exception as e: log(f'grouping failed: {e}'); traceback.print_exc()
            JOBS['group'] = 'idle'; STAGE['group'] = 'done ' + time.strftime('%H:%M')
        time.sleep(2)

# ───────────────────────────── writing labels ─────────────────────────────
def write_loop():
    while True:
        if paused('write'): STAGE['write'] = 'paused'; time.sleep(1); continue
        try:
            did = write_once()
        except Exception as e:
            log(f'writing labels: {e}'); did = False; time.sleep(30)
        if not did: STAGE['write'] = 'up to date'; time.sleep(5)

def write_once():
    # 1. Rotations: sure ones and the ones you answered.
    rows = q("SELECT rot.id, rot.k, rot.answer, rot.status, photos.mtime FROM rot JOIN photos USING(id) WHERE status IN ('auto','answered') AND applied != COALESCE(answer, k) LIMIT 50")
    for r in rows:
        if paused('write'): return True
        k = r['answer'] if r['status'] == 'answered' else r['k']
        STAGE['write'] = 'rotation labels'
        label(r['id'], r['mtime'], {'dsTurn': str(k) if k else None})
        q('UPDATE rot SET applied=? WHERE id=?', (k, r['id']))
    if rows: return True
    # 2. Faces: only after a grouping, so the index has people in it.
    if not kv('groupedAt'): return False
    folder = faces_folder()
    # Index files whose people changed (named, merged, regrouped).
    dirty = q('SELECT n, file FROM shards WHERE dirty=1 LIMIT 5')
    for s in dirty:
        STAGE['write'] = f'face index file {s["n"]}'
        lo, hi = s['n'] * SHARD, (s['n'] + 1) * SHARD
        data = {str(r['fid']): [r['person'], round(r['x'], 4), round(r['y'], 4), round(r['w'], 4), round(r['h'], 4)]
                for r in q('SELECT fid, person, x, y, w, h FROM faces WHERE fid>=? AND fid<?', (lo, hi))}
        fid = put_json(f'faces-{s["n"]:04d}.json', folder, {'v': 1, 'faces': data}, s['file'])
        q('UPDATE shards SET file=?, dirty=0 WHERE n=?', (fid, s['n']))
    if dirty:
        ppl = {str(r['pid']): {'name': r['name'], 'n': r['n'], 'cover': r['cover']} for r in q('SELECT pid,name,n,cover FROM people WHERE hidden=0')}
        kv('peopleFile', put_json('people.json', folder, {'v': 1, 'people': ppl}, kv('peopleFile'), {'dsPeople': '1'}))
        return True
    # Photo labels: "<index file id>:<face ids>" (all of a photo's faces are in one index file).
    rows = q('''SELECT p.id, p.mtime, GROUP_CONCAT(f.fid) AS fids FROM photos p JOIN faces f ON f.photo=p.id
                WHERE p.state='done' AND p.faces_label IS NULL GROUP BY p.id LIMIT 40''')
    for r in rows:
        if paused('write'): return True
        ids = sorted(int(x) for x in r['fids'].split(','))
        n = ids[0] // SHARD
        s = q('SELECT file FROM shards WHERE n=?', (n,), one=True)
        if not s or not s['file']:
            q('INSERT OR IGNORE INTO shards(n, dirty) VALUES(?,1)', (n,))
            return True   # the index file is made first (above), then this photo
        if any(i // SHARD != n for i in ids): ids = [i for i in ids if i // SHARD == n]
        val = s['file'] + ':' + ','.join(np.base_repr(i, 36).lower() for i in ids)
        while len('dsFaces') + len(val.encode()) > 124: val = val.rsplit(',', 1)[0]
        STAGE['write'] = 'face labels on photos'
        label(r['id'], r['mtime'], {'dsFaces': val})
        q('UPDATE photos SET faces_label=? WHERE id=?', (val, r['id']))
        q('UPDATE shards SET dirty=1 WHERE n=?', (n,))   # its index file gets these faces next round
    return bool(rows)

# ───────────────────────────── dashboard ─────────────────────────────
def status():
    c = lambda sql, a=(): q(sql, a, one=True)[0]
    rate = len([t for t in RATE['scan'] if t > time.time() - 120]) / 120
    left = c("SELECT COUNT(*) FROM photos WHERE state IN ('new','redo')")
    return {
        'jobs': JOBS, 'stage': STAGE,
        'photos': c('SELECT COUNT(*) FROM photos'), 'share': c('SELECT COUNT(*) FROM photos WHERE share=1'),
        'done': c("SELECT COUNT(*) FROM photos WHERE state='done'"), 'left': left, 'errors': c("SELECT COUNT(*) FROM photos WHERE state='error'"),
        'rate': round(rate, 1), 'eta_min': round(left / rate / 60) if rate else None,
        'rot': {r['status']: r['n'] for r in q('SELECT status, COUNT(*) n FROM rot GROUP BY status')},
        'rot_written': c('SELECT COUNT(*) FROM rot WHERE applied!=0'),
        'faces': c('SELECT COUNT(*) FROM faces'), 'with_faces': c('SELECT COUNT(DISTINCT photo) FROM faces'),
        'people': c('SELECT COUNT(*) FROM people WHERE n>0'), 'named': c("SELECT COUNT(*) FROM people WHERE name IS NOT NULL AND name!=''"),
        'questions': len(QUESTIONS), 'face_labels': c('SELECT COUNT(*) FROM photos WHERE faces_label IS NOT NULL'),
        'grouped_at': kv('groupedAt'),
        'log': [dict(r) for r in q('SELECT at, msg FROM log ORDER BY at DESC LIMIT 12')],
    }

def merge(a, b):
    """Person b becomes person a."""
    if a == b: return
    pa = q('SELECT name FROM people WHERE pid=?', (a,), one=True); pb = q('SELECT name FROM people WHERE pid=?', (b,), one=True)
    with _db_lock:
        CONN.execute('UPDATE faces SET person=?, locked=1 WHERE person=?', (a, b))
        if pa and not pa['name'] and pb and pb['name']: CONN.execute('UPDATE people SET name=? WHERE pid=?', (pb['name'], a))
        CONN.execute('DELETE FROM people WHERE pid=?', (b,))
        CONN.execute('UPDATE people SET n=(SELECT COUNT(*) FROM faces WHERE person=?) WHERE pid=?', (a, a))
        CONN.execute('UPDATE answers SET a=? WHERE a=?', (a, b)); CONN.execute('UPDATE answers SET b=? WHERE b=?', (a, b))
        CONN.execute('UPDATE shards SET dirty=1')
        CONN.commit()
    QUESTIONS[:] = [(s, x if x != b else a, y if y != b else a) for s, x, y in QUESTIONS if {x, y} != {a, b}]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype='application/json'):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store' if ctype == 'application/json' else 'max-age=3600'); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); a = dict(urllib.parse.parse_qsl(u.query)); p = u.path
        try:
            if p == '/': return self.send(200, open(os.path.join(os.path.dirname(__file__), 'dashboard.html'), 'rb').read(), 'text/html; charset=utf-8')
            if p == '/api/status': return self.send(200, status())
            if p == '/api/rot':
                st = a.get('status', 'ask'); off = int(a.get('offset', 0))
                rows = q('SELECT rot.id, k, k_model, p, status, answer, photos.name FROM rot JOIN photos USING(id) WHERE status=? ORDER BY at DESC LIMIT 30 OFFSET ?', (st, off))
                return self.send(200, [dict(r) for r in rows])
            if p.startswith('/thumb/'):
                f = os.path.join(THUMBS, os.path.basename(p) + '.jpg')
                return self.send(200, open(f, 'rb').read(), 'image/jpeg') if os.path.exists(f) else self.send(404, {})
            if p.startswith('/face/'):
                r = q('SELECT crop FROM faces WHERE fid=?', (int(os.path.basename(p)),), one=True)
                return self.send(200, r['crop'], 'image/jpeg') if r else self.send(404, {})
            if p == '/api/people':
                off = int(a.get('offset', 0)); named = a.get('named')
                where = "name IS NOT NULL AND name!=''" if named == '1' else ("(name IS NULL OR name='')" if named == '0' else '1')
                hid = 1 if named == 'hidden' else 0   # the "Ignored" tab: groups set aside as not a person
                rows = q(f'SELECT pid, name, n, cover FROM people WHERE n>0 AND hidden=? AND {where} ORDER BY n DESC LIMIT 48 OFFSET ?', (hid, off))
                out = []
                for r in rows:
                    sample = [x['fid'] for x in q('SELECT fid FROM faces WHERE person=? ORDER BY score DESC LIMIT 8', (r['pid'],))]
                    out.append({**dict(r), 'sample': sample})
                return self.send(200, out)
            if p == '/api/person':
                pid = int(a['pid'])
                rows = q('SELECT fid, photo FROM faces WHERE person=? ORDER BY score DESC LIMIT 200', (pid,))
                return self.send(200, [dict(r) for r in rows])
            if p == '/api/questions':
                off, lim = int(a.get('offset', 0)), int(a.get('limit', 60))
                out, seen = [], 0
                def side(pid):
                    r = q('SELECT pid,name,n FROM people WHERE pid=?', (pid,), one=True)
                    return r and {**dict(r), 'faces': [x['fid'] for x in q('SELECT fid FROM faces WHERE person=? ORDER BY score DESC LIMIT 4', (pid,))]}
                for s_, x, y in list(QUESTIONS):
                    sx, sy = side(x), side(y)
                    if not (sx and sy): continue
                    if seen >= off: out.append({'sim': s_, 'a': sx, 'b': sy})
                    seen += 1
                    if len(out) >= lim: break
                return self.send(200, {'total': len(QUESTIONS), 'items': out})
            if p == '/api/question':
                while QUESTIONS:
                    s, x, y = QUESTIONS[0]
                    px = q('SELECT pid,name,n FROM people WHERE pid=?', (x,), one=True); py = q('SELECT pid,name,n FROM people WHERE pid=?', (y,), one=True)
                    if px and py:
                        fx = [r['fid'] for r in q('SELECT fid FROM faces WHERE person=? ORDER BY score DESC LIMIT 6', (x,))]
                        fy = [r['fid'] for r in q('SELECT fid FROM faces WHERE person=? ORDER BY score DESC LIMIT 6', (y,))]
                        return self.send(200, {'sim': s, 'a': {**dict(px), 'faces': fx}, 'b': {**dict(py), 'faces': fy}, 'left': len(QUESTIONS)})
                    QUESTIONS.pop(0)
                return self.send(200, None)
            if p == '/api/names':
                return self.send(200, [r['name'] for r in q("SELECT DISTINCT name FROM people WHERE name IS NOT NULL AND name!='' ORDER BY name")])
            self.send(404, {'error': 'not found'})
        except Exception as e:
            traceback.print_exc(); self.send(500, {'error': str(e)})
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); b = json.loads(self.rfile.read(n) or b'{}'); p = self.path
        try:
            if p == '/api/job':
                j, act = b['job'], b['action']
                if j == 'group': JOBS['group'] = 'running' if act in ('play', 'run') else JOBS['group']
                else: JOBS[j] = 'paused' if act == 'pause' else 'running'
                kv('jobs', {k: v for k, v in JOBS.items() if k != 'group'})
                return self.send(200, JOBS)
            if p == '/api/rot/answer':
                k = int(b['k'])
                if k < 0: q("UPDATE rot SET status='skipped', answer=NULL WHERE id=?", (b['id'],))
                else:
                    q("UPDATE rot SET status='answered', answer=? WHERE id=?", (k, b['id']))
                    r = q('SELECT k FROM rot WHERE id=?', (b['id'],), one=True)
                    if r and r['k'] != k: q("UPDATE photos SET state='redo' WHERE id=?", (b['id'],))  # find its faces again, the right way up
                return self.send(200, {'ok': True})
            if p == '/api/rot/undo':
                q("UPDATE rot SET status='answered', answer=0 WHERE id=?", (b['id'],))
                return self.send(200, {'ok': True})
            if p == '/api/people/name':
                pid, name = int(b['pid']), (b.get('name') or '').strip()
                other = q('SELECT pid FROM people WHERE name=? AND pid!=?', (name, pid), one=True) if name else None
                if other: merge(other['pid'], pid)   # same name = same person
                else:
                    q('UPDATE people SET name=?, hidden=CASE WHEN ? THEN 0 ELSE hidden END WHERE pid=?', (name or None, bool(name), pid))   # naming an ignored group brings it back
                    q('UPDATE faces SET locked=1 WHERE person=?', (pid,)); q('UPDATE shards SET dirty=1')
                return self.send(200, {'ok': True, 'merged': bool(other)})
            if p == '/api/people/unhide':
                q('UPDATE people SET hidden=0 WHERE pid=?', (int(b['pid']),)); q('UPDATE shards SET dirty=1')
                return self.send(200, {'ok': True})
            if p == '/api/people/hide':
                q('UPDATE people SET hidden=1 WHERE pid=?', (int(b['pid']),)); q('UPDATE shards SET dirty=1')
                return self.send(200, {'ok': True})
            if p == '/api/face/remove':
                fid = int(b['fid'])
                with _db_lock:
                    cur = CONN.cursor(); cur.execute('INSERT INTO people(name, n) VALUES(NULL, 1)'); np_ = cur.lastrowid
                    cur.execute('UPDATE faces SET person=?, locked=1 WHERE fid=?', (np_, fid)); cur.execute('UPDATE people SET cover=? WHERE pid=?', (fid, np_))
                    cur.execute('UPDATE people SET n=(SELECT COUNT(*) FROM faces WHERE person=people.pid)'); cur.execute('UPDATE shards SET dirty=1'); CONN.commit()
                return self.send(200, {'ok': True})
            if p == '/api/question/answer':
                a_, b_, same = int(b['a']), int(b['b']), bool(b['same'])
                if b.get('skip'):
                    for i, x in enumerate(QUESTIONS):
                        if {x[1], x[2]} == {a_, b_}: QUESTIONS.append(QUESTIONS.pop(i)); break
                    return self.send(200, {'ok': True})
                q('INSERT OR REPLACE INTO answers VALUES(?,?,?,?)', (a_, b_, int(same), time.time()))
                if same: merge(a_, b_)
                else: QUESTIONS[:] = [x for x in QUESTIONS if {x[1], x[2]} != {a_, b_}]
                return self.send(200, {'ok': True})
            self.send(404, {'error': 'not found'})
        except Exception as e:
            traceback.print_exc(); self.send(500, {'error': str(e)})

def main():
    for t in (scan_loop, write_loop, group_loop):
        threading.Thread(target=lambda t=t: guard(t), daemon=True, name=t.__name__).start()
    if kv('groupedAt'): threading.Thread(target=build_questions, daemon=True).start()
    log(f'dashboard on http://localhost:{PORT}')
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()

def guard(fn, once=False):
    while True:
        try:
            fn()
            if once: return
        except Exception as e:
            log(f'{fn.__name__} stopped: {e}; again in 60 s'); traceback.print_exc(); time.sleep(60)

if __name__ == '__main__':
    main()
