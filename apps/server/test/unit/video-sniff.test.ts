import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sniffVideo, VIDEO_SNIFF_BYTES } from '../../src/lib/video-sniff.js';
import { REAL_IMAGES } from '../support/images.js';
import { buildFtyp, REAL_MATROSKA, REAL_OLD_QUICKTIME, REAL_VIDEOS } from '../support/videos.js';

const ebml = (...elements: Buffer[]) => {
  const body = Buffer.concat(elements);
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length]), body]);
};
const docType = (name: string) =>
  Buffer.concat([Buffer.from([0x42, 0x82, 0x80 | name.length]), Buffer.from(name, 'latin1')]);
const EBML_VERSION = Buffer.from([0x42, 0x86, 0x81, 0x01]);

describe('files from a real encoder', () => {
  for (const [name, video] of Object.entries(REAL_VIDEOS)) {
    it(`reads ${name}`, () => {
      expect(sniffVideo(video.bytes)).toBe(video.type);
      expect(sniffVideo(video.bytes.subarray(0, VIDEO_SNIFF_BYTES))).toBe(video.type);
    });
  }

  it('turns down Matroska, which is the same container as WebM', () => {
    expect(sniffVideo(REAL_MATROSKA)).toBeNull();
  });

  it('takes none of the images for a video', () => {
    for (const [name, image] of Object.entries(REAL_IMAGES))
      expect(sniffVideo(image.bytes), name).toBeNull();
  });
});

describe('QuickTime with no file type box', () => {
  const box = (type: string, size = 8) => {
    const out = Buffer.alloc(size);
    out.writeUInt32BE(size);
    out.write(type, 4, 'latin1');
    return out;
  };

  for (const [name, bytes] of Object.entries(REAL_OLD_QUICKTIME)) {
    it(`reads a real file laid out that way: ${name}`, () => {
      expect(sniffVideo(bytes)).toBe('video/quicktime');
      expect(bytes.toString('latin1', 4, 8)).not.toBe('ftyp');
    });
  }

  it('looks past padding of any length to the movie or its data', () => {
    expect(sniffVideo(box('mdat'))).toBe('video/quicktime');
    expect(sniffVideo(box('moov'))).toBe('video/quicktime');
    const padded = Buffer.concat([box('free', 64), box('skip'), box('wide'), box('pnot', 20)]);
    expect(sniffVideo(Buffer.concat([padded, box('mdat')]))).toBe('video/quicktime');
  });

  it('turns down padding with nothing after it, or something else after it', () => {
    expect(sniffVideo(box('free'))).toBeNull();
    expect(sniffVideo(Buffer.concat([box('wide'), box('idat')]))).toBeNull();
    expect(sniffVideo(Buffer.concat([box('free'), Buffer.from('<html><body>hello')]))).toBeNull();
  });

  it('turns down a box that would not move on, and a plain word in the right place', () => {
    const stuck = box('free');
    stuck.writeUInt32BE(4);
    expect(sniffVideo(Buffer.concat([stuck, box('mdat')]))).toBeNull();
    expect(sniffVideo(Buffer.from('this is free text, and long enough to walk'))).toBeNull();
  });

  it('still turns down an audio or image brand, which does have the box', () => {
    for (const brand of ['M4A ', 'heic', 'avif'])
      expect(sniffVideo(Buffer.concat([buildFtyp(brand), box('mdat')])), brand).toBeNull();
  });
});

describe('ISO BMFF', () => {
  it('reads the major brand', () => {
    expect(sniffVideo(buildFtyp('qt  '))).toBe('video/quicktime');
    for (const brand of ['isom', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'XAVC'])
      expect(sniffVideo(buildFtyp(brand)), brand).toBe('video/mp4');
  });

  it('turns down the still images and audio that use the same box', () => {
    for (const brand of ['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B '])
      expect(sniffVideo(buildFtyp(brand)), brand).toBeNull();
  });

  it('turns down a box that is not one', () => {
    const tooShort = buildFtyp('isom');
    tooShort.writeUInt32BE(8);
    expect(sniffVideo(tooShort)).toBeNull();
    expect(sniffVideo(buildFtyp('isom').subarray(0, 15))).toBeNull();
    const elsewhere = buildFtyp('isom');
    elsewhere.write('idat', 4, 'latin1');
    expect(sniffVideo(elsewhere)).toBeNull();
  });
});

describe('EBML', () => {
  it('finds the DocType after other elements', () => {
    expect(sniffVideo(ebml(EBML_VERSION, EBML_VERSION, docType('webm')))).toBe('video/webm');
  });

  it('takes a DocType padded with NUL bytes', () => {
    expect(sniffVideo(ebml(docType('webm\0\0')))).toBe('video/webm');
  });

  it('takes a size written in more bytes than it needs', () => {
    const padded = Buffer.concat([
      Buffer.from([0x42, 0x82, 0x01, 0, 0, 0, 0, 0, 0, 4]),
      Buffer.from('webm', 'latin1'),
    ]);
    expect(sniffVideo(ebml(padded))).toBe('video/webm');
  });

  it('turns down any other DocType, or none', () => {
    expect(sniffVideo(ebml(docType('matroska')))).toBeNull();
    expect(sniffVideo(ebml(docType('webmx')))).toBeNull();
    expect(sniffVideo(ebml(EBML_VERSION))).toBeNull();
    expect(sniffVideo(ebml())).toBeNull();
  });

  it('turns down the magic bytes alone, or a DocType running off the end', () => {
    expect(sniffVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBeNull();
    const cut = ebml(docType('webm')).subarray(0, -2);
    expect(sniffVideo(cut)).toBeNull();
  });

  it('turns down a variable-length integer with no length', () => {
    expect(sniffVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x42, 0x82]))).toBeNull();
    expect(sniffVideo(ebml(Buffer.from([0x00, 0x81, 0x01])))).toBeNull();
  });
});

describe('anything at all', () => {
  it('never throws, and always ends', () => {
    for (let i = 0; i < 2_000; i++) {
      const noise = randomBytes(i % 64);
      expect(() => sniffVideo(noise)).not.toThrow();
      const header = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), noise]);
      expect(() => sniffVideo(header)).not.toThrow();
      const box = Buffer.concat([Buffer.alloc(4, 0xff), Buffer.from('ftyp', 'latin1'), noise]);
      expect(() => sniffVideo(box)).not.toThrow();
    }
    expect(sniffVideo(Buffer.alloc(0))).toBeNull();
  });

  it('is not fooled by text', () => {
    for (const text of ['<!doctype html><script>', '<svg xmlns="x"/>', 'ftyp ftyp ftyp ftyp'])
      expect(sniffVideo(Buffer.from(text)), text).toBeNull();
  });
});
