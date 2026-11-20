// Household profiles for a shared screen (the TV): several people use one signed-in account, each
// with what they may do there, and an optional 4-digit PIN. With no profiles set up, everything is
// allowed (as before). A PIN, once entered, is not asked again on that screen for an hour.
//
// This is a family lock for one TV, kept in the account's own Firestore document; it is not
// account security (whoever holds the account's session can change it).
import { collection, doc, onSnapshot, serverTimestamp, setDoc } from '@panth977/icebase/firestore';
import { settings } from '@driveshare/backend/schema';
import { auth, db } from './icebase.ts';
import { tv } from './tv.svelte.ts';

export type Action = 'comment' | 'share' | 'edit' | 'bin';
export const ACTIONS: { id: Action; label: string; hint: string }[] = [
  { id: 'comment', label: 'Comment', hint: 'add comments' },
  { id: 'share', label: 'Share links', hint: 'make share links' },
  { id: 'edit', label: 'Edit', hint: 'star or rotate pictures' },
  { id: 'bin', label: 'Delete', hint: 'delete files' },
];

export interface Profile {
  id: string;
  name: string;
  color: string;
  can: Record<Action, boolean>;
  /** salt:sha256hex of the PIN; empty = no PIN. */
  pin: string;
  /** Ask the PIN before these actions (and before switching to this profile). */
  pinFor: Action[];
  /** Folders this profile sees on the TV (with everything inside them). Empty or missing = all of Drive. */
  folders?: { id: string; name: string }[];
}

export const COLORS = ['#7c9cff', '#4fd1a1', '#f5b454', '#ff7b9c', '#c18cff', '#5ad1e6'];
const GRACE_MS = 60 * 60 * 1000;

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomUUID().slice(0, 8);
  return `${salt}:${await sha(`${salt}:${pin}`)}`;
}
async function checkPin(stored: string, pin: string): Promise<boolean> {
  const [salt, h] = stored.split(':');
  return !!salt && !!h && (await sha(`${salt}:${pin}`)) === h;
}

export const newProfile = (name: string, i: number): Profile => ({
  id: crypto.randomUUID().slice(0, 8), name, color: COLORS[i % COLORS.length]!,
  can: { comment: true, share: false, edit: false, bin: false }, pin: '', pinFor: ['bin'],
});

/** A PIN request the page shows (PinPad), resolved with the digits or null (cancelled). */
export interface PinAsk { title: string; resolve: (pin: string | null) => void }

class Profiles {
  list = $state.raw<Profile[]>([]);
  loaded = $state(false);
  /** The profile using this screen (only when there are profiles, and only on the TV). */
  currentId = $state(localStorage.getItem('ds.profile') ?? '');
  /** The PIN pad on screen, if any. */
  ask = $state<PinAsk | null>(null);
  private stop: (() => void) | null = null;

  /** Watch the account's profiles (call once signed in). */
  watch(): void {
    const uid = auth.currentUser?.uid;
    if (!uid || this.stop) return;
    this.stop = onSnapshot(doc(collection(db, settings, uid), 'profiles'), (s) => {
      try { this.list = JSON.parse((s.data() as { profiles?: string } | undefined)?.profiles ?? '[]'); } catch { this.list = []; }
      this.seen.clear();
      this.loaded = true;
    }, () => { this.loaded = true; });
  }

  /** Profiles apply on shared screens (TV mode) once at least one exists. */
  get active(): boolean { return tv.on && this.list.length > 0; }
  get current(): Profile | undefined { return this.list.find((p) => p.id === this.currentId); }
  /** On a TV with profiles, someone has to pick one first. */
  get needsPick(): boolean { return this.active && this.loaded && !this.current; }

  async save(list: Profile[]): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Sign in first');
    await setDoc(doc(collection(db, settings, uid), 'profiles'), { profiles: JSON.stringify(list), updatedAt: serverTimestamp() } as never);
  }

  private unlockedUntil(p: Profile): number { return Number(localStorage.getItem(`ds.unlock.${p.id}`) ?? 0); }
  private unlock(p: Profile) { localStorage.setItem(`ds.unlock.${p.id}`, String(Date.now() + GRACE_MS)); }

  private askPin(title: string): Promise<string | null> {
    return new Promise((resolve) => { this.ask = { title, resolve: (pin) => { this.ask = null; resolve(pin); } }; });
  }

  /** Ask for a profile's PIN (unless it was entered within the hour). True when it matched. */
  async verify(p: Profile, why: string): Promise<boolean> {
    if (!p.pin || Date.now() < this.unlockedUntil(p)) return true;
    for (let tries = 0; tries < 3; tries++) {
      const pin = await this.askPin(tries ? `Wrong PIN. ${why}` : why);
      if (pin === null) return false;
      if (await checkPin(p.pin, pin)) { this.unlock(p); return true; }
    }
    return false;
  }

  async pick(p: Profile): Promise<boolean> {
    if (p.pin && !(await this.verify(p, `PIN for ${p.name}`))) return false;
    this.currentId = p.id;
    localStorage.setItem('ds.profile', p.id);
    return true;
  }

  leave() { this.currentId = ''; localStorage.removeItem('ds.profile'); }

  /** May the person on this screen do `action`? Asks the PIN when that profile wants it. */
  async allow(action: Action, toast?: (t: string) => void): Promise<boolean> {
    if (!this.active) return true;
    const p = this.current;
    if (!p) return false;
    if (!p.can[action]) { toast?.(`${p.name} cannot ${ACTIONS.find((a) => a.id === action)!.hint} on this TV.`); return false; }
    if (p.pinFor.includes(action)) return this.verify(p, `PIN for ${p.name} to ${ACTIONS.find((a) => a.id === action)!.hint}`);
    return true;
  }

  /** On the TV, the folders the current profile is kept to; null = it sees everything. */
  get folders(): { id: string; name: string }[] | null {
    const f = this.active ? this.current?.folders : undefined;
    return f?.length ? f : null;
  }

  private seen = new Map<string, boolean>();
  /**
   * May the current profile open this folder (or a file's folder)? Yes when it is one of the
   * profile's folders or inside one (walks up the parents, remembered). Recent, Starred, Shared and
   * My Drive itself are outside every list.
   */
  async canSee(id: string, d: { get(id: string): Promise<{ parents?: string[] }> } | null): Promise<boolean> {
    const fs = this.folders;
    if (!fs) return true;
    const allow = new Set(fs.map((f) => f.id));
    if (allow.has(id)) return true;
    if (!d || !/^[\w-]{15,}$/.test(id)) return false;
    const key = `${this.currentId}:${id}`;
    const known = this.seen.get(key);
    if (known !== undefined) return known;
    let ok = false;
    let at = id;
    for (let i = 0; i < 40; i++) {
      const p = (await d.get(at).catch(() => null))?.parents?.[0];
      if (!p) break;
      if (allow.has(p)) { ok = true; break; }
      at = p;
    }
    this.seen.set(key, ok);
    return ok;
  }

  /** Without asking: is `action` shown as available at all? */
  can(action: Action): boolean { return !this.active || !!this.current?.can[action]; }
}

export const profiles = new Profiles();
