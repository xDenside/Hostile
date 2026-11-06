const ORIENTATION_TAG = 0x0112;
const GPS_POINTER_TAG = 0x8825;
const THUMBNAIL_OFFSET_TAG = 0x0201;
const THUMBNAIL_LENGTH_TAG = 0x0202;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_IFD = 13;

const TYPE_BYTES: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  [TYPE_SHORT]: 2,
  [TYPE_LONG]: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  [TYPE_IFD]: 4,
};

const ENTRY_BYTES = 12;
const IFD_CHAIN_MAX = 8;

interface Tiff {
  u16(offset: number): number;
  u32(offset: number): number;
  setU16(offset: number, value: number): void;
  firstIfd: number;
}

function openTiff(bytes: Buffer): Tiff | null {
  if (bytes.length < 8) return null;
  const order = bytes.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const u16 = (offset: number) =>
    little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const u32 = (offset: number) =>
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const setU16 = (offset: number, value: number) => {
    if (little) bytes.writeUInt16LE(value, offset);
    else bytes.writeUInt16BE(value, offset);
  };
  if (u16(2) !== 42) return null;
  return { u16, u32, setU16, firstIfd: u32(4) };
}

function entriesAt(tiff: Tiff, length: number, at: number): number | null {
  if (at < 8 || at + 2 > length) return null;
  return Math.min(tiff.u16(at), Math.floor((length - at - 2) / ENTRY_BYTES));
}

interface Ifd {
  at: number;
  entries: number;
}

function ifdChain(tiff: Tiff, length: number): Ifd[] {
  const chain: Ifd[] = [];
  const seen = new Set<number>();
  let at = tiff.firstIfd;
  while (chain.length < IFD_CHAIN_MAX && !seen.has(at)) {
    seen.add(at);
    const entries = entriesAt(tiff, length, at);
    if (entries === null) break;
    chain.push({ at, entries });
    const next = at + 2 + entries * ENTRY_BYTES;
    if (entries !== tiff.u16(at) || next + 4 > length) break;
    at = tiff.u32(next);
    if (at === 0) break;
  }
  return chain;
}

export function tiffInExifBlock(block: Buffer): Buffer {
  return block.length >= 6 && block.toString('latin1', 0, 5) === 'Exif\0'
    ? block.subarray(6)
    : block;
}

export const isJpegExifSegment = (payload: Buffer): boolean =>
  payload.length >= 6 && payload.toString('latin1', 0, 5) === 'Exif\0';

export function exifOrientation(block: Buffer): number | null {
  const bytes = tiffInExifBlock(block);
  const tiff = openTiff(bytes);
  if (!tiff) return null;
  const entries = entriesAt(tiff, bytes.length, tiff.firstIfd);
  if (entries === null) return null;
  for (let i = 0; i < entries; i++) {
    const entry = tiff.firstIfd + 2 + i * ENTRY_BYTES;
    if (tiff.u16(entry) !== ORIENTATION_TAG) continue;
    if (tiff.u16(entry + 2) !== TYPE_SHORT || tiff.u32(entry + 4) !== 1) return null;
    const value = tiff.u16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

export const orientationSwapsSides = (orientation: number | null): boolean =>
  orientation !== null && orientation >= 5 && orientation <= 8;

const overlaps = (start: number, end: number, ifd: Ifd): boolean =>
  start < ifd.at + 2 + ifd.entries * ENTRY_BYTES + 4 && end > ifd.at;

function zeroGpsIfd(out: Buffer, tiff: Tiff, at: number, chain: Ifd[]): void {
  const safe = (start: number, end: number) => !chain.some((ifd) => overlaps(start, end, ifd));
  const entries = entriesAt(tiff, out.length, at);
  if (entries === null) return;
  for (let i = 0; i < entries; i++) {
    const entry = at + 2 + i * ENTRY_BYTES;
    const size = (TYPE_BYTES[tiff.u16(entry + 2)] ?? 0) * tiff.u32(entry + 4);
    if (size <= 4) continue;
    const value = tiff.u32(entry + 8);
    if (value + size <= out.length && safe(value, value + size)) {
      out.fill(0, value, value + size);
    }
  }
  const end = Math.min(at + 2 + tiff.u16(at) * ENTRY_BYTES + 4, out.length);
  if (safe(at, end)) out.fill(0, at, end);
}

export function withoutGps(bytes: Buffer): Buffer | null | 'malformed' {
  const out = Buffer.from(bytes);
  const tiff = openTiff(out);
  if (!tiff) return 'malformed';
  const chain = ifdChain(tiff, out.length);
  if (!chain.length) return 'malformed';
  let removed = false;
  for (const ifd of chain) {
    const declaredEnd = ifd.at + 2 + tiff.u16(ifd.at) * ENTRY_BYTES + 4;
    let i = 0;
    while (i < ifd.entries) {
      const entry = ifd.at + 2 + i * ENTRY_BYTES;
      if (tiff.u16(entry) !== GPS_POINTER_TAG) {
        i++;
        continue;
      }
      const type = tiff.u16(entry + 2);
      if (type === TYPE_LONG || type === TYPE_IFD) {
        zeroGpsIfd(out, tiff, tiff.u32(entry + 8), chain);
      } else if (type === TYPE_SHORT) {
        zeroGpsIfd(out, tiff, tiff.u16(entry + 8), chain);
      }
      const blockEnd = Math.min(declaredEnd, out.length);
      out.copy(out, entry, entry + ENTRY_BYTES, blockEnd);
      out.fill(0, blockEnd - ENTRY_BYTES, blockEnd);
      tiff.setU16(ifd.at, tiff.u16(ifd.at) - 1);
      ifd.entries--;
      removed = true;
    }
  }
  return removed ? out : null;
}

export function exifThumbnail(bytes: Buffer): { offset: number; length: number } | null {
  const tiff = openTiff(bytes);
  if (!tiff) return null;
  const ifd = ifdChain(tiff, bytes.length)[1];
  if (!ifd) return null;
  let offset: number | null = null;
  let length: number | null = null;
  for (let i = 0; i < ifd.entries; i++) {
    const entry = ifd.at + 2 + i * ENTRY_BYTES;
    const tag = tiff.u16(entry);
    if (tag === THUMBNAIL_OFFSET_TAG) offset = tiff.u32(entry + 8);
    if (tag === THUMBNAIL_LENGTH_TAG) length = tiff.u32(entry + 8);
  }
  if (offset === null || length === null || length < 4 || offset + length > bytes.length) {
    return null;
  }
  return { offset, length };
}
