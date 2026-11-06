import { crc32 } from 'node:zlib';
import { buildJpegFrom, jpegFrame, jpegSegment } from './images.js';

export const LATITUDE = [48, 1, 51, 1, 2900, 100];
export const LONGITUDE = [2, 1, 17, 1, 4000, 100];
export const MAKE = 'TestCam\0';
export const MODEL = 'Keep this model\0';

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;

export const GPS_POINTER = 0x8825;
export const ORIENTATION = 0x0112;

interface ExifOptions {
  little?: boolean;
  orientation?: number | null;
  gps?: boolean;
}

export interface BuiltExif {
  tiff: Buffer;
  gpsStart: number;
  gpsEnd: number;
  latitude: Buffer;
  longitude: Buffer;
}

export function buildExif({
  little = false,
  orientation = 6,
  gps = true,
}: ExifOptions = {}): BuiltExif {
  const u16 = (value: number) => {
    const out = Buffer.alloc(2);
    if (little) out.writeUInt16LE(value);
    else out.writeUInt16BE(value);
    return out;
  };
  const u32 = (value: number) => {
    const out = Buffer.alloc(4);
    if (little) out.writeUInt32LE(value);
    else out.writeUInt32BE(value);
    return out;
  };
  const entry = (tag: number, type: number, count: number, value: Buffer) =>
    Buffer.concat([u16(tag), u16(type), u32(count), value, Buffer.alloc(4 - value.length)]);
  const rationals = (values: number[]) => Buffer.concat(values.map(u32));

  const make = Buffer.from(MAKE, 'latin1');
  const model = Buffer.from(MODEL, 'latin1');
  const latitude = rationals(LATITUDE);
  const longitude = rationals(LONGITUDE);

  const count = 2 + (orientation === null ? 0 : 1) + (gps ? 1 : 0);
  const ifd0End = 8 + 2 + count * 12 + 4;
  const makeAt = ifd0End;
  const modelAt = makeAt + make.length;
  const gpsStart = gps ? modelAt + model.length : 0;
  const gpsIfdEnd = gpsStart + 2 + 4 * 12 + 4;
  const latitudeAt = gpsIfdEnd;
  const longitudeAt = latitudeAt + latitude.length;
  const gpsEnd = gps ? longitudeAt + longitude.length : 0;

  const entries = [
    entry(0x010f, ASCII, make.length, u32(makeAt)),
    entry(0x0110, ASCII, model.length, u32(modelAt)),
    ...(orientation === null ? [] : [entry(ORIENTATION, SHORT, 1, u16(orientation))]),
    ...(gps ? [entry(GPS_POINTER, LONG, 1, u32(gpsStart))] : []),
  ];
  const parts = [
    Buffer.from(little ? 'II' : 'MM', 'latin1'),
    u16(42),
    u32(8),
    u16(count),
    ...entries,
    u32(0),
    make,
    model,
  ];
  if (gps) {
    parts.push(
      u16(4),
      entry(1, ASCII, 2, Buffer.from('N\0', 'latin1')),
      entry(2, RATIONAL, 3, u32(latitudeAt)),
      entry(3, ASCII, 2, Buffer.from('E\0', 'latin1')),
      entry(4, RATIONAL, 3, u32(longitudeAt)),
      u32(0),
      latitude,
      longitude,
    );
  }
  return { tiff: Buffer.concat(parts), gpsStart, gpsEnd, latitude, longitude };
}

export const EXIF_PREFIX = Buffer.from('Exif\0\0', 'latin1');

export const jpegWith = (...segments: Buffer[]) => buildJpegFrom(...segments, jpegFrame(40, 20));

export const jpegExifSegment = (tiff: Buffer) =>
  jpegSegment(0xe1, Buffer.concat([EXIF_PREFIX, tiff]));

export const jpegXmpSegment = (packet: Buffer | string) =>
  jpegSegment(
    0xe1,
    Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(packet)]),
  );

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(data, crc32(Buffer.from(type, 'latin1'))));
  return Buffer.concat([head, data, tail]);
}

export function pngWith(width: number, height: number, ...chunks: Buffer[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...chunks,
    pngChunk('IDAT', Buffer.alloc(16, 0x5a)),
    pngChunk('IEND'),
  ]);
}

export const pngItxt = (keyword: string, text: Buffer | string) =>
  pngChunk(
    'iTXt',
    Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0, 0, 0, 0, 0]),
      Buffer.from(text),
    ]),
  );

export function pngChunksInOrder(file: Buffer): { type: string; crcOk: boolean }[] {
  const chunks: { type: string; crcOk: boolean }[] = [];
  let pos = 8;
  while (pos + 12 <= file.length) {
    const length = file.readUInt32BE(pos);
    const type = file.subarray(pos + 4, pos + 8);
    const data = file.subarray(pos + 8, pos + 8 + length);
    chunks.push({
      type: type.toString('latin1'),
      crcOk: file.readUInt32BE(pos + 8 + length) === crc32(data, crc32(type)),
    });
    pos += 12 + length;
  }
  return chunks;
}

export const webpChunk = (fourcc: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
};

export function webpWith(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

export const GIF_XMP_TRAILER = Buffer.from([
  1,
  ...Array.from({ length: 256 }, (_, i) => 255 - i),
  0,
]);

export function gifWithXmp(packet: Buffer | string): Buffer {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(2, 6);
  header.writeUInt16LE(2, 8);
  return Buffer.concat([
    header,
    Buffer.from([0x21, 0xff, 11]),
    Buffer.from('XMP DataXMP', 'latin1'),
    Buffer.from(packet),
    GIF_XMP_TRAILER,
    Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, 2, 0x44, 0x01, 0]),
    Buffer.from([0x3b]),
  ]);
}

export function atom(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

export function mp4With(...atoms: Buffer[]): Buffer {
  return Buffer.concat([
    atom('ftyp', Buffer.from('isom\0\0\x02\0isommp42', 'latin1')),
    atom('mdat', Buffer.alloc(64, 0x5a)),
    ...atoms,
  ]);
}

export function qtText(type: string, text: string): Buffer {
  const value = Buffer.from(text, 'latin1');
  const head = Buffer.alloc(4);
  head.writeUInt16BE(value.length, 0);
  head.writeUInt16BE(0x55c4, 2);
  return atom(type, head, value);
}

export const XYZ = '©xyz';

export function keyedMeta(values: [key: string, value: string][]): Buffer {
  const keys = values.map(([key]) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(key.length + 8);
    head.write('mdta', 4, 'latin1');
    return Buffer.concat([head, Buffer.from(key, 'latin1')]);
  });
  const counts = Buffer.alloc(8);
  counts.writeUInt32BE(values.length, 4);
  const items = values.map(([, value], i) => {
    const index = Buffer.alloc(4);
    index.writeUInt32BE(i + 1);
    const dataHead = Buffer.alloc(8);
    dataHead.writeUInt32BE(1, 0);
    return atom(index.toString('latin1'), atom('data', dataHead, Buffer.from(value, 'latin1')));
  });
  return atom(
    'meta',
    atom('hdlr', Buffer.alloc(24)),
    atom('keys', counts, ...keys),
    atom('ilst', ...items),
  );
}

export interface ReadTag {
  tag: number;
  type: number;
  count: number;
  value: number;
  short: number;
}

export function readIfd0(tiff: Buffer): ReadTag[] {
  const little = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const at = u32(4);
  return Array.from({ length: u16(at) }, (_, i) => {
    const entry = at + 2 + i * 12;
    return {
      tag: u16(entry),
      type: u16(entry + 2),
      count: u32(entry + 4),
      value: u32(entry + 8),
      short: u16(entry + 8),
    };
  });
}

export function tiffOf(file: Buffer): Buffer {
  const png = file.indexOf('eXIf', 0, 'latin1');
  if (file[0] === 0x89 && png !== -1) return file.subarray(png + 4);
  const webp = file.indexOf('EXIF', 0, 'latin1');
  if (file[0] === 0x52 && webp !== -1) {
    const start = webp + 8;
    return file.subarray(
      file.toString('latin1', start, start + 5) === 'Exif\0' ? start + 6 : start,
    );
  }
  return file.subarray(file.indexOf('Exif\0', 0, 'latin1') + 6);
}

export const orientationIn = (file: Buffer): number | undefined =>
  readIfd0(tiffOf(file)).find((entry) => entry.tag === ORIENTATION)?.short;

export const hasGpsPointer = (file: Buffer): boolean =>
  readIfd0(tiffOf(file)).some((entry) => entry.tag === GPS_POINTER);

export function changedRanges(before: Buffer, after: Buffer): [number, number][] {
  const ranges: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= before.length; i++) {
    const differs = i < before.length && before[i] !== after[i];
    if (differs && start === -1) start = i;
    if (!differs && start !== -1) {
      ranges.push([start, i]);
      start = -1;
    }
  }
  return ranges;
}

export function tagsBalance(xml: string): boolean {
  const open: string[] = [];
  for (const match of xml.matchAll(/<(\?[^>]*\?|!--[\s\S]*?--|\/?)([^\s/>]*)[^>]*?(\/?)>/g)) {
    const [, kind, name, selfClosed] = match;
    if (kind?.startsWith('?') || kind?.startsWith('!')) continue;
    if (selfClosed) continue;
    if (kind === '/') {
      if (open.pop() !== name) return false;
    } else {
      open.push(name!);
    }
  }
  return open.length === 0;
}
