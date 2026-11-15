// Rotating photos, saved back to Drive as a new version of the same file.
//
// JPEG (most photos): lossless. Only the EXIF Orientation tag changes; the picture data is not
// touched, so nothing is lost however often you rotate. PNG/WebP: re-drawn on a canvas and saved
// (PNG stays lossless). HEIC and others the browser cannot decode: not supported here.

/** EXIF orientation after turning the picture 90° clockwise `turns` times (mirrored ones: null). */
const CW: Record<number, number> = { 1: 6, 6: 3, 3: 8, 8: 1 };
export function turn(orientation: number, turns: number): number | null {
  let o = orientation || 1;
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) {
    const n = CW[o];
    if (!n) return null;
    o = n;
  }
  return o;
}

interface Exif { tiff: number; little: boolean; entry: number | null }

/** Find the EXIF block and its Orientation entry in a JPEG. */
function findExif(b: Uint8Array): Exif | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // image data starts: no more headers
    const len = (b[p + 2]! << 8) | b[p + 3]!;
    if (marker === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66 && b[p + 8] === 0 && b[p + 9] === 0) {
      const tiff = p + 10;
      const little = b[tiff] === 0x49;
      const u16 = (o: number) => (little ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);
      const u32 = (o: number) => (little ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 2 ** 24 : b[o]! * 2 ** 24 + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!));
      const ifd = tiff + u32(tiff + 4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x0112) return { tiff, little, entry: e };
      }
      return { tiff, little, entry: null };
    }
    p += 2 + len;
  }
  return null;
}

export function jpegOrientation(b: Uint8Array): number {
  const x = findExif(b);
  if (!x || x.entry === null) return 1;
  const o = x.entry + 8;
  return x.little ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!;
}

/**
 * The same JPEG with Orientation = `o`. Edits the tag in place, or adds a small EXIF block when the
 * file has none. Null when the file has EXIF without an Orientation tag (the caller re-draws instead).
 */
export function setJpegOrientation(b: Uint8Array, o: number): Uint8Array | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const x = findExif(b);
  if (x && x.entry !== null) {
    const out = b.slice();
    const at = x.entry + 8;
    if (x.little) { out[at] = o & 0xff; out[at + 1] = 0; } else { out[at] = 0; out[at + 1] = o & 0xff; }
    return out;
  }
  if (x) return null;
  // No EXIF at all: add APP1 "Exif" with one IFD entry (Orientation, SHORT) right after SOI.
  const app1 = new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, // marker, length 34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // TIFF big-endian, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o & 0xff, 0x00, 0x00, // Orientation SHORT 1 = o
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const out = new Uint8Array(b.length + app1.length);
  out.set(b.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(b.subarray(2), 2 + app1.length);
  return out;
}

/** Rotate `turns` × 90° clockwise. Returns the new file contents, or throws with a readable reason. */
export async function rotateBlob(blob: Blob, mime: string, turns: number): Promise<Blob> {
  const t = ((turns % 4) + 4) % 4;
  if (!t) return blob;
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const next = turn(jpegOrientation(bytes), t);
    const out = next ? setJpegOrientation(bytes, next) : null;
    if (out) return new Blob([out as BlobPart], { type: 'image/jpeg' });
  }
  if (!/^image\/(jpeg|jpg|png|webp)$/.test(mime)) throw new Error('This kind of picture cannot be rotated here (only JPEG, PNG and WebP).');
  // Re-draw (EXIF orientation is applied while decoding, so the result is upright pixels).
  const img = await createImageBitmap(blob);
  const side = t % 2 === 1;
  const c = new OffscreenCanvas(side ? img.height : img.width, side ? img.width : img.height);
  const g = c.getContext('2d')!;
  g.translate(c.width / 2, c.height / 2);
  g.rotate((t * Math.PI) / 2);
  g.drawImage(img, -img.width / 2, -img.height / 2);
  const type = mime === 'image/png' ? 'image/png' : mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
  return c.convertToBlob({ type, quality: 0.95 });
}
