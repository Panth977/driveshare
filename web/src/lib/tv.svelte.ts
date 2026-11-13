// TV mode: bigger type, focus you can see from the sofa, and arrow-key (D-pad) navigation between
// anything clickable. On by default in TV browsers; a toggle in the top bar for everything else.
const TV_UA = /\b(SMART-?TV|SmartTV|Tizen|Web0S|WebOS|NetCast|BRAVIA|AFT[A-Z]|CrKey|GoogleTV|Android TV|AndroidTV|HbbTV|Roku|PhilipsTV|VIDAA|Viera|AQUOS)\b/i;

class TvMode {
  on = $state(false);
  constructor() {
    const q = new URLSearchParams(location.search).get('tv');
    const saved = localStorage.getItem('ds.tv');
    this.on = q != null ? q !== '0' : saved != null ? saved === '1' : TV_UA.test(navigator.userAgent);
    this.apply();
  }
  toggle() { this.on = !this.on; localStorage.setItem('ds.tv', this.on ? '1' : '0'); this.apply(); }
  private apply() { document.documentElement.classList.toggle('tv', this.on); }
}
export const tv = new TvMode();

/** Remote "back" keys: Escape, Backspace (outside inputs), Tizen 10009, webOS 461. */
export const isBack = (e: KeyboardEvent) => e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.keyCode === 10009 || e.keyCode === 461 || (e.key === 'Backspace' && !editable(e.target));

export function editable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'submit'].includes((el as HTMLInputElement).type)) || el.tagName === 'SELECT');
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

/**
 * Move focus to the nearest focusable element in a direction (geometric spatial navigation).
 * Searches inside the innermost open dialog if there is one.
 */
export function moveFocus(dir: 'left' | 'right' | 'up' | 'down'): boolean {
  const scope = (document.querySelector('[data-modal]:last-of-type') as HTMLElement | null) ?? document.body;
  const cur = document.activeElement as HTMLElement | null;
  const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e !== cur && visible(e) && !e.closest('[data-nav-skip]'));
  if (!all.length) return false;
  if (!cur || cur === document.body || !scope.contains(cur)) { all[0]!.focus(); return true; }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of all) {
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const dx = bx - ax, dy = by - ay;
    let main: number, cross: number;
    if (dir === 'right') { if (b.left < a.right - 4 && dx <= 4) continue; main = Math.max(0, b.left - a.right); cross = Math.abs(dy); }
    else if (dir === 'left') { if (b.right > a.left + 4 && dx >= -4) continue; main = Math.max(0, a.left - b.right); cross = Math.abs(dy); }
    else if (dir === 'down') { if (b.top < a.bottom - 4 && dy <= 4) continue; main = Math.max(0, b.top - a.bottom); cross = Math.abs(dx); }
    else { if (b.bottom > a.top + 4 && dy >= -4) continue; main = Math.max(0, a.top - b.bottom); cross = Math.abs(dx); }
    const score = main + cross * 2.2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return false;
  best.focus();
  best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

const DIRS: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/** Global D-pad handler: views that handle arrows themselves call preventDefault first. */
export function installSpatialNav(): void {
  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = DIRS[e.key];
    if (!dir) return;
    if (editable(e.target) && (dir === 'left' || dir === 'right')) return;
    if (!tv.on && !(document.activeElement && document.activeElement !== document.body)) return;
    if (!tv.on) return;
    if (moveFocus(dir)) e.preventDefault();
  });
}
