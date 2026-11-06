import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { AttachmentType, ProfileImageType } from '@hostile/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { detectImageType, sniffImage } from '../../src/lib/image-sniff.js';
import {
  stripLocationFromBuffer,
  stripLocationFromFile,
  type LocationStrip,
} from '../../src/lib/location-strip.js';
import { blankXmpLocation } from '../../src/lib/xmp-location.js';
import { buildGif, buildJpeg, buildPng, jpegSegment, REAL_IMAGES } from '../support/images.js';
import { REAL_LOCATED } from '../support/located-files.js';
import {
  atom,
  buildExif,
  changedRanges,
  EXIF_PREFIX,
  gifWithXmp,
  GIF_XMP_TRAILER,
  hasGpsPointer,
  jpegExifSegment,
  jpegWith,
  jpegXmpSegment,
  keyedMeta,
  MAKE,
  mp4With,
  MODEL,
  orientationIn,
  pngChunk,
  pngChunksInOrder,
  pngItxt,
  pngWith,
  qtText,
  readIfd0,
  tagsBalance,
  tiffOf,
  webpChunk,
  webpWith,
  XYZ,
} from '../support/location-builders.js';
import { REAL_OLD_QUICKTIME, REAL_VIDEOS } from '../support/videos.js';

const dir = mkdtempSync(join(tmpdir(), 'hostile-location-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const isImage = (type: AttachmentType): type is ProfileImageType => type.startsWith('image/');

async function clean(
  bytes: Buffer,
  type: AttachmentType,
): Promise<LocationStrip & { after: Buffer }> {
  const path = join(dir, randomUUID());
  await writeFile(path, bytes);
  const file = await open(path, 'r+');
  const onDisk = await stripLocationFromFile(file, bytes.length, type);
  await file.close();
  const after = await readFile(path);
  await rm(path);
  expect(after.length).toBe(bytes.length);
  if (isImage(type)) {
    const copy = Buffer.from(bytes);
    const inMemory = stripLocationFromBuffer(copy, type);
    expect(copy.equals(after)).toBe(true);
    expect(inMemory).toEqual(onDisk);
  }
  return { ...onDisk, after };
}

function fakeFile(bytes: Buffer) {
  const count = { reads: 0, bytesRead: 0, writes: 0 };
  const file = {
    read: (target: Buffer, offset: number, length: number, position: number) => {
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position + length).toBeLessThanOrEqual(bytes.length);
      count.reads++;
      count.bytesRead += length;
      const bytesRead = bytes.copy(target, offset, position, position + length);
      return Promise.resolve({ bytesRead, buffer: target });
    },
    write: (source: Buffer, offset: number, length: number, position: number) => {
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position + length).toBeLessThanOrEqual(bytes.length);
      count.writes++;
      source.copy(bytes, position, offset, offset + length);
      return Promise.resolve({ bytesWritten: length, buffer: source });
    },
  };
  return { file: file as unknown as FileHandle, count };
}

const contains = (haystack: Buffer, needle: Buffer | string) =>
  haystack.includes(typeof needle === 'string' ? Buffer.from(needle, 'latin1') : needle);

const jpegScan = (file: Buffer) =>
  file.subarray(file.indexOf(Buffer.from([0xff, 0xda])), file.indexOf(Buffer.from([0xff, 0xd9])));

const XMP_NAMESPACES =
  'xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"';

const xmpPacket = (attributes: string, elements = '') =>
  [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `<rdf:Description rdf:about="" ${XMP_NAMESPACES} ${attributes}>${elements}</rdf:Description>`,
    '</rdf:RDF></x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');

const LOCATED_XMP = xmpPacket(
  'exif:GPSLatitude="48,51.4833N" exif:GPSLongitude=\'2,17.6667E\' photoshop:City="Paris" photoshop:Headline="Keep me"',
  '<photoshop:Country>France</photoshop:Country><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Keep this too</rdf:li></rdf:Alt></dc:title>',
);

function expectLocationGoneFromXmp(after: Buffer) {
  for (const value of ['48,51.4833N', '2,17.6667E', 'Paris', 'France', 'GPSLatitude', 'City']) {
    expect(contains(after, value), value).toBe(false);
  }
  for (const value of ['Keep me', 'Keep this too', 'xmlns:photoshop']) {
    expect(contains(after, value), value).toBe(true);
  }
}

describe('EXIF, in each container and each byte order', () => {
  const containers: [string, AttachmentType, (tiff: Buffer) => Buffer][] = [
    ['JPEG', 'image/jpeg', (tiff) => jpegWith(jpegExifSegment(tiff))],
    ['PNG', 'image/png', (tiff) => pngWith(40, 20, pngChunk('eXIf', tiff))],
    ['WebP', 'image/webp', (tiff) => webpWith(webpChunk('EXIF', tiff))],
  ];
  for (const [name, type, wrap] of containers) {
    for (const little of [true, false]) {
      const order = little ? 'little-endian' : 'big-endian';

      it(`${name}, ${order}: the GPS goes and everything else stays`, async () => {
        const { tiff, gpsStart, gpsEnd, latitude, longitude } = buildExif({ little });
        const file = wrap(tiff);
        expect(hasGpsPointer(file)).toBe(true);
        expect(contains(file, latitude)).toBe(true);

        const { after, problems, bytesChanged } = await clean(file, type);
        expect(problems).toEqual([]);
        expect(bytesChanged).toBeGreaterThan(0);
        expect(hasGpsPointer(after)).toBe(false);
        expect(contains(after, latitude)).toBe(false);
        expect(contains(after, longitude)).toBe(false);
        expect(orientationIn(after)).toBe(6);
        expect(contains(after, MAKE)).toBe(true);
        expect(contains(after, MODEL)).toBe(true);

        const tiffAt = file.indexOf(tiff);
        const gpsBlock = after.subarray(tiffAt + gpsStart, tiffAt + gpsEnd);
        expect(gpsBlock.equals(Buffer.alloc(gpsBlock.length))).toBe(true);
        const allowed: [number, number][] = [
          [tiffAt + 8, tiffAt + 8 + 2 + 3 * 12 + 12 + 4],
          [tiffAt + gpsStart, tiffAt + gpsEnd],
          [tiffAt + tiff.length, tiffAt + tiff.length + 4],
        ];
        for (const [start, end] of changedRanges(file, after)) {
          for (let at = start; at < end; at++) {
            const inside = allowed.some(([from, to]) => at >= from && at < to);
            expect(inside, `changed byte ${at}`).toBe(true);
          }
        }
      });
    }
  }

  it('removes the pointer however its neighbours sit: later entries move down over it', async () => {
    const { tiff } = buildExif();
    const swapped = Buffer.from(tiff);
    const orientationEntry = 8 + 2 + 2 * 12;
    tiff.copy(swapped, orientationEntry, orientationEntry + 12, orientationEntry + 24);
    tiff.copy(swapped, orientationEntry + 12, orientationEntry, orientationEntry + 12);
    const { after } = await clean(jpegWith(jpegExifSegment(swapped)), 'image/jpeg');
    const tags = readIfd0(tiffOf(after));
    expect(tags.map((entry) => entry.tag)).toEqual([0x010f, 0x0110, 0x0112]);
    expect(orientationIn(after)).toBe(6);
  });

  it('keeps the link to the next directory, moved down with the entries', async () => {
    const { tiff } = buildExif();
    const linked = Buffer.from(tiff);
    const link = 8 + 2 + 4 * 12;
    linked.writeUInt32BE(0x1234, link);
    const { after } = await clean(jpegWith(jpegExifSegment(linked)), 'image/jpeg');
    const out = tiffOf(after);
    expect(out.readUInt16BE(8)).toBe(3);
    expect(out.readUInt32BE(8 + 2 + 3 * 12)).toBe(0x1234);
  });

  it('a file with no orientation gets none, and one with no GPS is not touched', async () => {
    const without = await clean(
      jpegWith(jpegExifSegment(buildExif({ orientation: null }).tiff)),
      'image/jpeg',
    );
    expect(hasGpsPointer(without.after)).toBe(false);
    expect(orientationIn(without.after)).toBeUndefined();

    const noGps = jpegWith(jpegExifSegment(buildExif({ gps: false }).tiff));
    const untouched = await clean(noGps, 'image/jpeg');
    expect(untouched.after.equals(noGps)).toBe(true);
    expect(untouched.bytesChanged).toBe(0);
  });

  it("takes a PNG or a WebP whose writer kept a JPEG's Exif prefix", async () => {
    const { tiff, latitude } = buildExif();
    const block = Buffer.concat([EXIF_PREFIX, tiff]);
    const png = await clean(pngWith(40, 20, pngChunk('eXIf', block)), 'image/png');
    expect(contains(png.after, latitude)).toBe(false);
    expect(pngChunksInOrder(png.after).every((chunk) => chunk.crcOk)).toBe(true);
    const webp = await clean(webpWith(webpChunk('EXIF', block)), 'image/webp');
    expect(contains(webp.after, latitude)).toBe(false);
  });

  it('every EXIF segment in a JPEG, not just the first', async () => {
    const one = buildExif();
    const two = buildExif({ little: true });
    const { after } = await clean(
      jpegWith(jpegExifSegment(one.tiff), jpegExifSegment(two.tiff)),
      'image/jpeg',
    );
    expect(contains(after, one.latitude)).toBe(false);
    expect(contains(after, two.latitude)).toBe(false);
  });

  it('a thumbnail with a GPS block of its own', async () => {
    const inner = buildExif({ orientation: null });
    const thumbnail = jpegWith(jpegExifSegment(inner.tiff));
    const head = Buffer.alloc(8 + 2 + 12 + 4);
    head.write('MM', 0, 'latin1');
    head.writeUInt16BE(42, 2);
    head.writeUInt32BE(8, 4);
    head.writeUInt16BE(1, 8);
    head.writeUInt16BE(0x010f, 10);
    head.writeUInt16BE(2, 12);
    head.writeUInt32BE(1, 14);
    const ifd1At = head.length;
    head.writeUInt32BE(ifd1At, 22);
    const ifd1 = Buffer.alloc(2 + 24 + 4);
    ifd1.writeUInt16BE(2, 0);
    ifd1.writeUInt16BE(0x0201, 2);
    ifd1.writeUInt16BE(4, 4);
    ifd1.writeUInt32BE(1, 6);
    ifd1.writeUInt32BE(ifd1At + ifd1.length, 10);
    ifd1.writeUInt16BE(0x0202, 14);
    ifd1.writeUInt16BE(4, 16);
    ifd1.writeUInt32BE(1, 18);
    ifd1.writeUInt32BE(thumbnail.length, 22);
    const tiff = Buffer.concat([head, ifd1, thumbnail]);
    const { after, problems } = await clean(jpegWith(jpegExifSegment(tiff)), 'image/jpeg');
    expect(problems).toEqual([]);
    expect(contains(after, inner.latitude)).toBe(false);
  });
});

describe('XMP', () => {
  it('blanks attributes and elements, keeps the length, and still parses', () => {
    const packet = Buffer.from(LOCATED_XMP);
    expect(tagsBalance(LOCATED_XMP)).toBe(true);
    const blanked = blankXmpLocation(packet);
    expect(Buffer.isBuffer(blanked)).toBe(true);
    const after = blanked as Buffer;
    expect(after.length).toBe(packet.length);
    expectLocationGoneFromXmp(after);
    expect(tagsBalance(after.toString('utf8'))).toBe(true);
    for (let i = 0; i < packet.length; i++) {
      if (after[i] !== packet[i]) expect(after[i]).toBe(0x20);
    }
  });

  const shapes: [string, string][] = [
    ['an attribute', 'x:GPSAltitude="35/1"'],
    ['single quotes', "x:GPSAltitude='35/1'"],
    ['spaces around the equals', 'x:GPSAltitude = "35/1"'],
    ['another prefix for the same namespace', 'e:GPSLatitude="48,51N"'],
    ['a drone', 'drone-dji:GpsLatitude="+48.85" drone-dji:GpsLongtitude="+2.29"'],
    ['a Microsoft tag', 'MicrosoftPhoto:LatitudeDegree="48.85"'],
    ['an IPTC structure, flat', 'Iptc4xmpExt:City="Paris" Iptc4xmpExt:CountryName="France"'],
    ['a place named outright', 'Iptc4xmpCore:Location="Champ de Mars" xmpDM:shotLocation="Mars"'],
    ['a value with a tag-like thing', 'photoshop:State="&lt;Ile&gt; de France"'],
  ];
  for (const [name, attribute] of shapes) {
    it(`blanks ${name}`, () => {
      const packet = Buffer.from(xmpPacket(attribute));
      const after = blankXmpLocation(packet) as Buffer;
      expect(after.length).toBe(packet.length);
      const text = after.toString('utf8');
      expect(text).not.toMatch(/48,51N|35\/1|\+48\.85|\+2\.29|48\.85|Paris|France|Mars|Ile/);
      expect(tagsBalance(text)).toBe(true);
    });
  }

  it('handles elements nested in a structure, a self-closed one, and a multi-byte name', () => {
    const packet = Buffer.from(
      xmpPacket(
        '',
        [
          '<Iptc4xmpExt:LocationCreated><rdf:Bag><rdf:li rdf:parseType="Resource">',
          '<Iptc4xmpExt:City>Москва</Iptc4xmpExt:City></rdf:li></rdf:Bag></Iptc4xmpExt:LocationCreated>',
          '<exif:GPSVersionID/>',
          '<dc:creator>Жёлудь</dc:creator>',
        ].join(''),
      ),
    );
    const after = blankXmpLocation(packet) as Buffer;
    const text = after.toString('utf8');
    expect(after.length).toBe(packet.length);
    expect(text).not.toContain('Москва');
    expect(text).not.toContain('LocationCreated');
    expect(text).not.toContain('GPSVersionID');
    expect(text).toContain('Жёлудь');
    expect(tagsBalance(text)).toBe(true);
  });

  it('does not touch a namespace declaration, or a packet with nothing to blank', () => {
    const quiet = Buffer.from(
      xmpPacket('xmlns:location="http://example.com/" dc:format="image/png"'),
    );
    expect(blankXmpLocation(quiet)).toBeNull();
  });

  it('calls a broken packet malformed, and leaves it, unless it is a known cut piece', () => {
    expect(blankXmpLocation(Buffer.from('<a exif:GPSLatitude="48'))).toBe('malformed');
    expect(blankXmpLocation(Buffer.from('<a b=c>'))).toBe('malformed');
    expect(blankXmpLocation(Buffer.from('<exif:GPSLatitude>48'))).toBe('malformed');
    expect(blankXmpLocation(Buffer.from('<!-- never ends'))).toBe('malformed');

    const piece = Buffer.from('<a photoshop:City="Paris" dc:format="image/png" dc:tit');
    const blanked = blankXmpLocation(piece, true) as Buffer;
    expect(blanked.toString()).not.toContain('Paris');
    expect(blanked.toString()).toContain('dc:format');
  });

  it('calls a packet that is not UTF-8 malformed', () => {
    expect(blankXmpLocation(Buffer.from(LOCATED_XMP, 'utf16le'))).toBe('malformed');
  });

  it('takes one pass over a packet built to take many', () => {
    for (const hostile of [
      '<a '.repeat(2_000_000),
      'a'.repeat(6_000_000),
      '<a b="'.repeat(1_000_000),
      '<exif:GPSx>'.repeat(500_000),
      `<a ${'b="c" '.repeat(1_000_000)}`,
    ]) {
      const started = Date.now();
      blankXmpLocation(Buffer.from(hostile));
      expect(Date.now() - started).toBeLessThan(3_000);
    }
  });

  const containers: [string, AttachmentType, (packet: string) => Buffer][] = [
    ['a JPEG', 'image/jpeg', (packet) => jpegWith(jpegXmpSegment(packet))],
    ['a WebP', 'image/webp', (packet) => webpWith(webpChunk('XMP ', Buffer.from(packet)))],
    ['a GIF', 'image/gif', gifWithXmp],
    ['a PNG', 'image/png', (packet) => pngWith(40, 20, pngItxt('XML:com.adobe.xmp', packet))],
    [
      "QuickTime's XMP_",
      'video/quicktime',
      (packet) => mp4With(atom('moov', atom('udta', atom('XMP_', Buffer.from(packet))))),
    ],
    [
      "an MP4's uuid box",
      'video/mp4',
      (packet) =>
        mp4With(
          atom('uuid', Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'), Buffer.from(packet)),
        ),
    ],
  ];
  for (const [name, type, wrap] of containers) {
    it(`is cleaned inside ${name}`, async () => {
      const { after, problems } = await clean(wrap(LOCATED_XMP), type);
      expect(problems).toEqual([]);
      expectLocationGoneFromXmp(after);
    });
  }

  it("a PNG's CRC is right afterwards, and only the XMP chunk changed", async () => {
    const file = pngWith(
      40,
      20,
      pngChunk('tEXt', Buffer.from('Title\0keep', 'latin1')),
      pngItxt('XML:com.adobe.xmp', LOCATED_XMP),
    );
    const before = pngChunksInOrder(file);
    expect(before.every((chunk) => chunk.crcOk)).toBe(true);
    const { after } = await clean(file, 'image/png');
    expect(pngChunksInOrder(after)).toEqual(before);
    expect(contains(after, 'Title\0keep')).toBe(true);
  });

  it('in a GIF, the hops through the packet still end at the same place', async () => {
    const file = gifWithXmp(LOCATED_XMP);
    const { after } = await clean(file, 'image/gif');
    expect(after.includes(GIF_XMP_TRAILER)).toBe(true);
    expect(sniffImage(after)).toEqual(sniffImage(file));
    expect(sniffImage(after).ok).toBe(true);
  });

  it('a GIF whose XMP is in real sub-blocks is left alone if blanking would break them', async () => {
    const first = Buffer.from('<a exif:GPSLatitude="48');
    const second = Buffer.from(',51N" b="c"/>');
    const file = Buffer.concat([
      gifWithXmp('').subarray(0, 13 + 3 + 11),
      Buffer.from([first.length]),
      first,
      Buffer.from([second.length]),
      second,
      Buffer.from([0, 0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b]),
    ]);
    expect(sniffImage(file).ok).toBe(true);
    const { after, problems } = await clean(file, 'image/gif');
    expect(problems).toEqual(['gif_xmp']);
    expect(after.equals(file)).toBe(true);
  });

  it('a piece of extended XMP, in which a value can be cut off', async () => {
    const namespace = Buffer.from('http://ns.adobe.com/xmp/extension/\0', 'latin1');
    const guid = Buffer.alloc(32, 0x41);
    const place = Buffer.alloc(8);
    const piece = Buffer.from('<a exif:GPSLatitude="48,51N" photoshop:Hea');
    const { after, problems } = await clean(
      jpegWith(jpegSegment(0xe1, Buffer.concat([namespace, guid, place, piece]))),
      'image/jpeg',
    );
    expect(problems).toEqual([]);
    expect(contains(after, '48,51N')).toBe(false);
  });
});

describe('IPTC in a JPEG', () => {
  const iim = (dataset: number, value: string) => {
    const head = Buffer.from([0x1c, 2, dataset, 0, 0]);
    head.writeUInt16BE(value.length, 3);
    return Buffer.concat([head, Buffer.from(value, 'latin1')]);
  };
  const resource = (id: number, data: Buffer) => {
    const head = Buffer.alloc(4 + 2 + 2 + 4);
    head.write('8BIM', 0, 'latin1');
    head.writeUInt16BE(id, 4);
    head.writeUInt32BE(data.length, 8);
    return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
  };
  const photoshop = (...resources: Buffer[]) =>
    jpegSegment(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), ...resources]));

  it('blanks the places and keeps the caption', async () => {
    const iptc = Buffer.concat([
      iim(120, 'Keep this caption'),
      iim(90, 'Paris'),
      iim(92, 'Champ de Mars'),
      iim(95, 'Ile de France'),
      iim(100, 'FRA'),
      iim(101, 'France'),
      iim(5, 'Keep this title'),
    ]);
    const { after, problems } = await clean(
      jpegWith(photoshop(resource(0x0404, iptc))),
      'image/jpeg',
    );
    expect(problems).toEqual([]);
    for (const place of ['Paris', 'Champ de Mars', 'Ile de France', 'FRA', 'France']) {
      expect(contains(after, place), place).toBe(false);
    }
    expect(contains(after, 'Keep this caption')).toBe(true);
    expect(contains(after, 'Keep this title')).toBe(true);
  });

  it("cleans Photoshop's copies of the EXIF and the XMP as well", async () => {
    const { tiff, latitude } = buildExif();
    const { after } = await clean(
      jpegWith(photoshop(resource(0x0422, tiff), resource(0x0424, Buffer.from(LOCATED_XMP)))),
      'image/jpeg',
    );
    expect(contains(after, latitude)).toBe(false);
    expectLocationGoneFromXmp(after);
  });

  it('stops at a resource that claims more than the segment holds, having done no harm', async () => {
    const bad = resource(0x0404, iim(90, 'Paris'));
    bad.writeUInt32BE(0xffffff, 8);
    const file = jpegWith(photoshop(bad));
    const { after } = await clean(file, 'image/jpeg');
    expect(after.equals(file)).toBe(true);
  });
});

describe('text chunks in a PNG', () => {
  const zipped = (packet: string) =>
    pngChunk(
      'iTXt',
      Buffer.concat([
        Buffer.from('XML:com.adobe.xmp', 'latin1'),
        Buffer.from([0, 1, 0, 0, 0]),
        deflateSync(Buffer.from(packet)),
      ]),
    );

  it('a compressed XMP chunk with a location in it is emptied, and decoders skip what is left', async () => {
    const file = pngWith(40, 20, zipped(LOCATED_XMP));
    const { after, problems } = await clean(file, 'image/png');
    expect(problems).toEqual([]);
    const chunks = pngChunksInOrder(after);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'nuLl', 'IDAT', 'IEND']);
    expect(chunks.every((chunk) => chunk.crcOk)).toBe(true);
    expect(sniffImage(after).ok).toBe(true);
  });

  it('a compressed XMP chunk with no location is left as it is', async () => {
    const file = pngWith(40, 20, zipped(xmpPacket('dc:format="image/png"')));
    const { after, bytesChanged } = await clean(file, 'image/png');
    expect(bytesChanged).toBe(0);
    expect(after.equals(file)).toBe(true);
  });

  it('corrupt compressed text, and a bomb, are reported and left', async () => {
    const corrupt = pngChunk(
      'iTXt',
      Buffer.concat([
        Buffer.from('XML:com.adobe.xmp\0\x01\0\0\0', 'latin1'),
        Buffer.alloc(32, 0x5a),
      ]),
    );
    const one = await clean(pngWith(40, 20, corrupt), 'image/png');
    expect(one.problems).toEqual(['png_text']);
    expect(one.bytesChanged).toBe(0);

    const bomb = pngChunk(
      'iTXt',
      Buffer.concat([
        Buffer.from('XML:com.adobe.xmp\0\x01\0\0\0', 'latin1'),
        deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20)),
      ]),
    );
    const two = await clean(pngWith(40, 20, bomb), 'image/png');
    expect(two.problems).toEqual(['png_text']);
    expect(two.bytesChanged).toBe(0);
  });

  it("empties ImageMagick's raw profiles, which hold whole metadata blocks in hexadecimal", async () => {
    const raw = pngChunk(
      'tEXt',
      Buffer.from('Raw profile type exif\0\nexif\n 8\n4d4d002a', 'latin1'),
    );
    const { after } = await clean(pngWith(40, 20, raw), 'image/png');
    expect(pngChunksInOrder(after).map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'nuLl',
      'IDAT',
      'IEND',
    ]);
    expect(contains(after, '4d4d002a')).toBe(false);
  });

  it('any other text is none of its business', async () => {
    const file = pngWith(
      40,
      20,
      pngChunk('tEXt', Buffer.from('Comment\0taken in Paris', 'latin1')),
    );
    const { after } = await clean(file, 'image/png');
    expect(after.equals(file)).toBe(true);
  });
});

describe('MP4 and QuickTime', () => {
  const movie = (...children: Buffer[]) =>
    atom('moov', atom('mvhd', Buffer.alloc(100)), ...children);
  const ISO6709 = '+48.8584+002.2945+035.000/';

  it('blanks ©xyz under udta, wherever moov is, and only that', async () => {
    const title = qtText('©nam', 'Keep this title');
    const after = async (file: Buffer) => {
      const { after, problems } = await clean(file, 'video/mp4');
      expect(problems).toEqual([]);
      expect(contains(after, ISO6709)).toBe(false);
      expect(contains(after, XYZ)).toBe(false);
      expect(contains(after, 'Keep this title')).toBe(true);
      expect(contains(after, Buffer.alloc(64, 0x5a))).toBe(true);
    };
    const udta = atom('udta', qtText(XYZ, ISO6709), title);
    await after(mp4With(movie(udta)));
    await after(
      Buffer.concat([
        atom('ftyp', Buffer.from('isom\0\0\x02\0isommp42', 'latin1')),
        movie(udta),
        atom('mdat', Buffer.alloc(64, 0x5a)),
      ]),
    );
  });

  it('per track too, and at the top level, and 3GPP loci', async () => {
    const track = atom('trak', atom('udta', qtText(XYZ, ISO6709)));
    const loci = atom('udta', atom('loci', Buffer.from(`\0\0\0\0\x55\xc4${ISO6709}`, 'latin1')));
    const { after } = await clean(
      mp4With(movie(track, loci), atom('udta', qtText(XYZ, ISO6709))),
      'video/mp4',
    );
    expect(contains(after, ISO6709)).toBe(false);
    expect(contains(after, 'loci')).toBe(false);
  });

  it('a blanked atom keeps its size, so a reader walks over it to the next', async () => {
    const file = mp4With(movie(atom('udta', qtText(XYZ, ISO6709), qtText('©nam', 'Next'))));
    const { after } = await clean(file, 'video/mp4');
    const at = after.indexOf('free', file.indexOf('udta'), 'latin1');
    expect(at).toBeGreaterThan(0);
    const size = after.readUInt32BE(at - 4);
    expect(size).toBe(qtText(XYZ, ISO6709).length);
    expect(after.toString('latin1', at - 4 + size + 4, at - 4 + size + 8)).toBe('©nam');
  });

  const keyed: [string, string][] = [
    ['com.apple.quicktime.make', 'Apple'],
    ['com.apple.quicktime.location.ISO6709', ISO6709],
    ['com.apple.quicktime.location.name', 'Paris'],
    ['com.apple.quicktime.model', 'iPhone'],
    ['com.apple.quicktime.location.accuracy.horizontal', '5.000'],
  ];

  it('blanks the values of location keys under meta, and keeps the others', async () => {
    const { after, problems } = await clean(mp4With(movie(keyedMeta(keyed))), 'video/quicktime');
    expect(problems).toEqual([]);
    for (const value of [ISO6709, 'Paris', '5.000']) {
      expect(contains(after, value), value).toBe(false);
    }
    expect(contains(after, 'Apple')).toBe(true);
    expect(contains(after, 'iPhone')).toBe(true);
    expect(contains(after, 'com.apple.quicktime.model')).toBe(true);
  });

  it('meta in either form: with four bytes of flags first, as an MP4 has it, or without', async () => {
    const plain = keyedMeta(keyed);
    const flagged = atom('meta', Buffer.alloc(4), plain.subarray(8));
    for (const meta of [plain, flagged]) {
      const { after } = await clean(mp4With(movie(atom('udta', meta))), 'video/mp4');
      expect(contains(after, ISO6709)).toBe(false);
    }
  });

  it('©xyz inside an ilst, as iTunes-style metadata has it', async () => {
    const data = atom(
      'data',
      Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]),
      Buffer.from(ISO6709, 'latin1'),
    );
    const meta = atom(
      'meta',
      Buffer.alloc(4),
      atom('hdlr', Buffer.alloc(24)),
      atom('ilst', atom(XYZ, data)),
    );
    const { after } = await clean(mp4With(movie(atom('udta', meta))), 'video/mp4');
    expect(contains(after, ISO6709)).toBe(false);
  });

  it('a 64-bit size', async () => {
    const inner = atom('udta', qtText(XYZ, ISO6709));
    const large = Buffer.alloc(16);
    large.writeUInt32BE(1, 0);
    large.write('moov', 4, 'latin1');
    large.writeBigUInt64BE(BigInt(16 + inner.length), 8);
    const { after } = await clean(mp4With(Buffer.concat([large, inner])), 'video/mp4');
    expect(contains(after, ISO6709)).toBe(false);
  });

  it('says that a compressed movie header cannot be read, and leaves it', async () => {
    const file = mp4With(atom('moov', atom('cmov', Buffer.alloc(32))));
    const { after, problems } = await clean(file, 'video/quicktime');
    expect(problems).toEqual(['mp4_compressed']);
    expect(after.equals(file)).toBe(true);
  });

  it('reads almost nothing of a 200 MB video with moov at the end', async () => {
    const moov = movie(atom('udta', qtText(XYZ, ISO6709)));
    const head = Buffer.concat([atom('ftyp', Buffer.from('isom\0\0\x02\0isommp42', 'latin1'))]);
    const mediaSize = 200 * 1024 * 1024;
    const mediaHead = Buffer.alloc(8);
    mediaHead.writeUInt32BE(mediaSize + 8);
    mediaHead.write('mdat', 4, 'latin1');
    const path = join(dir, randomUUID());
    const handle = await open(path, 'w+');
    await handle.write(head, 0, head.length, 0);
    await handle.write(mediaHead, 0, 8, head.length);
    const moovAt = head.length + 8 + mediaSize;
    await handle.write(moov, 0, moov.length, moovAt);
    const size = moovAt + moov.length;

    let bytesRead = 0;
    const watching = {
      read: (target: Buffer, offset: number, length: number, position: number) => {
        bytesRead += length;
        return handle.read(target, offset, length, position);
      },
      write: (source: Buffer, offset: number, length: number, position: number) =>
        handle.write(source, offset, length, position),
    } as unknown as FileHandle;
    const { problems, bytesChanged } = await stripLocationFromFile(watching, size, 'video/mp4');
    expect(problems).toEqual([]);
    expect(bytesChanged).toBeGreaterThan(0);
    expect((await handle.stat()).size).toBe(size);
    const tail = Buffer.alloc(moov.length);
    await handle.read(tail, 0, tail.length, moovAt);
    await handle.close();
    await rm(path);
    expect(contains(tail, ISO6709)).toBe(false);
    expect(bytesRead).toBeLessThan(1024 * 1024);
  });

  it('a moov with more children than the bound stops there, and says so, and still answers', async () => {
    const filler = Buffer.alloc(8);
    filler.writeUInt32BE(8);
    filler.write('free', 4, 'latin1');
    const many = Buffer.concat(Array.from({ length: 210_000 }, () => filler));
    const file = mp4With(
      atom('udta', qtText(XYZ, ISO6709)),
      atom('moov', many, atom('udta', qtText(XYZ, '+99+099/'))),
    );
    const copy = Buffer.from(file);
    const { file: fake } = fakeFile(copy);
    const { problems } = await stripLocationFromFile(fake, copy.length, 'video/mp4');
    expect(problems).toContain('too_many_structures');
    expect(contains(copy, ISO6709)).toBe(false);
    expect(contains(copy, '+99+099/')).toBe(true);
    expect(copy.length).toBe(file.length);
  });
});

describe('what follows the end of a JPEG', () => {
  it('a second image, from a real Multi-Picture writer', async () => {
    const { bytes, type } = REAL_LOCATED.multiPicture;
    const pointers = (file: Buffer) => file.toString('latin1').split('\x88\x25\x00\x04').length - 1;
    expect(pointers(bytes)).toBe(2);
    const { after, problems } = await clean(bytes, type);
    expect(problems).toEqual([]);
    expect(pointers(after)).toBe(0);
    expect(orientationIn(after)).toBe(6);
  });

  it("a motion photo's video, from real files laid end to end", async () => {
    const file = Buffer.concat([REAL_LOCATED.pillowJpeg.bytes, REAL_LOCATED.ffmpegMov.bytes]);
    expect(contains(file, '+48.8584+002.2945')).toBe(true);
    const { after, problems } = await clean(file, 'image/jpeg');
    expect(problems).toEqual([]);
    expect(contains(after, '+48.8584+002.2945')).toBe(false);
    expect(contains(after, XYZ)).toBe(false);
    expect(contains(after, 'Keep me')).toBe(true);
    const video = after.subarray(REAL_LOCATED.pillowJpeg.bytes.length);
    expect(video.length).toBe(REAL_LOCATED.ffmpegMov.bytes.length);
    expect(video.subarray(0, 8).equals(REAL_LOCATED.ffmpegMov.bytes.subarray(0, 8))).toBe(true);
  });

  it('rubbish after the end is left alone and is not a problem', async () => {
    const file = Buffer.concat([buildJpeg(4, 4), Buffer.alloc(8192, 0x41)]);
    const { after, problems } = await clean(file, 'image/jpeg');
    expect(problems).toEqual([]);
    expect(after.equals(file)).toBe(true);
  });

  it('stops looking after a limit, however many starts of a JPEG there are', async () => {
    const starts = Buffer.alloc(4 * 1024);
    for (let i = 0; i + 4 <= starts.length; i += 4) starts.set([0xff, 0xd8, 0xff, 0x00], i);
    const behind = REAL_LOCATED.pillowJpeg.bytes;
    const file = Buffer.concat([buildJpeg(4, 4), starts, behind]);
    const { after, problems } = await clean(file, 'image/jpeg');
    expect(problems).toEqual(['too_many_structures']);
    expect(after.equals(file)).toBe(true);
  });
});

describe('files from real writers', () => {
  const LOCATION_TEXT = ['+48.8584', 'Paris', 'France', 'Champ de Mars', 'GPSLatitude'];
  for (const [name, { bytes, type }] of Object.entries(REAL_LOCATED)) {
    it(`${name}: location gone, the rest still reads`, async () => {
      const { after, problems, bytesChanged } = await clean(bytes, type);
      expect(problems).toEqual([]);
      expect(bytesChanged).toBeGreaterThan(0);
      for (const text of LOCATION_TEXT) expect(contains(after, text), text).toBe(false);
      if (isImage(type)) {
        expect(sniffImage(after)).toEqual(sniffImage(bytes));
        expect(sniffImage(after).ok).toBe(true);
        if (type !== 'image/gif') {
          expect(hasGpsPointer(after)).toBe(false);
          expect(orientationIn(after)).toBe(6);
        }
      }
      if (type === 'image/jpeg') expect(jpegScan(after).equals(jpegScan(bytes))).toBe(true);
    });
  }

  it("a PNG's chunks are all still valid", async () => {
    for (const file of [
      REAL_LOCATED.pillowPng,
      REAL_LOCATED.applePng,
      REAL_LOCATED.pillowPngZipped,
    ]) {
      const { after } = await clean(file.bytes, file.type);
      expect(pngChunksInOrder(after).every((chunk) => chunk.crcOk)).toBe(true);
    }
  });
});

describe('a file with nothing to remove is byte for byte the same', () => {
  const plain: [string, Buffer, AttachmentType][] = [
    ...Object.entries(REAL_IMAGES).map(
      ([name, image]) => [name, image.bytes, image.type] as [string, Buffer, AttachmentType],
    ),
    ...Object.entries(REAL_VIDEOS).map(
      ([name, video]) => [name, video.bytes, video.type] as [string, Buffer, AttachmentType],
    ),
    ...Object.entries(REAL_OLD_QUICKTIME).map(
      ([name, bytes]) =>
        [`QuickTime, ${name}`, bytes, 'video/quicktime'] as [string, Buffer, AttachmentType],
    ),
    ['a built PNG', buildPng(4, 4), 'image/png'],
    ['a built GIF', buildGif(4, 4), 'image/gif'],
    ['a built JPEG', buildJpeg(4, 4), 'image/jpeg'],
  ];
  for (const [name, bytes, type] of plain) {
    it(name, async () => {
      const { after, bytesChanged, problems } = await clean(bytes, type);
      expect(after.equals(bytes)).toBe(true);
      expect(bytesChanged).toBe(0);
      expect(problems).toEqual([]);
    });
  }
});

describe('files built to cause trouble', () => {
  const NOTHING_THROWS = 'unexpected';

  async function survive(
    file: Buffer,
    type: AttachmentType,
  ): Promise<LocationStrip & { after: Buffer }> {
    const onDisk = Buffer.from(file);
    const { file: fake } = fakeFile(onDisk);
    const result = await stripLocationFromFile(fake, onDisk.length, type);
    expect(result.problems).not.toContain(NOTHING_THROWS);
    expect(onDisk.length).toBe(file.length);
    if (isImage(type)) {
      const inMemory = Buffer.from(file);
      stripLocationFromBuffer(inMemory, type);
      expect(inMemory.equals(onDisk)).toBe(true);
    }
    return { ...result, after: onDisk };
  }

  const big = (tiff: Buffer) => jpegWith(jpegExifSegment(tiff));
  const IFD0_COUNT = 8;
  const GPS_ENTRY = 8 + 2 + 3 * 12;
  const NEXT_LINK = 8 + 2 + 4 * 12;

  it('a GPS pointer past the end of the block', async () => {
    const { tiff } = buildExif();
    const bad = Buffer.from(tiff);
    bad.writeUInt32BE(0xfffffff0, GPS_ENTRY + 8);
    const { after, problems } = await survive(big(bad), 'image/jpeg');
    expect(problems).toEqual([]);
    expect(hasGpsPointer(after)).toBe(false);
    expect(orientationIn(after)).toBe(6);
  });

  it('a GPS pointer at IFD0 itself keeps the orientation', async () => {
    const { tiff } = buildExif();
    const bad = Buffer.from(tiff);
    bad.writeUInt32BE(8, GPS_ENTRY + 8);
    const { after } = await survive(big(bad), 'image/jpeg');
    expect(orientationIn(after)).toBe(6);
    expect(hasGpsPointer(after)).toBe(false);
  });

  it('a value offset past the end, with a count to overflow any multiplication', async () => {
    const { tiff, gpsStart } = buildExif();
    const bad = Buffer.from(tiff);
    const latitude = gpsStart + 2 + 12;
    bad.writeUInt32BE(0xffffffff, latitude + 4);
    bad.writeUInt32BE(0xffffffff, latitude + 8);
    const { after, problems } = await survive(big(bad), 'image/jpeg');
    expect(problems).toEqual([]);
    expect(hasGpsPointer(after)).toBe(false);
  });

  it('an unknown value type is not given a length', async () => {
    const { tiff, gpsStart, longitude } = buildExif();
    const bad = Buffer.from(tiff);
    bad.writeUInt16BE(99, gpsStart + 2 + 12 + 2);
    const { after } = await survive(big(bad), 'image/jpeg');
    expect(hasGpsPointer(after)).toBe(false);
    expect(contains(after, longitude)).toBe(false);
  });

  it('a directory that says it has 65,535 entries', async () => {
    for (const at of [IFD0_COUNT]) {
      const { tiff } = buildExif();
      const bad = Buffer.from(tiff);
      bad.writeUInt16BE(0xffff, at);
      await survive(big(bad), 'image/jpeg');
    }
    const { tiff, gpsStart } = buildExif();
    const bad = Buffer.from(tiff);
    bad.writeUInt16BE(0xffff, gpsStart);
    const { after } = await survive(big(bad), 'image/jpeg');
    expect(orientationIn(after)).toBe(6);
  });

  it('directories that link in a loop, and a link past the end', async () => {
    for (const link of [8, NEXT_LINK, 0x7fffffff, 0xffffffff]) {
      const { tiff } = buildExif();
      const bad = Buffer.from(tiff);
      bad.writeUInt32BE(link, NEXT_LINK);
      const { after } = await survive(big(bad), 'image/jpeg');
      expect(hasGpsPointer(after)).toBe(false);
    }
  });

  it('a GPS block that has several pointers to itself', async () => {
    const { tiff, gpsStart } = buildExif();
    const bad = Buffer.from(tiff);
    bad.writeUInt16BE(0x8825, gpsStart + 2);
    bad.writeUInt16BE(4, gpsStart + 2 + 2);
    bad.writeUInt32BE(1, gpsStart + 2 + 4);
    bad.writeUInt32BE(gpsStart, gpsStart + 2 + 8);
    const { after } = await survive(big(bad), 'image/jpeg');
    expect(hasGpsPointer(after)).toBe(false);
  });

  it('not a TIFF at all, in each container', async () => {
    const rubbish = Buffer.alloc(64, 0x41);
    const jpeg = await survive(
      jpegWith(jpegSegment(0xe1, Buffer.concat([EXIF_PREFIX, rubbish]))),
      'image/jpeg',
    );
    expect(jpeg.problems).toEqual(['exif_malformed']);
    expect(jpeg.bytesChanged).toBe(0);
    const png = await survive(pngWith(40, 20, pngChunk('eXIf', rubbish)), 'image/png');
    expect(png.problems).toEqual(['exif_malformed']);
    const webp = await survive(webpWith(webpChunk('EXIF', rubbish)), 'image/webp');
    expect(webp.problems).toEqual(['exif_malformed']);
  });

  it('a TIFF too short to hold a directory', async () => {
    for (let length = 0; length < 16; length++) {
      await survive(big(buildExif().tiff.subarray(0, length)), 'image/jpeg');
    }
  });

  it('JPEG segments that do not add up', async () => {
    const start = Buffer.from([0xff, 0xd8]);
    for (const tail of [
      [0xff, 0xe1, 0x00, 0x00],
      [0xff, 0xe1, 0x00, 0x01],
      [0xff, 0xe1, 0xff, 0xff, 0x45],
      [0xff, 0xff, 0xff],
      [0xff],
      [0x00],
      [0xff, 0x00],
      [0xff, 0xda],
      [0xff, 0xd9],
    ]) {
      await survive(Buffer.concat([start, Buffer.from(tail)]), 'image/jpeg');
    }
    await survive(Buffer.alloc(16 * 1024, 0xff), 'image/jpeg');
    await survive(Buffer.concat([start, Buffer.alloc(16 * 1024, 0xff)]), 'image/jpeg');
  });

  it('PNG, WebP and GIF lengths past the end', async () => {
    const huge = Buffer.alloc(8);
    huge.writeUInt32BE(0xffffffff, 0);
    huge.write('eXIf', 4, 'latin1');
    const png = await survive(Buffer.concat([buildPng(4, 4).subarray(0, 33), huge]), 'image/png');
    expect(png.problems).toEqual([]);
    const pngPast = Buffer.concat([buildPng(4, 4).subarray(0, 33), huge, Buffer.alloc(16)]);
    expect((await survive(pngPast, 'image/png')).problems).toEqual(['png_structure']);

    const webp = webpWith(webpChunk('EXIF', Buffer.alloc(16)));
    webp.writeUInt32LE(0xffffffff, 16);
    expect((await survive(webp, 'image/webp')).problems).toEqual(['webp_structure']);
    const riff = webpWith(webpChunk('EXIF', Buffer.alloc(16)));
    riff.writeUInt32LE(0xffffffff, 4);
    await survive(riff, 'image/webp');
    await survive(Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), 'image/webp');

    const gif = gifWithXmp('<a/>');
    await survive(gif.subarray(0, 20), 'image/gif');
    await survive(gif.subarray(0, 40), 'image/gif');
    const noTerminator = Buffer.concat([gif.subarray(0, 27), Buffer.alloc(4096, 0x20)]);
    await survive(noTerminator, 'image/gif');
  });

  it('atoms of no length, of too little, and of far too much', async () => {
    const size = (value: number, type: string) => {
      const out = Buffer.alloc(8);
      out.writeUInt32BE(value);
      out.write(type, 4, 'latin1');
      return out;
    };
    const ftyp = atom('ftyp', Buffer.from('isom\0\0\x02\0isommp42', 'latin1'));
    for (const bad of [
      size(0, 'moov'),
      size(1, 'moov'),
      size(2, 'moov'),
      size(7, 'moov'),
      size(0xffffffff, 'moov'),
      Buffer.concat([
        size(1, 'moov'),
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      ]),
      Buffer.concat([size(1, 'moov'), Buffer.alloc(8)]),
      Buffer.concat([size(1, 'moov'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 4])]),
    ]) {
      for (const file of [
        Buffer.concat([ftyp, bad, Buffer.alloc(32)]),
        Buffer.concat([ftyp, atom('moov', bad, Buffer.alloc(32))]),
        Buffer.concat([ftyp, atom('moov', atom('udta', bad, Buffer.alloc(32)))]),
        Buffer.concat([ftyp, atom('moov', atom('meta', Buffer.alloc(4), bad))]),
      ]) {
        const { problems } = await survive(file, 'video/mp4');
        expect(problems).not.toContain('too_many_structures');
      }
    }
  });

  it('a zero-size atom at the top runs to the end of the file, as the format says', async () => {
    const zero = Buffer.alloc(8);
    zero.write('moov', 4, 'latin1');
    const inner = atom('udta', qtText(XYZ, '+1+2/'));
    const { after, problems } = await survive(mp4With(Buffer.concat([zero, inner])), 'video/mp4');
    expect(problems).toEqual([]);
    expect(contains(after, '+1+2/')).toBe(false);
  });

  it('an atom whose size says more than its parent holds', async () => {
    const child = atom('udta', qtText(XYZ, '+1+2/'));
    child.writeUInt32BE(child.length + 100, 0);
    const { after, problems } = await survive(mp4With(atom('moov', child)), 'video/mp4');
    expect(problems).toEqual(['mp4_structure']);
    expect(contains(after, '+1+2/')).toBe(true);
  });

  it('keys that lie about their count and their sizes', async () => {
    const counts = Buffer.alloc(8);
    counts.writeUInt32BE(0xffffffff, 4);
    const liar = Buffer.alloc(8);
    liar.writeUInt32BE(0xffffffff, 0);
    const tiny = Buffer.alloc(8);
    tiny.writeUInt32BE(3, 0);
    for (const entry of [liar, tiny, Buffer.alloc(3)]) {
      const meta = atom(
        'meta',
        atom('hdlr', Buffer.alloc(8)),
        atom('keys', counts, entry),
        atom('ilst'),
      );
      await survive(mp4With(atom('moov', meta)), 'video/quicktime');
    }
    await survive(
      mp4With(atom('moov', atom('meta', atom('keys', Buffer.alloc(2))))),
      'video/quicktime',
    );
    await survive(mp4With(atom('moov', atom('meta'))), 'video/quicktime');
  });

  it('cut off at every possible length', async () => {
    for (const [, { bytes, type }] of Object.entries(REAL_LOCATED)) {
      for (let length = 0; length < bytes.length; length += bytes.length > 1000 ? 3 : 1) {
        await survive(bytes.subarray(0, length), type);
      }
    }
  });

  it('with bytes changed at random, 4,000 times over', async () => {
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const interesting = [0x00, 0x01, 0x7f, 0x80, 0xff, 0xfe, 0x20, 0x3c];
    const files = Object.values(REAL_LOCATED);
    for (let i = 0; i < 4_000; i++) {
      const { bytes, type } = files[next() % files.length]!;
      const mutated = Buffer.from(bytes);
      const changes = 1 + (next() % 8);
      for (let j = 0; j < changes; j++) {
        const at = next() % Math.min(mutated.length, next() % 2 ? 512 : mutated.length);
        mutated[at] = next() % 2 ? interesting[next() % interesting.length]! : next() % 256;
      }
      await survive(mutated, type);
    }
  }, 60_000);

  it('WebM, and anything else without a walker, is left and is not a problem', async () => {
    const { bytes, type } = REAL_VIDEOS.webm;
    const { after, problems } = await clean(bytes, type);
    expect(problems).toEqual([]);
    expect(after.equals(bytes)).toBe(true);
    expect(detectImageType(bytes)).toBeNull();
  });
});

describe('when the disk itself fails', () => {
  const failure = (syscall: string) =>
    Object.assign(new Error(`${syscall} failed`), { code: 'EIO', syscall });

  function writingAtMost(limit: number, bytes: Buffer) {
    const { file } = fakeFile(bytes);
    return {
      read: file.read.bind(file),
      write: (source: Buffer, offset: number, length: number, position: number) =>
        file.write(source, offset, Math.min(length, limit), position),
    } as unknown as FileHandle;
  }

  it('a write that takes only part of its bytes is carried on from where it stopped', async () => {
    const { bytes, type } = REAL_LOCATED.pillowJpeg;
    const whole = Buffer.from(bytes);
    stripLocationFromBuffer(whole, type);
    const piecemeal = Buffer.from(bytes);
    await stripLocationFromFile(writingAtMost(7, piecemeal), piecemeal.length, type);
    expect(piecemeal.equals(whole)).toBe(true);
  });

  it('a write that takes nothing is a failure, and not a loop', async () => {
    const { bytes, type } = REAL_LOCATED.pillowJpeg;
    const stuck = Buffer.from(bytes);
    const file = writingAtMost(0, stuck);
    await expect(stripLocationFromFile(file, stuck.length, type)).rejects.toMatchObject({
      code: 'EIO',
      syscall: 'write',
    });
  });

  it('a failed read is not swallowed, because the caller has an answer for it', async () => {
    const file = { read: () => Promise.reject(failure('read')) } as unknown as FileHandle;
    await expect(stripLocationFromFile(file, 64, 'image/jpeg')).rejects.toThrow('read failed');
  });

  it('a failed write is not swallowed either, because the location would still be there', async () => {
    const bytes = Buffer.from(REAL_LOCATED.pillowJpeg.bytes);
    const file = {
      read: fakeFile(bytes).file.read,
      write: () => Promise.reject(failure('write')),
    } as unknown as FileHandle;
    await expect(stripLocationFromFile(file, bytes.length, 'image/jpeg')).rejects.toThrow(
      'write failed',
    );
  });
});
