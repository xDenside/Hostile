import type { FileHandle } from 'node:fs/promises';
import { LIMITS, type ProfileImageType } from '@hostile/shared';
import { exifOrientation, isJpegExifSegment, orientationSwapsSides } from './exif.js';

export type ImageRejection = 'unsupported' | 'corrupt' | 'too_many_pixels';

export type ImageSniff =
  | { ok: true; type: ProfileImageType; width: number; height: number }
  | { ok: false; reason: ImageRejection };

export type ImageFileSniff =
  | { ok: true; type: ProfileImageType; width: number; height: number; cost: DecodeCost }
  | { ok: false; reason: ImageRejection };

interface Dimensions {
  width: number;
  height: number;
  reach?: number;
  canvasPixels?: number;
  animationPixels?: number;
}

export interface DecodeCost {
  canvasPixels: number;
  animationPixels: number;
}

export const DECODE_BYTES_FREE = 128 * 1024 * 1024;

export const DECODE_BYTES_PER_FILE_BYTE = 160;

export const ANIMATION_PIXELS_MAX = 4_000_000_000;

export function decodeRefusal(cost: DecodeCost, fileBytes: number): 'memory' | 'animation' | null {
  if (cost.animationPixels > ANIMATION_PIXELS_MAX) return 'animation';
  const decoded = cost.canvasPixels * 4;
  return decoded > DECODE_BYTES_FREE + fileBytes * DECODE_BYTES_PER_FILE_BYTE ? 'memory' : null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_END_OF_IMAGE = Buffer.from([0xff, 0xd9]);

interface Read {
  offset: number;
  length: number;
}
type Parser = Generator<Read, Dimensions | null, Buffer>;

export const hasAscii = (bytes: Buffer, offset: number, text: string): boolean =>
  bytes.length >= offset + text.length &&
  bytes.toString('latin1', offset, offset + text.length) === text;

const drawnAs = (dimensions: Dimensions, orientation: number | null): Dimensions =>
  orientationSwapsSides(orientation)
    ? { ...dimensions, width: dimensions.height, height: dimensions.width }
    : dimensions;

export function detectImageType(bytes: Buffer): ProfileImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP')) return 'image/webp';
  return null;
}

const EXIF_ORIENTATION_READ = 64 * 1024;

function* parsePng(size: number): Parser {
  const ihdrEnd = 8 + 8 + 13 + 4;
  if (size < ihdrEnd) return null;
  const head = yield { offset: 0, length: ihdrEnd };
  if (head.readUInt32BE(8) !== 13 || !hasAscii(head, 12, 'IHDR')) return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);

  let pos = 8;
  let animationPixels = 0;
  let orientation: number | null = null;
  let pixelsBegun = false;
  while (pos + 12 <= size) {
    const chunk = yield { offset: pos, length: 8 };
    const next = pos + 12 + chunk.readUInt32BE(0);
    if (next > size) return null;
    if (hasAscii(chunk, 4, 'IEND')) {
      return drawnAs(
        animationPixels ? { width, height, animationPixels } : { width, height },
        orientation,
      );
    }
    if (hasAscii(chunk, 4, 'IDAT')) pixelsBegun = true;
    if (hasAscii(chunk, 4, 'eXIf') && orientation === null && !pixelsBegun) {
      const length = Math.min(chunk.readUInt32BE(0), EXIF_ORIENTATION_READ);
      orientation = exifOrientation(yield { offset: pos + 8, length });
    }
    if (hasAscii(chunk, 4, 'fcTL') && chunk.readUInt32BE(0) >= 12) {
      const frame = yield { offset: pos + 8, length: 12 };
      animationPixels += frame.readUInt32BE(4) * frame.readUInt32BE(8);
    }
    pos = next;
  }
  return null;
}

const isJpegStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

export const isJpegStandaloneMarker = (marker: number): boolean =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

const JPEG_SCAN_WINDOW = 64 * 1024;

function* hasJpegEndOfImage(from: number, size: number): Generator<Read, boolean, Buffer> {
  let end = size;
  while (end - from >= JPEG_END_OF_IMAGE.length) {
    const start = Math.max(from, end - JPEG_SCAN_WINDOW);
    const window = yield { offset: start, length: end - start };
    if (window.includes(JPEG_END_OF_IMAGE)) return true;
    end = start + 1;
  }
  return false;
}

function* parseJpeg(size: number): Parser {
  let dimensions: Dimensions | null = null;
  let orientation: number | null = null;
  let pos = 2;
  while (pos < size) {
    let byte = (yield { offset: pos, length: 1 })[0];
    if (byte !== 0xff) return null;
    while (byte === 0xff) {
      pos++;
      if (pos >= size) return null;
      byte = (yield { offset: pos, length: 1 })[0];
    }
    const marker = byte!;
    pos++;

    if (marker === 0xda) {
      return dimensions && (yield* hasJpegEndOfImage(pos, size))
        ? drawnAs(dimensions, orientation)
        : null;
    }
    if (marker === 0x00 || marker === 0xd9) return null;
    if (isJpegStandaloneMarker(marker)) continue;

    if (pos + 2 > size) return null;
    const length = (yield { offset: pos, length: 2 }).readUInt16BE(0);
    if (length < 2 || pos + length > size) return null;
    if (isJpegStartOfFrame(marker)) {
      if (dimensions || length < 8) return null;
      const frame = yield { offset: pos + 3, length: 4 };
      dimensions = { height: frame.readUInt16BE(0), width: frame.readUInt16BE(2) };
    }
    if (marker === 0xe1 && orientation === null) {
      const payload = yield { offset: pos + 2, length: length - 2 };
      if (isJpegExifSegment(payload)) orientation = exifOrientation(payload);
    }
    pos += length;
  }
  return null;
}

export const gifColorTableSize = (flags: number): number =>
  flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0;

function* parseGif(fileSize: number): Parser {
  if (fileSize < 13) return null;
  const header = yield { offset: 0, length: 13 };
  const width = header.readUInt16LE(6);
  const height = header.readUInt16LE(8);
  let right = 0;
  let bottom = 0;
  let frames = 0;
  let animationPixels = 0;
  let pos = 13 + gifColorTableSize(header[10]!);

  for (;;) {
    if (pos >= fileSize) return null;
    const block = (yield { offset: pos, length: 1 })[0];
    pos++;
    if (block === 0x3b) {
      if (frames === 0) return null;
      return {
        width,
        height,
        reach: Math.max(right, bottom),
        canvasPixels: Math.max(width, right) * Math.max(height, bottom),
        animationPixels,
      };
    }
    if (block === 0x21) {
      pos += 1;
    } else if (block === 0x2c) {
      if (pos + 9 > fileSize) return null;
      const frame = yield { offset: pos, length: 9 };
      right = Math.max(right, frame.readUInt16LE(0) + frame.readUInt16LE(4));
      bottom = Math.max(bottom, frame.readUInt16LE(2) + frame.readUInt16LE(6));
      animationPixels += frame.readUInt16LE(4) * frame.readUInt16LE(6);
      frames += 1;
      pos += 9 + gifColorTableSize(frame[8]!) + 1;
    } else {
      return null;
    }
    for (;;) {
      if (pos >= fileSize) return null;
      const subBlock = (yield { offset: pos, length: 1 })[0]!;
      pos++;
      if (subBlock === 0) break;
      pos += subBlock;
    }
  }
}

function* parseWebp(fileSize: number): Parser {
  if (fileSize < 20) return null;
  const bytes = yield { offset: 0, length: Math.min(fileSize, 20 + 10) };
  const riffEnd = 8 + bytes.readUInt32LE(4);
  if (riffEnd > fileSize) return null;
  const size = bytes.readUInt32LE(16);
  const data = 20;
  if (data + size > riffEnd) return null;

  if (hasAscii(bytes, 12, 'VP8 ')) {
    if (size < 10 || bytes[data]! & 0x01) return null;
    if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a)
      return null;
    return {
      width: bytes.readUInt16LE(data + 6) & 0x3fff,
      height: bytes.readUInt16LE(data + 8) & 0x3fff,
    };
  }
  if (hasAscii(bytes, 12, 'VP8L')) {
    if (size < 5 || bytes[data] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(data + 1);
    if (bits >>> 29 !== 0) return null;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (hasAscii(bytes, 12, 'VP8X')) {
    if (size < 10) return null;
    const width = bytes.readUIntLE(data + 4, 3) + 1;
    const height = bytes.readUIntLE(data + 7, 3) + 1;
    if (!(bytes[data]! & 0x02)) return { width, height };
    let animationPixels = 0;
    let pos = data + size + (size % 2);
    while (pos + 8 <= riffEnd) {
      const chunk = yield { offset: pos, length: Math.min(20, riffEnd - pos) };
      const length = chunk.readUInt32LE(4);
      if (hasAscii(chunk, 0, 'ANMF') && chunk.length >= 20) {
        animationPixels += (chunk.readUIntLE(14, 3) + 1) * (chunk.readUIntLE(17, 3) + 1);
      }
      pos += 8 + length + (length % 2);
    }
    return { width, height, animationPixels };
  }
  return null;
}

const PARSERS: Record<ProfileImageType, (size: number) => Parser> = {
  'image/png': parsePng,
  'image/jpeg': parseJpeg,
  'image/gif': parseGif,
  'image/webp': parseWebp,
};

function verdict(type: ProfileImageType, parsed: Dimensions | null, maxEdge: number): ImageSniff {
  if (!parsed || parsed.width === 0 || parsed.height === 0) return { ok: false, reason: 'corrupt' };
  const { width, height, reach = 0 } = parsed;
  if (Math.max(width, height, reach) > maxEdge) return { ok: false, reason: 'too_many_pixels' };
  return { ok: true, type, width, height };
}

export function sniffImage(
  bytes: Buffer,
  maxEdge: number = LIMITS.profileImageMaxEdge,
): ImageSniff {
  const type = detectImageType(bytes);
  if (!type) return { ok: false, reason: 'unsupported' };
  const parser = PARSERS[type](bytes.length);
  let step = parser.next();
  while (!step.done) {
    const { offset, length } = step.value;
    step = parser.next(bytes.subarray(offset, offset + length));
  }
  return verdict(type, step.value, maxEdge);
}

const FILE_READ_WINDOW = 64 * 1024;

export async function sniffImageFile(
  file: FileHandle,
  size: number,
  type: ProfileImageType,
  maxEdge: number,
): Promise<ImageFileSniff> {
  let window = Buffer.alloc(0);
  let windowStart = 0;
  const parser = PARSERS[type](size);
  let step = parser.next();
  while (!step.done) {
    const { offset, length } = step.value;
    if (offset < windowStart || offset + length > windowStart + window.length) {
      const buffer = Buffer.allocUnsafe(Math.max(length, FILE_READ_WINDOW));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      window = buffer.subarray(0, bytesRead);
      windowStart = offset;
    }
    const from = offset - windowStart;
    step = parser.next(window.subarray(from, from + length));
  }
  const parsed = step.value;
  const result = verdict(type, parsed, maxEdge);
  if (!result.ok) return result;
  return {
    ...result,
    cost: {
      canvasPixels: parsed?.canvasPixels ?? result.width * result.height,
      animationPixels: parsed?.animationPixels ?? 0,
    },
  };
}
