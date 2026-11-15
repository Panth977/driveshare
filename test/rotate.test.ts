import { describe, expect, it } from 'vitest';
import { jpegOrientation, setJpegOrientation, turn } from '../web/src/lib/rotate.ts';

// A minimal JPEG-shaped byte string: SOI, an APP0 (JFIF) segment, then SOS/EOI.
const jfif = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);

function withExif(little: boolean, orientation: number | null): Uint8Array {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) => (little ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const entries = orientation === null
    ? [[...u16(0x010f), ...u16(2), ...u32(4), 0x41, 0x42, 0x43, 0x00]] // Make = "ABC"
    : [[...u16(0x010f), ...u16(2), ...u32(4), 0x41, 0x42, 0x43, 0x00], [...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0]];
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(entries.length), ...entries.flat(), ...u32(0)];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...body, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
}

describe('rotate: EXIF orientation', () => {
  it('turns clockwise through 1 → 6 → 3 → 8 → 1', () => {
    expect(turn(1, 1)).toBe(6);
    expect(turn(6, 1)).toBe(3);
    expect(turn(3, 1)).toBe(8);
    expect(turn(8, 1)).toBe(1);
    expect(turn(1, 3)).toBe(8);
    expect(turn(6, -1)).toBe(1);
    expect(turn(2, 1)).toBeNull(); // mirrored: re-drawn instead
  });

  for (const little of [true, false]) {
    it(`edits the Orientation tag in place (${little ? 'little' : 'big'}-endian), keeping the rest`, () => {
      const src = withExif(little, 1);
      expect(jpegOrientation(src)).toBe(1);
      const out = setJpegOrientation(src, 6)!;
      expect(out.length).toBe(src.length);
      expect(jpegOrientation(out)).toBe(6);
      expect([...out].filter((v, i) => v !== src[i]).length).toBe(1);
    });
  }

  it('adds an EXIF block to a JPEG without one', () => {
    const out = setJpegOrientation(jfif, 8)!;
    expect(out.length).toBe(jfif.length + 36);
    expect(jpegOrientation(out)).toBe(8);
    expect([...out.subarray(out.length - jfif.length + 2)]).toEqual([...jfif.subarray(2)]);
  });

  it('gives up (null) on EXIF without an Orientation tag', () => {
    expect(setJpegOrientation(withExif(true, null), 6)).toBeNull();
    expect(jpegOrientation(withExif(true, null))).toBe(1);
  });
});
