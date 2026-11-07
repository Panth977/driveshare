import { describe, expect, it } from 'vitest';
import { CHUNK, cleanName, formatBytes, hasScope, nextOffset, parseBytes, room } from '../backend/shared.ts';

describe('shared helpers', () => {
  it('reads and prints sizes', () => {
    expect(parseBytes('15 GB')).toBe(15 * 1024 ** 3);
    expect(parseBytes('1.5tb')).toBe(Math.round(1.5 * 1024 ** 4));
    expect(parseBytes('500 MiB')).toBe(500 * 1024 ** 2);
    expect(parseBytes('12')).toBe(12);
    expect(parseBytes('lots')).toBeNaN();
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.0 TB');
  });
  it('room under the cap never goes negative', () => {
    expect(room(100, 30, 20)).toBe(50);
    expect(room(100, 90, 20)).toBe(0);
  });
  it('resumes from the Range Drive reports', () => {
    expect(nextOffset('bytes=0-262143', 0)).toBe(262144);
    expect(nextOffset(null, CHUNK)).toBe(CHUNK);
    expect(CHUNK % (256 * 1024)).toBe(0);
  });
  it('scope checks', () => {
    expect(hasScope('openid https://www.googleapis.com/auth/drive.file', 'file')).toBe(true);
    expect(hasScope('openid https://www.googleapis.com/auth/drive.file', 'full')).toBe(false);
    expect(hasScope('https://www.googleapis.com/auth/drive', 'file')).toBe(true);
  });
  it('folder names stay on one line', () => {
    expect(cleanName('  a\nb ')).toBe('a b');
    expect(cleanName('')).toBe('Untitled');
  });
});
