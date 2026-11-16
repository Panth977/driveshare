// Who is in a photo. The Mac's photo job (tools/photo-ai) labels each photo with
// dsFaces = "<index file id>:<face ids, base 36>". The index file (in "DriveShare faces") gives each
// face's person; people.json gives the names. Both are small and kept here once fetched.
import type { DFile, DriveApi } from './gdrive.ts';

type Shard = { faces: Record<string, [number, number, number, number, number]> };
type People = { people: Record<string, { name: string | null }> };
const shards = new Map<string, Promise<Shard | null>>();
let people: { at: number; data: Promise<People | null> } | null = null;

async function json<T>(drive: DriveApi, id: string): Promise<T | null> {
  try { return JSON.parse(await (await drive.download({ id, name: 'index', mimeType: 'application/json' } as DFile)).text()) as T; }
  catch { return null; }
}

function peopleFile(drive: DriveApi): Promise<People | null> {
  if (!people || Date.now() - people.at > 10 * 60e3) {
    people = { at: Date.now(), data: drive.query("appProperties has { key='dsPeople' and value='1' } and trashed = false", { max: 1 })
      .then((l) => (l[0] ? json<People>(drive, l[0].id) : null)).catch(() => null) };
  }
  return people.data;
}

/** Names of the people in this photo (those you named on the Mac), in no particular order. */
export async function namesIn(drive: DriveApi, f: DFile): Promise<string[]> {
  const v = f.appProperties?.dsFaces;
  if (!v || !v.includes(':')) return [];
  const [file, ids] = v.split(':') as [string, string];
  let s = shards.get(file);
  if (!s) { s = json<Shard>(drive, file); shards.set(file, s); }
  const [shard, ppl] = await Promise.all([s, peopleFile(drive)]);
  if (!shard || !ppl) return [];
  const names = new Set<string>();
  for (const id of ids.split(',')) {
    const pid = shard.faces[String(parseInt(id, 36))]?.[0];
    const name = pid != null ? ppl.people[String(pid)]?.name : null;
    if (name) names.add(name);
  }
  return [...names];
}
