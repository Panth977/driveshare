// One toast at a time, optionally with an action (Undo).
class Toast {
  text = $state('');
  action = $state<{ label: string; run: () => void } | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  show(text: string, action?: { label: string; run: () => void }, ms = 5000) {
    this.text = text;
    this.action = action ?? null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), ms);
  }
  hide() { this.text = ''; this.action = null; }
}
export const toast = new Toast();
