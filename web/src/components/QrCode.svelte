<script lang="ts">
  import qrcode from 'qrcode-generator';
  let { text, size = 240 }: { text: string; size?: number } = $props();
  // Rounded dark modules on white: scans well from a phone held a few metres from a TV.
  const svg = $derived.by(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 0.08},${r + 0.08}h0.84v0.84h-0.84z`;
    return { n, d };
  });
</script>

<div class="qr" style:width="{size / 16}rem" style:height="{size / 16}rem">
  <svg viewBox="-2 -2 {svg.n + 4} {svg.n + 4}" role="img" aria-label="QR code"><rect x="-2" y="-2" width={svg.n + 4} height={svg.n + 4} rx="1.5" fill="#fff" /><path d={svg.d} fill="#0d0f12" /></svg>
</div>

<style>
  .qr { border-radius: 18px; overflow: hidden; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.1), 0 20px 60px -20px rgb(124 156 255 / 0.5); flex: none; }
  svg { display: block; width: 100%; height: 100%; }
</style>
