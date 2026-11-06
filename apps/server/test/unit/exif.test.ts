import { mkdtempSync, rmSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exifOrientation, tiffInExifBlock, withoutGps } from '../../src/lib/exif.js';
import { sniffImage, sniffImageFile } from '../../src/lib/image-sniff.js';
import { buildJpegFrom, jpegFrame, jpegSegment, REAL_IMAGES } from '../support/images.js';
import { REAL_LOCATED } from '../support/located-files.js';
import {
  buildExif,
  EXIF_PREFIX,
  jpegExifSegment,
  jpegWith,
  jpegXmpSegment,
  pngChunk,
  pngWith,
} from '../support/location-builders.js';

const dir = mkdtempSync(join(tmpdir(), 'hostile-exif-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const orientedJpeg = (orientation: number | null, little = false) =>
  jpegWith(jpegExifSegment(buildExif({ orientation, little, gps: false }).tiff));

describe('the orientation in EXIF', () => {
  it('reads each value, in each byte order, with and without the prefix', () => {
    for (const little of [true, false]) {
      for (let value = 1; value <= 8; value++) {
        const { tiff } = buildExif({ orientation: value, little });
        expect(exifOrientation(tiff)).toBe(value);
        expect(exifOrientation(Buffer.concat([EXIF_PREFIX, tiff]))).toBe(value);
      }
    }
  });

  it('is nothing when it is absent or does not mean an orientation', () => {
    expect(exifOrientation(buildExif({ orientation: null }).tiff)).toBeNull();
    expect(exifOrientation(buildExif({ orientation: 0 }).tiff)).toBeNull();
    expect(exifOrientation(buildExif({ orientation: 9 }).tiff)).toBeNull();
  });

  it('is nothing unless it is one SHORT, which is what Blink looks for', () => {
    const entry = 8 + 2 + 2 * 12;
    const notShort = Buffer.from(buildExif().tiff);
    notShort.writeUInt16BE(4, entry + 2);
    expect(exifOrientation(notShort)).toBeNull();
    const notOne = Buffer.from(buildExif().tiff);
    notOne.writeUInt32BE(2, entry + 4);
    expect(exifOrientation(notOne)).toBeNull();
  });

  it('never throws on what is not EXIF', () => {
    const { tiff } = buildExif();
    for (let length = 0; length < tiff.length; length++) {
      expect(() => exifOrientation(tiff.subarray(0, length))).not.toThrow();
    }
    expect(exifOrientation(Buffer.alloc(0))).toBeNull();
    expect(exifOrientation(Buffer.from('Exif\0', 'latin1'))).toBeNull();
    const pastTheEnd = Buffer.from(tiff);
    pastTheEnd.writeUInt32BE(0xfffffff0, 4);
    expect(exifOrientation(pastTheEnd)).toBeNull();
    const count = Buffer.from(tiff);
    count.writeUInt16BE(0xffff, 8);
    expect(exifOrientation(count)).toBe(6);
  });
});

describe('removing GPS', () => {
  it('is nothing to do when there is none, and says what is not a TIFF', () => {
    expect(withoutGps(buildExif({ gps: false }).tiff)).toBeNull();
    expect(withoutGps(Buffer.alloc(32, 0x41))).toBe('malformed');
    expect(withoutGps(Buffer.alloc(0))).toBe('malformed');
    const noDirectory = Buffer.from(buildExif().tiff);
    noDirectory.writeUInt32BE(0, 4);
    expect(withoutGps(noDirectory)).toBe('malformed');
  });

  it('does not change what it was given', () => {
    const { tiff } = buildExif();
    const before = Buffer.from(tiff);
    const after = withoutGps(tiff) as Buffer;
    expect(tiff.equals(before)).toBe(true);
    expect(after.equals(before)).toBe(false);
    expect(after.length).toBe(before.length);
  });

  it('leaves a TIFF that a reader can walk, with its next-directory link in the right place', () => {
    const out = withoutGps(buildExif().tiff) as Buffer;
    expect(out.readUInt16BE(8)).toBe(3);
    expect(out.readUInt32BE(8 + 2 + 3 * 12)).toBe(0);
    expect(out.subarray(8 + 2 + 3 * 12 + 4, 8 + 2 + 4 * 12 + 4).equals(Buffer.alloc(12))).toBe(
      true,
    );
  });

  it('finds where the TIFF starts in an EXIF block', () => {
    const { tiff } = buildExif();
    expect(tiffInExifBlock(tiff)).toBe(tiff);
    expect(tiffInExifBlock(Buffer.concat([EXIF_PREFIX, tiff])).equals(tiff)).toBe(true);
    expect(tiffInExifBlock(Buffer.from('Exif', 'latin1')).toString()).toBe('Exif');
  });
});

describe('the size recorded for a photo turned by its orientation', () => {
  const sized = (result: ReturnType<typeof sniffImage>) =>
    result.ok ? [result.width, result.height] : result;

  it('a JPEG is recorded as a browser draws it, for each orientation', () => {
    for (const little of [true, false]) {
      for (const value of [1, 2, 3, 4])
        expect(sized(sniffImage(orientedJpeg(value, little)))).toEqual([40, 20]);
      for (const value of [5, 6, 7, 8])
        expect(sized(sniffImage(orientedJpeg(value, little)))).toEqual([20, 40]);
    }
  });

  it('a PNG too, when its eXIf comes before the pixels', () => {
    const before = pngWith(40, 20, pngChunk('eXIf', buildExif({ orientation: 8 }).tiff));
    expect(sized(sniffImage(before))).toEqual([20, 40]);
  });

  it('a PNG with its eXIf after the pixels is drawn as stored: Chromium and WebKit both ignore it', () => {
    const { tiff } = buildExif({ orientation: 6 });
    const after = pngWith(40, 20);
    const iend = after.length - 12;
    const file = Buffer.concat([
      after.subarray(0, iend),
      pngChunk('eXIf', tiff),
      after.subarray(iend),
    ]);
    expect(sized(sniffImage(file))).toEqual([40, 20]);
  });

  it('a WebP keeps its raw size: Chromium ignores its orientation and WebKit obeys it', () => {
    expect(sized(sniffImage(REAL_LOCATED.pillowWebp.bytes))).toEqual([64, 32]);
  });

  it('real files from each writer come out as their browser draws them', () => {
    expect(sized(sniffImage(REAL_LOCATED.pillowJpeg.bytes))).toEqual([32, 64]);
    expect(sized(sniffImage(REAL_LOCATED.appleJpeg.bytes))).toEqual([32, 64]);
    expect(sized(sniffImage(REAL_LOCATED.pillowPng.bytes))).toEqual([32, 64]);
    expect(sized(sniffImage(REAL_LOCATED.applePng.bytes))).toEqual([32, 64]);
  });

  it('files with no orientation are as they were', () => {
    for (const image of Object.values(REAL_IMAGES)) {
      expect(sized(sniffImage(image.bytes))).toEqual([image.width, image.height]);
    }
  });

  it('a broken EXIF block is not a broken image', () => {
    const rubbish = jpegWith(
      jpegSegment(0xe1, Buffer.concat([EXIF_PREFIX, Buffer.alloc(40, 0x41)])),
    );
    expect(sized(sniffImage(rubbish))).toEqual([40, 20]);
    expect(sized(sniffImage(jpegWith(jpegSegment(0xe1))))).toEqual([40, 20]);
    expect(sized(sniffImage(jpegWith(jpegSegment(0xe1, Buffer.from('Exif\0', 'latin1')))))).toEqual(
      [40, 20],
    );
  });

  it('the first segment that gives an orientation is the one, and XMP does not count', () => {
    const first = jpegExifSegment(buildExif({ orientation: 1, gps: false }).tiff);
    const second = jpegExifSegment(buildExif({ orientation: 6, gps: false }).tiff);
    expect(sized(sniffImage(jpegWith(first, second)))).toEqual([40, 20]);
    expect(sized(sniffImage(jpegWith(second, first)))).toEqual([20, 40]);
    const xmp = jpegXmpSegment('<a tiff:Orientation="6"/>');
    expect(sized(sniffImage(jpegWith(xmp)))).toEqual([40, 20]);
    expect(sized(sniffImage(jpegWith(xmp, second)))).toEqual([20, 40]);
  });

  it('the frame header can come before or after it', () => {
    const exif = jpegExifSegment(buildExif({ orientation: 6, gps: false }).tiff);
    expect(sized(sniffImage(buildJpegFrom(jpegFrame(40, 20), exif)))).toEqual([20, 40]);
    expect(sized(sniffImage(buildJpegFrom(exif, jpegFrame(40, 20))))).toEqual([20, 40]);
  });

  it('the limit on an edge applies whichever way round it is', () => {
    const wide = buildJpegFrom(
      jpegExifSegment(buildExif({ orientation: 6, gps: false }).tiff),
      jpegFrame(5000, 10),
    );
    expect(sniffImage(wide, 4096)).toEqual({ ok: false, reason: 'too_many_pixels' });
  });

  it('a file on disk gets the same size, at the same cost to draw', async () => {
    const bytes = orientedJpeg(6);
    const path = join(dir, 'rotated.jpg');
    await writeFile(path, bytes);
    const file = await open(path, 'r');
    const result = await sniffImageFile(file, bytes.length, 'image/jpeg', 16_384);
    await file.close();
    expect(result).toEqual({
      ok: true,
      type: 'image/jpeg',
      width: 20,
      height: 40,
      cost: { canvasPixels: 800, animationPixels: 0 },
    });
  });
});
