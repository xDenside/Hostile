import { mkdtempSync, rmSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@hostile/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ANIMATION_PIXELS_MAX,
  decodeRefusal,
  detectImageType,
  sniffImage,
  sniffImageFile,
} from '../../src/lib/image-sniff.js';
import {
  buildAnimatedWebp,
  buildApng,
  buildBlankPng,
  buildGif,
  buildJpeg,
  buildJpegFrom,
  buildPng,
  buildWebp,
  jpegFrame,
  jpegSegment,
  REAL_APNG,
  REAL_GIF_THREE_FRAMES,
  REAL_IMAGES,
  vp8Chunk,
  vp8lChunk,
  vp8xChunk,
} from '../support/images.js';

const MAX = LIMITS.profileImageMaxEdge;
const rejected = (reason: string) => ({ ok: false, reason });

describe('files from real encoders', () => {
  for (const [name, image] of Object.entries(REAL_IMAGES)) {
    it(`reads ${name}`, () => {
      expect(sniffImage(image.bytes)).toEqual({
        ok: true,
        type: image.type,
        width: image.width,
        height: image.height,
      });
    });
  }
});

describe('what a chat image may cost to draw', () => {
  const MiB = 1024 * 1024;
  const still = (width: number, height: number) => ({
    canvasPixels: width * height,
    animationPixels: 0,
  });

  const fine: [string, number, number, number][] = [
    ['4K screenshot of a nearly blank page, from Chromium', 3840, 2160, 36_000],
    ['5K screenshot of a nearly blank page, from Chromium', 5120, 2880, 53_000],
    ['8K screenshot of a nearly blank page, from Chromium', 7680, 4320, 108_000],
    ['4K of one colour, RGBA, zlib level 9', 3840, 2160, 34_000],
    ['8K of one colour, RGBA, zlib level 9', 7680, 4320, 132_000],
    ['4K of one colour, one bit a pixel, zlib level 9', 3840, 2160, 1_100],
    ['8K of one colour, one bit a pixel, zlib level 9', 7680, 4320, 4_000],
    ['48 MP photo, JPEG quality 30, from sips', 8000, 6000, 1.53 * MiB],
    ['48 MP photo, JPEG quality 80, from sips', 8000, 6000, 4.44 * MiB],
    ['200 MP photo, JPEG quality 25, from sips', 16_320, 12_240, 4.56 * MiB],
    ['200 MP photo, JPEG quality 60, from sips', 16_320, 12_240, 8.68 * MiB],
  ];
  for (const [name, width, height, bytes] of fine) {
    it(`passes ${name}`, () => {
      expect(decodeRefusal(still(width, height), bytes)).toBeNull();
    });
  }

  it('refuses the largest image from anything but a large file', () => {
    const edge = LIMITS.attachmentMaxEdge;
    expect(decodeRefusal(still(edge, edge), 33_000)).toBe('memory');
    expect(decodeRefusal(still(edge, edge), 1_040_000)).toBe('memory');
    expect(decodeRefusal(still(edge, edge), 5 * MiB)).toBe('memory');
    expect(decodeRefusal(still(edge, edge), 6 * MiB)).toBeNull();
  });

  it('gives everything up to an 8K screen away, and charges for the first pixel past it', () => {
    expect(decodeRefusal({ canvasPixels: 33_554_432, animationPixels: 0 }, 0)).toBeNull();
    expect(decodeRefusal({ canvasPixels: 33_554_433, animationPixels: 0 }, 0)).toBe('memory');
    expect(decodeRefusal({ canvasPixels: 33_554_433, animationPixels: 0 }, 1)).toBeNull();
  });

  it('holds a real GIF of 1080p footage well inside the limit on an animation', () => {
    expect(
      decodeRefusal({ canvasPixels: 1920 * 1080, animationPixels: 1_157_000_000 }, 43 * MiB),
    ).toBeNull();
    expect(
      decodeRefusal({ canvasPixels: 100, animationPixels: ANIMATION_PIXELS_MAX }, 100),
    ).toBeNull();
    expect(
      decodeRefusal({ canvasPixels: 100, animationPixels: ANIMATION_PIXELS_MAX + 1 }, 100),
    ).toBe('animation');
  });

  it('leaves avatars and banners as they were: their walk returns no cost and refuses nothing new', () => {
    const edge = LIMITS.profileImageMaxEdge;
    for (const bytes of [
      buildBlankPng(edge, edge),
      buildApng(
        edge,
        edge,
        Array.from({ length: 300 }, () => [edge, edge]),
      ),
      buildAnimatedWebp(
        edge,
        edge,
        Array.from({ length: 300 }, () => [edge, edge]),
      ),
    ]) {
      expect(sniffImage(bytes)).toEqual({
        ok: true,
        type: detectImageType(bytes),
        width: edge,
        height: edge,
      });
    }
  });
});

describe('every format', () => {
  const makers: [string, (width: number, height: number) => Buffer][] = [
    ['png', buildPng],
    ['jpeg', buildJpeg],
    ['gif', buildGif],
    ['webp vp8', (w, h) => buildWebp('VP8 ', vp8Chunk(w, h))],
    ['webp vp8l', (w, h) => buildWebp('VP8L', vp8lChunk(w, h))],
    ['webp vp8x', (w, h) => buildWebp('VP8X', vp8xChunk(w, h))],
  ];

  for (const [name, make] of makers) {
    it(`${name}: accepts an edge at the limit and refuses one past it`, () => {
      expect(sniffImage(make(MAX, MAX))).toMatchObject({ ok: true, width: MAX, height: MAX });
      expect(sniffImage(make(MAX + 1, 1))).toEqual(rejected('too_many_pixels'));
      expect(sniffImage(make(1, MAX + 1))).toEqual(rejected('too_many_pixels'));
    });
  }

  for (const [name, make] of makers.filter(([n]) => n !== 'webp vp8l' && n !== 'webp vp8x')) {
    it(`${name}: refuses zero dimensions`, () => {
      expect(sniffImage(make(0, 10))).toEqual(rejected('corrupt'));
      expect(sniffImage(make(10, 0))).toEqual(rejected('corrupt'));
    });
  }
});

describe('files that are not images', () => {
  const notImages: [string, string][] = [
    ['HTML named as a GIF', '<!doctype html><script>alert(1)</script>'],
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ['SVG with an XML prolog', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['plain text', 'hello there'],
    ['an empty file', ''],
    ['almost a GIF', 'GIF88a'],
    ['RIFF that is not WebP', 'RIFF\u0004\u0000\u0000\u0000WAVE'],
  ];
  for (const [name, content] of notImages) {
    it(`refuses ${name}`, () => {
      expect(sniffImage(Buffer.from(content, 'latin1'))).toEqual(rejected('unsupported'));
    });
  }

  it('refuses a script that starts with GIF magic, the classic polyglot', () => {
    const polyglot = Buffer.from('GIF89a/*\x00\x00*/=1;alert(document.domain);//', 'latin1');
    expect(sniffImage(polyglot)).toEqual(rejected('corrupt'));
  });
});

describe('truncated files', () => {
  for (const [name, image] of Object.entries(REAL_IMAGES)) {
    it(`refuses every strict prefix of ${name}`, () => {
      for (let length = 0; length < image.bytes.length; length++) {
        const result = sniffImage(image.bytes.subarray(0, length));
        expect(result.ok, `${name} cut to ${length} bytes`).toBe(false);
      }
    });
  }
});

describe('PNG', () => {
  it('refuses a first chunk that is not IHDR', () => {
    const png = buildPng(10, 10);
    png.write('IDAT', 12, 'latin1');
    expect(sniffImage(png)).toEqual(rejected('corrupt'));
  });

  it('refuses a chunk claiming to run past the end of the file', () => {
    const png = buildPng(10, 10);
    png.writeUInt32BE(0xffffffff, 8 + 8 + 13 + 4);
    expect(sniffImage(png)).toEqual(rejected('corrupt'));
  });

  it('refuses a header claiming billions of pixels', () => {
    expect(sniffImage(buildPng(0xffffffff, 0xffffffff))).toEqual(rejected('too_many_pixels'));
  });
});

describe('JPEG', () => {
  const soi = Buffer.from([0xff, 0xd8]);

  it('sizes the real image, not a thumbnail inside an APP segment', () => {
    const thumbnail = jpegFrame(60000, 60000);
    const withBigThumbnail = buildJpegFrom(jpegSegment(0xe1, thumbnail), jpegFrame(10, 20));
    expect(sniffImage(withBigThumbnail)).toMatchObject({ ok: true, width: 10, height: 20 });

    const hiddenBehindSmallThumbnail = buildJpegFrom(
      jpegSegment(0xe1, jpegFrame(10, 10)),
      jpegFrame(60000, 60000),
    );
    expect(sniffImage(hiddenBehindSmallThumbnail)).toEqual(rejected('too_many_pixels'));
  });

  it('reads the progressive and other start-of-frame markers, not the lookalikes', () => {
    for (const marker of [0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcd, 0xcf]) {
      const frame = jpegFrame(5, 6);
      frame[1] = marker;
      expect(sniffImage(buildJpegFrom(frame)), `marker ${marker}`).toMatchObject({
        ok: true,
        width: 5,
        height: 6,
      });
    }
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      const notAFrame = jpegFrame(5, 6);
      notAFrame[1] = marker;
      expect(sniffImage(buildJpegFrom(notAFrame)), `marker ${marker}`).toEqual(rejected('corrupt'));
    }
  });

  it('accepts fill bytes and standalone markers between segments', () => {
    const fill = Buffer.from([0xff, 0xff, 0xff, 0x01, 0xff, 0xd0]);
    expect(sniffImage(buildJpegFrom(fill, jpegFrame(7, 8)))).toMatchObject({ ok: true, width: 7 });
  });

  it('refuses a second frame header, which decoders refuse too', () => {
    expect(sniffImage(buildJpegFrom(jpegFrame(10, 10), jpegFrame(4000, 4000)))).toEqual(
      rejected('corrupt'),
    );
  });

  describe('hostile segment lengths', () => {
    const withLength = (length: number) =>
      Buffer.concat([soi, Buffer.from([0xff, 0xe1, length >> 8, length & 0xff]), Buffer.alloc(16)]);

    for (const length of [0, 1]) {
      it(`refuses a segment of length ${length} instead of looping`, () => {
        expect(sniffImage(withLength(length))).toEqual(rejected('corrupt'));
      });
    }

    it('refuses a segment running past the end of the file', () => {
      expect(sniffImage(withLength(0xffff))).toEqual(rejected('corrupt'));
    });

    it('refuses a frame header too short to hold a size', () => {
      expect(sniffImage(buildJpegFrom(jpegSegment(0xc0, Buffer.alloc(3))))).toEqual(
        rejected('corrupt'),
      );
    });

    it('refuses a frame header cut off inside its length', () => {
      expect(sniffImage(Buffer.concat([soi, Buffer.from([0xff, 0xc0, 0x00])]))).toEqual(
        rejected('corrupt'),
      );
    });
  });

  it('walks a file of nothing but markers and ends without a size', () => {
    const fillOnly = Buffer.concat([soi, Buffer.alloc(LIMITS.avatarMaxBytes, 0xff)]);
    expect(sniffImage(fillOnly)).toEqual(rejected('corrupt'));
    const standaloneOnly = Buffer.alloc(LIMITS.avatarMaxBytes);
    for (let i = 0; i < standaloneOnly.length; i += 2) {
      standaloneOnly[i] = 0xff;
      standaloneOnly[i + 1] = 0xd0;
    }
    standaloneOnly[1] = 0xd8;
    expect(sniffImage(standaloneOnly)).toEqual(rejected('corrupt'));
  });

  it('refuses scan data or an end marker before any frame header', () => {
    const scanFirst = buildJpegFrom();
    expect(sniffImage(scanFirst)).toEqual(rejected('corrupt'));
    expect(sniffImage(Buffer.concat([soi, Buffer.from([0xff, 0xd9])]))).toEqual(
      rejected('corrupt'),
    );
  });

  it('refuses a marker slot holding something that is not a marker', () => {
    const app0 = jpegSegment(0xe0, Buffer.from('JFIF\0', 'latin1'));
    const garbage = Buffer.concat([soi, app0, Buffer.from([0x41, 0x42, 0x43, 0x44])]);
    expect(sniffImage(garbage)).toEqual(rejected('corrupt'));
    const escaped = Buffer.concat([soi, app0, Buffer.from([0xff, 0x00])]);
    expect(sniffImage(escaped)).toEqual(rejected('corrupt'));
  });

  it('refuses a file whose scan never reaches an end marker', () => {
    const jpeg = buildJpeg(10, 10);
    expect(sniffImage(jpeg.subarray(0, jpeg.length - 2))).toEqual(rejected('corrupt'));
  });

  it('does not take an end marker inside a thumbnail as the end of the file', () => {
    const thumbnail = jpegSegment(0xe1, Buffer.from([0xff, 0xd9]));
    const jpeg = buildJpegFrom(thumbnail, jpegFrame(10, 10));
    expect(sniffImage(jpeg.subarray(0, jpeg.length - 2))).toEqual(rejected('corrupt'));
  });
});

describe('GIF', () => {
  it('refuses an oversized header', () => {
    expect(sniffImage(buildGif(65535, 65535))).toEqual(rejected('too_many_pixels'));
  });

  it('refuses a small screen smuggling in an oversized frame', () => {
    const smuggler = buildGif(1, 1, [{ width: 65535, height: 65535 }]);
    expect(sniffImage(smuggler)).toEqual(rejected('too_many_pixels'));
  });

  it('counts where a frame ends, not just how big it is', () => {
    const offset = buildGif(1, 1, [{ left: MAX, top: 0, width: 1, height: 1 }]);
    expect(sniffImage(offset)).toEqual(rejected('too_many_pixels'));
  });

  it('checks every frame, not only the first', () => {
    const late = buildGif(10, 10, [
      { width: 10, height: 10 },
      { width: MAX + 1, height: 10 },
    ]);
    expect(sniffImage(late)).toEqual(rejected('too_many_pixels'));
  });

  it('reports the logical screen as the size', () => {
    expect(sniffImage(buildGif(10, 20, [{ width: 5, height: 5 }]))).toMatchObject({
      ok: true,
      width: 10,
      height: 20,
    });
  });

  it('refuses a file with no frames in it', () => {
    expect(sniffImage(buildGif(10, 10, []))).toEqual(rejected('corrupt'));
  });

  it('refuses a color table claiming to run past the end of the file', () => {
    const gif = buildGif(10, 10);
    gif[10] = 0x87;
    expect(sniffImage(gif)).toEqual(rejected('corrupt'));
  });

  it('refuses a sub-block claiming to run past the end of the file', () => {
    const gif = buildGif(10, 10);
    gif[gif.length - 5] = 0xff;
    expect(sniffImage(gif)).toEqual(rejected('corrupt'));
  });

  it('refuses a block type it does not know', () => {
    const gif = buildGif(10, 10);
    gif[13] = 0x99;
    expect(sniffImage(gif)).toEqual(rejected('corrupt'));
  });
});

describe('WebP', () => {
  it('ignores the scaling bits above a VP8 dimension', () => {
    const scaled = buildWebp('VP8 ', vp8Chunk(10 | 0x4000, 20 | 0xc000));
    expect(sniffImage(scaled)).toMatchObject({ ok: true, width: 10, height: 20 });
  });

  it('refuses a RIFF size claiming more than the file holds', () => {
    expect(sniffImage(buildWebp('VP8 ', vp8Chunk(1, 1), 0xfffffff0))).toEqual(rejected('corrupt'));
  });

  it('refuses a chunk larger than the RIFF that holds it', () => {
    const webp = buildWebp('VP8 ', vp8Chunk(1, 1));
    webp.writeUInt32LE(0xffffff00, 16);
    expect(sniffImage(webp)).toEqual(rejected('corrupt'));
  });

  it('refuses a VP8 frame with a bad start code, or one that is not a key frame', () => {
    const badStart = vp8Chunk(1, 1);
    badStart[3] = 0;
    expect(sniffImage(buildWebp('VP8 ', badStart))).toEqual(rejected('corrupt'));
    const interFrame = vp8Chunk(1, 1);
    interFrame[0]! |= 1;
    expect(sniffImage(buildWebp('VP8 ', interFrame))).toEqual(rejected('corrupt'));
  });

  it('refuses a VP8L chunk with a bad signature or an unknown version', () => {
    const badSignature = vp8lChunk(1, 1);
    badSignature[0] = 0;
    expect(sniffImage(buildWebp('VP8L', badSignature))).toEqual(rejected('corrupt'));
    const badVersion = vp8lChunk(1, 1);
    badVersion[4]! |= 0x20;
    expect(sniffImage(buildWebp('VP8L', badVersion))).toEqual(rejected('corrupt'));
  });

  it('refuses chunks too short to hold a size', () => {
    expect(sniffImage(buildWebp('VP8 ', Buffer.alloc(4)))).toEqual(rejected('corrupt'));
    expect(sniffImage(buildWebp('VP8L', Buffer.from([0x2f, 0])))).toEqual(rejected('corrupt'));
    expect(sniffImage(buildWebp('VP8X', Buffer.alloc(4)))).toEqual(rejected('corrupt'));
  });

  it('refuses a first chunk it does not know', () => {
    expect(sniffImage(buildWebp('VP9 ', vp8Chunk(1, 1)))).toEqual(rejected('corrupt'));
  });
});

describe('arbitrary damage', () => {
  function prng(seed: number) {
    let state = seed;
    return (bound: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % bound;
    };
  }

  it('never throws on a damaged file, and never passes one over the limit', () => {
    const next = prng(20261103);
    const seeds = Object.values(REAL_IMAGES).map((image) => image.bytes);
    for (let round = 0; round < 5000; round++) {
      const damaged = Buffer.from(seeds[next(seeds.length)]!);
      const flips = 1 + next(8);
      for (let i = 0; i < flips; i++) damaged[next(damaged.length)] = next(256);
      const file = next(4) === 0 ? damaged.subarray(0, next(damaged.length)) : damaged;

      const result = sniffImage(file);
      if (result.ok) {
        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);
        expect(result.width).toBeLessThanOrEqual(MAX);
        expect(result.height).toBeLessThanOrEqual(MAX);
      }
    }
  });
});

describe('from a file on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostile-sniff-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function sniffFromDisk(bytes: Buffer, maxEdge: number) {
    const path = join(dir, 'file');
    await writeFile(path, bytes);
    const file = await open(path, 'r');
    try {
      return await sniffImageFile(file, bytes.length, detectImageType(bytes)!, maxEdge);
    } finally {
      await file.close();
    }
  }

  const expectSameVerdict = async (bytes: Buffer, maxEdge = MAX) => {
    const fromDisk = await sniffFromDisk(bytes, maxEdge);
    if (fromDisk.ok) {
      const { cost: _cost, ...verdict } = fromDisk;
      expect(verdict).toEqual(sniffImage(bytes, maxEdge));
    } else {
      expect(fromDisk).toEqual(sniffImage(bytes, maxEdge));
    }
  };

  for (const [name, image] of Object.entries(REAL_IMAGES)) {
    it(`reads ${name}`, async () => {
      expect(await sniffFromDisk(image.bytes, MAX)).toMatchObject({
        ok: true,
        type: image.type,
        width: image.width,
        height: image.height,
      });
    });
  }

  describe('what it would cost to draw', () => {
    const EDGE = LIMITS.attachmentMaxEdge;
    const costOf = async (bytes: Buffer) => {
      const verdict = await sniffFromDisk(bytes, EDGE);
      if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);
      return verdict.cost;
    };

    it('a still image is its own width and height, and no animation', async () => {
      const { width, height, bytes } = REAL_IMAGES.png;
      expect(await costOf(bytes)).toEqual({ canvasPixels: width * height, animationPixels: 0 });
      expect((await costOf(buildPng(800, 600))).canvasPixels).toBe(480_000);
      expect((await costOf(buildJpeg(800, 600))).canvasPixels).toBe(480_000);
    });

    it('counts the frames of animations from real encoders', async () => {
      expect(await costOf(REAL_APNG)).toEqual({ canvasPixels: 64, animationPixels: 66 });
      expect(await costOf(REAL_GIF_THREE_FRAMES)).toEqual({
        canvasPixels: 64,
        animationPixels: 66,
      });
      const webp = await costOf(REAL_IMAGES.webpAnimated.bytes);
      expect(webp.canvasPixels).toBe(37 * 11);
      expect(webp.animationPixels).toBe(2 * 37 * 11);
    });

    it('takes a frame that grows a GIF past its header for the canvas it makes', async () => {
      const grown = buildGif(1, 1, [{ width: 9000, height: 8000 }]);
      expect((await costOf(grown)).canvasPixels).toBe(72_000_000);
      const offset = buildGif(10, 10, [{ left: 8000, top: 5000, width: 1000, height: 1000 }]);
      expect((await costOf(offset)).canvasPixels).toBe(54_000_000);
    });

    it('adds up the frames of every format that has them', async () => {
      const frames: [number, number][] = [
        [100, 100],
        [50, 40],
      ];
      expect((await costOf(buildApng(100, 100, frames))).animationPixels).toBe(12_000);
      expect((await costOf(buildAnimatedWebp(100, 100, frames))).animationPixels).toBe(12_000);
      const gif = buildGif(
        100,
        100,
        frames.map(([width, height]) => ({ width, height })),
      );
      expect((await costOf(gif)).animationPixels).toBe(12_000);
    });

    it('the walk through an animated WebP ends cleanly on anything odd at the end', async () => {
      const whole = buildAnimatedWebp(100, 100, [[10, 10]]);
      const trailing = Buffer.concat([whole, Buffer.alloc(3)]);
      trailing.writeUInt32LE(whole.length + 3 - 8, 4);
      expect((await costOf(trailing)).animationPixels).toBe(100);
      const oversized = Buffer.from(whole);
      oversized.writeUInt32LE(0xffff_fff0, whole.length - 20 - 4);
      expect(sniffImage(oversized)).toMatchObject({ ok: true, width: 100 });
    });

    it('a bomb is refused from its real bytes', async () => {
      const bomb = buildBlankPng(EDGE, EDGE);
      expect(bomb.length).toBeLessThan(40_000);
      expect(decodeRefusal(await costOf(bomb), bomb.length)).toBe('memory');
    });

    it('so is one a frame grows, and a long run of huge frames in a small file', async () => {
      const grown = buildGif(1, 1, [{ width: EDGE, height: EDGE }]);
      expect(decodeRefusal(await costOf(grown), grown.length)).toBe('memory');
      const huge = Array.from({ length: 300 }, () => [4000, 4000] as [number, number]);
      const cases = [
        buildGif(
          4000,
          4000,
          huge.map(([width, height]) => ({ width, height })),
        ),
        buildApng(4000, 4000, huge),
        buildAnimatedWebp(4000, 4000, huge),
      ];
      for (const bytes of cases) {
        expect(decodeRefusal(await costOf(bytes), bytes.length)).toBe('animation');
      }
    });
  });

  it('walks chunks across read windows', async () => {
    const bytes = buildPng(800, 600, 5 * 1024 * 1024);
    expect(await sniffFromDisk(bytes, MAX)).toMatchObject({ ok: true, width: 800, height: 600 });
  });

  it('finds a frame behind segments larger than a read window', async () => {
    const app = (fill: number) => jpegSegment(0xe1, Buffer.alloc(65_000, fill));
    const bytes = buildJpegFrom(app(1), app(2), app(3), jpegFrame(8000, 6000));
    expect(await sniffFromDisk(bytes, LIMITS.attachmentMaxEdge)).toMatchObject({
      ok: true,
      width: 8000,
      height: 6000,
    });
  });

  it('walks a GIF to its last frame, past several read windows', async () => {
    const frames = Array.from({ length: 30_000 }, () => ({ width: 1, height: 1 }));
    const bytes = buildGif(1, 1, [...frames, { width: 4097, height: 1 }]);
    expect(bytes.length).toBeGreaterThan(300_000);
    await expectSameVerdict(bytes);
    expect(await sniffFromDisk(bytes, MAX)).toEqual(rejected('too_many_pixels'));
  });

  it('finds no end of image in a long JPEG scan that was cut off', async () => {
    const scan = Buffer.alloc(200_000, 0xff);
    const cut = Buffer.concat([buildJpeg(16, 16).subarray(0, -2), scan]);
    expect(await sniffFromDisk(cut, MAX)).toEqual(rejected('corrupt'));
    await expectSameVerdict(cut);
  });

  it('finds an end of image lying across two read windows', async () => {
    const whole = buildJpeg(16, 16);
    const tail = Buffer.alloc(64 * 1024 - 1, 0x00);
    const bytes = Buffer.concat([whole, tail]);
    expect(await sniffFromDisk(bytes, MAX)).toMatchObject({ ok: true, width: 16 });
    await expectSameVerdict(bytes);
  });

  it('agrees with the walk in memory on every kind of cut-off file', async () => {
    const files = [
      REAL_IMAGES.png.bytes,
      REAL_IMAGES.jpeg.bytes,
      REAL_IMAGES.gifAnimated.bytes,
      REAL_IMAGES.webpLossy.bytes,
      REAL_IMAGES.webpExtended.bytes,
    ];
    for (const bytes of files) {
      for (const length of [12, 20, 33, 64, Math.floor(bytes.length / 2), bytes.length - 1]) {
        await expectSameVerdict(bytes.subarray(0, length));
      }
    }
  });
});
