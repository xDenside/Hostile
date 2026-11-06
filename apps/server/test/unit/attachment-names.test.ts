import { LIMITS } from '@hostile/shared';
import { describe, expect, it } from 'vitest';
import {
  clampDimension,
  inlineDisposition,
  nameMatchingType,
  sanitizeFileName,
} from '../../src/media/attachments.js';

describe('sanitizeFileName', () => {
  it('leaves an ordinary name alone', () => {
    expect(sanitizeFileName('holiday photo (2).JPG')).toBe('holiday photo (2).JPG');
    expect(sanitizeFileName('Отчёт за год.png')).toBe('Отчёт за год.png');
    expect(sanitizeFileName('🎉 party.mp4')).toBe('🎉 party.mp4');
  });

  it('keeps only the last part of a path, in either direction', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\me\\cat.png')).toBe('cat.png');
    expect(sanitizeFileName('a/b\\c/d.gif')).toBe('d.gif');
  });

  it('removes control characters, including ones that would hide a separator', () => {
    expect(sanitizeFileName('ca\u0000t\r\n.png')).toBe('cat.png');
    expect(sanitizeFileName('a/\u0000b.png')).toBe('b.png');
    expect(sanitizeFileName('\u007fcat\u0085.png')).toBe('cat.png');
  });

  it('removes what reorders text, so gpj.exe cannot pass for exe.jpg', () => {
    expect(sanitizeFileName('cat\u202Egnp.exe')).toBe('catgnp.exe');
    expect(sanitizeFileName('a\u2066b\u2069\u200f.png')).toBe('ab.png');
  });

  it('removes leading dots and trailing dots and spaces', () => {
    expect(sanitizeFileName('.htaccess')).toBe('htaccess');
    expect(sanitizeFileName('  cat.png. . ')).toBe('cat.png');
  });

  it('gives up when nothing is left, or nothing was there', () => {
    for (const raw of ['', '   ', '.', '..', '../..', '/', '\\', '\u0000\u0001', 'a/', 'b\\']) {
      expect(sanitizeFileName(raw), JSON.stringify(raw)).toBeNull();
    }
    for (const raw of [undefined, null, 7, ['a.png', 'b.png'], { name: 'a.png' }]) {
      expect(sanitizeFileName(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('bounds the length and keeps the extension', () => {
    const name = sanitizeFileName(`${'x'.repeat(500)}.jpeg`)!;
    expect(name).toHaveLength(LIMITS.attachmentFileNameMax);
    expect(name.endsWith('.jpeg')).toBe(true);
    expect(sanitizeFileName('x'.repeat(500))).toHaveLength(LIMITS.attachmentFileNameMax);
  });

  it('does not count an emoji as two, or cut one in half', () => {
    const name = sanitizeFileName('🎉'.repeat(500))!;
    expect(Array.from(name)).toHaveLength(LIMITS.attachmentFileNameMax);
    expect(name).toBe('🎉'.repeat(LIMITS.attachmentFileNameMax));
    const fits = '🎉'.repeat(LIMITS.attachmentFileNameMax);
    expect(sanitizeFileName(fits)).toBe(fits);
  });
});

describe('clampDimension', () => {
  it('takes whole numbers in range', () => {
    expect(clampDimension('1')).toBe(1);
    expect(clampDimension('1920')).toBe(1920);
  });

  it('rounds and clamps', () => {
    expect(clampDimension('1920.4')).toBe(1920);
    expect(clampDimension(String(LIMITS.attachmentMaxEdge + 1))).toBe(LIMITS.attachmentMaxEdge);
    expect(clampDimension('1e12')).toBe(LIMITS.attachmentMaxEdge);
  });

  it('ignores anything that is not a size', () => {
    for (const raw of ['', '0', '-5', '0.5', 'abc', 'NaN', 'Infinity', '1920px']) {
      expect(clampDimension(raw), raw).toBeNull();
    }
    for (const raw of [undefined, null, 1920, ['1920']]) {
      expect(clampDimension(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('nameMatchingType', () => {
  it('leaves a name that already says what the file is', () => {
    expect(nameMatchingType('cat.png', 'image/png')).toBe('cat.png');
    expect(nameMatchingType('CAT.JPEG', 'image/jpeg')).toBe('CAT.JPEG');
    expect(nameMatchingType('photo.jpg', 'image/jpeg')).toBe('photo.jpg');
    expect(nameMatchingType('clip.MOV', 'video/quicktime')).toBe('clip.MOV');
  });

  it('ends a misleading name in what the file really is', () => {
    expect(nameMatchingType('evil.html', 'image/png')).toBe('evil.html.png');
    expect(nameMatchingType('run.exe', 'video/mp4')).toBe('run.exe.mp4');
    expect(nameMatchingType('photo.png', 'image/jpeg')).toBe('photo.png.jpg');
  });

  it('gives a name with no extension one', () => {
    expect(nameMatchingType('screenshot', 'image/webp')).toBe('screenshot.webp');
    expect(nameMatchingType('Отчёт', 'video/webm')).toBe('Отчёт.webm');
  });

  it('stays within the length limit, counted in characters', () => {
    const name = nameMatchingType('é'.repeat(LIMITS.attachmentFileNameMax), 'image/png');
    expect(Array.from(name)).toHaveLength(LIMITS.attachmentFileNameMax);
    expect(name.endsWith('.png')).toBe(true);
  });
});

describe('inlineDisposition', () => {
  it('states a plain name twice', () => {
    expect(inlineDisposition('cat.png')).toBe(
      `inline; filename="cat.png"; filename*=UTF-8''cat.png`,
    );
  });

  it('cannot be broken out of with quotes, backslashes or a line break', () => {
    const header = inlineDisposition('a"b\\c\r\nX-Evil: 1.png');
    expect(header).toBe(
      `inline; filename="a_b_c__X-Evil: 1.png"; filename*=UTF-8''a%22b%5Cc%0D%0AX-Evil%3A%201.png`,
    );
    expect(header).toMatch(/^[\x20-\x7e]+$/);
  });

  it('carries a name that is not ASCII in the extended form only', () => {
    const header = inlineDisposition('Отчёт 100%.png');
    expect(header).toBe(
      `inline; filename="_____ 100_.png"; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82%20100%25.png`,
    );
    expect(decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(header)![1]!)).toBe('Отчёт 100%.png');
  });

  it('encodes the characters RFC 5987 forbids that encodeURIComponent leaves', () => {
    expect(inlineDisposition("it's(1)*.png")).toContain(`UTF-8''it%27s%281%29%2A.png`);
  });

  it('does not throw on a lone surrogate', () => {
    expect(() => inlineDisposition('a\ud800b.png')).not.toThrow();
  });
});
