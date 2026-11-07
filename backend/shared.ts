/** Constants and pure helpers shared by the web app and the functions. */

/** Files this app creates (the share folders and everything uploaded through a link). */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Whole Drive: only for linked accounts (to hand files over) and an owner who uses linked accounts (to accept them). */
export const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';
export const BASE_SCOPES = ['openid', 'email', 'profile'];

export type ScopeLevel = 'file' | 'full';
export const scopesFor = (level: ScopeLevel): string[] => [...BASE_SCOPES, level === 'full' ? DRIVE_FULL_SCOPE : DRIVE_FILE_SCOPE];
export const hasScope = (granted: string, level: ScopeLevel): boolean => {
  const s = granted.split(/\s+/);
  return s.includes(DRIVE_FULL_SCOPE) || (level === 'file' && s.includes(DRIVE_FILE_SCOPE));
};

/** Name of the folder in the owner's Drive that holds every share. */
export const ROOT_FOLDER = 'DriveShare';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Upload chunk size: a multiple of 256 KiB (Drive's rule for resumable chunks). */
export const CHUNK = 32 * 1024 * 1024;
/** A started upload holds its bytes against the cap for this long. */
export const RESERVE_MS = 24 * 60 * 60 * 1000;

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${UNITS[i]}`;
}
/** "15 GB", "500mb", "1.5 tb", "0" → bytes; NaN when unreadable. */
export function parseBytes(text: string): number {
  const m = /^\s*([\d.]+)\s*([kmgt]?i?b?)?\s*$/i.exec(text);
  if (!m) return NaN;
  const unit = (m[2] ?? '').toLowerCase().replace('i', '').replace(/b$/, '');
  const pow = { '': 0, k: 1, m: 2, g: 3, t: 4 }[unit];
  if (pow === undefined) return NaN;
  return Math.round(Number(m[1]) * 1024 ** pow);
}

/** Room left under a cap, given bytes used and bytes held by uploads in progress. */
export function room(cap: number, used: number, reserved: number): number {
  return Math.max(0, cap - used - reserved);
}

/** The next byte range to send in a resumable upload, from Drive's `Range: bytes=0-N` answer. */
export function nextOffset(rangeHeader: string | null, sent: number): number {
  if (rangeHeader == null) return sent;
  const m = /bytes=0-(\d+)/.exec(rangeHeader);
  return m ? Number(m[1]) + 1 : 0;
}

/** A Drive folder name (Drive allows almost anything; we keep it short and on one line). */
export function cleanName(name: string, max = 120): string {
  return name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) || 'Untitled';
}
