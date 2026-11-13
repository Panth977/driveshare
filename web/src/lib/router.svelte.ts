// A tiny history router: the path is state; nav() pushes and every view re-reads it.
class Router {
  path = $state(location.pathname);
  search = $state(location.search);
  constructor() {
    addEventListener('popstate', () => { this.path = location.pathname; this.search = location.search; });
  }
  nav(to: string, replace = false) {
    if (to === location.pathname + location.search) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', to);
    const u = new URL(to, location.origin);
    this.path = u.pathname;
    this.search = u.search;
  }
}
export const router = new Router();
export const nav = (to: string, replace = false) => router.nav(to, replace);
