import type { FileHandle } from 'node:fs/promises';
import { crc32, inflateSync } from 'node:zlib';
import type { AttachmentType, ProfileImageType } from '@hostile/shared';
import { exifThumbnail, isJpegExifSegment, tiffInExifBlock, withoutGps } from './exif.js';
import {
  gifColorTableSize,
  hasAscii,
  isJpegStandaloneMarker,
  JPEG_END_OF_IMAGE,
} from './image-sniff.js';
import { blankXmpLocation, namesLocation } from './xmp-location.js';

export type LocationProblem =
  | 'exif_malformed'
  | 'xmp_malformed'
  | 'gif_xmp'
  | 'jpeg_structure'
  | 'png_structure'
  | 'png_text'
  | 'webp_structure'
  | 'mp4_structure'
  | 'mp4_compressed'
  | 'metadata_too_large'
  | 'too_many_structures'
  | 'unexpected';

export interface LocationStrip {
  bytesChanged: number;
  problems: LocationProblem[];
}

const METADATA_READ_MAX = 8 * 1024 * 1024;

const METADATA_TOTAL_MAX = 32 * 1024 * 1024;

const WALK_STEPS_MAX = 200_000;

const SCAN_WINDOW = 64 * 1024;
const SMALL_WINDOW = 4096;
const FILE_READ_WINDOW = 64 * 1024;

const EMBEDDED_FILES_MAX = 32;

interface Read {
  offset: number;
  length: number;
}

interface Patch {
  offset: number;
  bytes: Buffer;
}

type Walk<T = void> = Generator<Read, T, Buffer>;

class Plan {
  readonly patches: Patch[] = [];
  readonly problems = new Set<LocationProblem>();
  private steps = 0;
  private metadataBytes = 0;

  constructor(readonly size: number) {}

  note(problem: LocationProblem): void {
    this.problems.add(problem);
  }

  step(): boolean {
    this.steps++;
    if (this.steps <= WALK_STEPS_MAX) return true;
    this.note('too_many_structures');
    return false;
  }

  mayHold(length: number): boolean {
    if (length > METADATA_READ_MAX || this.metadataBytes + length > METADATA_TOTAL_MAX) {
      this.note('metadata_too_large');
      return false;
    }
    this.metadataBytes += length;
    return true;
  }

  overwrite(offset: number, bytes: Buffer): void {
    if (!bytes.length) return;
    if (offset < 0 || offset + bytes.length > this.size) {
      this.note('unexpected');
      return;
    }
    this.patches.push({ offset, bytes });
  }

  replace(offset: number, before: Buffer, after: Buffer): void {
    let first = 0;
    while (first < before.length && before[first] === after[first]) first++;
    if (first === before.length) return;
    let last = before.length - 1;
    while (before[last] === after[last]) last--;
    this.overwrite(offset + first, Buffer.from(after.subarray(first, last + 1)));
  }
}

function* cleanTiff(plan: Plan, tiff: Buffer, at: number, depth: number): Walk {
  const cleaned = withoutGps(tiff);
  if (cleaned === 'malformed') {
    plan.note('exif_malformed');
    return;
  }
  if (cleaned) plan.replace(at, tiff, cleaned);
  const thumbnail = exifThumbnail(tiff);
  if (thumbnail && depth < 2) {
    const start = at + thumbnail.offset;
    yield* walkJpeg(plan, start, start + thumbnail.length, depth + 1);
  }
}

function cleanXmp(plan: Plan, packet: Buffer, at: number, partial = false): void {
  const blanked = blankXmpLocation(packet, partial);
  if (blanked === 'malformed') plan.note('xmp_malformed');
  else if (blanked) plan.replace(at, packet, blanked);
}

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const XMP_SEGMENT = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXTENSION_SEGMENT = 'http://ns.adobe.com/xmp/extension/\0';
const XMP_EXTENSION_HEADER = XMP_EXTENSION_SEGMENT.length + 32 + 4 + 4;
const PHOTOSHOP_SEGMENT = 'Photoshop 3.0\0';

const PHOTOSHOP_IPTC = 0x0404;
const PHOTOSHOP_EXIF_1 = 0x0422;
const PHOTOSHOP_EXIF_3 = 0x0423;
const PHOTOSHOP_XMP = 0x0424;

const IPTC_PLACE_DATASETS = new Set([26, 27, 90, 92, 95, 100, 101]);

function blankIptcPlaces(out: Buffer, from: number, to: number): void {
  let pos = from;
  while (pos + 5 <= to && out[pos] === 0x1c) {
    const length = out.readUInt16BE(pos + 3);
    if (length & 0x8000) return;
    const value = pos + 5;
    if (value + length > to) return;
    if (out[pos + 1] === 2 && IPTC_PLACE_DATASETS.has(out[pos + 2]!)) {
      out.fill(0x20, value, value + length);
    }
    pos = value + length;
  }
}

function* cleanPhotoshop(plan: Plan, payload: Buffer, at: number, depth: number): Walk {
  const out = Buffer.from(payload);
  let pos = PHOTOSHOP_SEGMENT.length;
  while (pos + 12 <= out.length && hasAscii(out, pos, '8BIM')) {
    if (!plan.step()) break;
    const nameLength = out[pos + 6]!;
    const sizeAt = pos + 6 + nameLength + 1 + ((nameLength + 1) % 2);
    if (sizeAt + 4 > out.length) break;
    const size = out.readUInt32BE(sizeAt);
    const data = sizeAt + 4;
    if (data + size > out.length) break;
    const id = out.readUInt16BE(pos + 4);
    if (id === PHOTOSHOP_IPTC) {
      blankIptcPlaces(out, data, data + size);
    } else if (id === PHOTOSHOP_EXIF_1 || id === PHOTOSHOP_EXIF_3) {
      yield* cleanTiff(plan, payload.subarray(data, data + size), at + data, depth);
    } else if (id === PHOTOSHOP_XMP) {
      cleanXmp(plan, payload.subarray(data, data + size), at + data);
    }
    pos = data + size + (size % 2);
  }
  plan.replace(at, payload, out);
}

function* cleanJpegSegment(
  plan: Plan,
  marker: number,
  payload: Buffer,
  at: number,
  depth: number,
): Walk {
  if (marker === 0xed) {
    if (hasAscii(payload, 0, PHOTOSHOP_SEGMENT)) yield* cleanPhotoshop(plan, payload, at, depth);
    return;
  }
  if (isJpegExifSegment(payload)) {
    yield* cleanTiff(plan, tiffInExifBlock(payload), at + 6, depth);
  } else if (hasAscii(payload, 0, XMP_SEGMENT)) {
    const start = XMP_SEGMENT.length;
    cleanXmp(plan, payload.subarray(start), at + start);
  } else if (hasAscii(payload, 0, XMP_EXTENSION_SEGMENT)) {
    cleanXmp(plan, payload.subarray(XMP_EXTENSION_HEADER), at + XMP_EXTENSION_HEADER, true);
  }
}

function* findInFile(needle: Buffer, from: number, end: number): Walk<number> {
  let pos = from;
  while (pos + needle.length <= end) {
    const window = yield { offset: pos, length: Math.min(SCAN_WINDOW, end - pos) };
    if (window.length < needle.length) return -1;
    const at = window.indexOf(needle);
    if (at !== -1) return pos + at;
    pos += window.length - needle.length + 1;
  }
  return -1;
}

function* walkJpeg(plan: Plan, start: number, end: number, depth: number): Walk<number | null> {
  const stumble = (): null => {
    if (depth === 0) plan.note('jpeg_structure');
    return null;
  };
  const opening = yield { offset: start, length: Math.min(2, end - start) };
  if (opening.length < 2 || opening[0] !== 0xff || opening[1] !== 0xd8) return stumble();
  let pos = start + 2;
  while (pos < end) {
    if (!plan.step()) return null;
    const window = yield { offset: pos, length: Math.min(SMALL_WINDOW, end - pos) };
    if (window[0] !== 0xff) return stumble();
    let i = 1;
    while (i < window.length && window[i] === 0xff) i++;
    if (i === window.length) {
      pos += i - 1;
      if (window.length < 2) return stumble();
      continue;
    }
    const marker = window[i]!;
    pos += i + 1;

    if (marker === 0xda) {
      const found = yield* findInFile(JPEG_END_OF_IMAGE, pos, end);
      return found === -1 ? stumble() : found + JPEG_END_OF_IMAGE.length;
    }
    if (marker === 0xd9) return pos;
    if (marker === 0x00) return stumble();
    if (isJpegStandaloneMarker(marker)) continue;

    if (pos + 2 > end) return stumble();
    const length = (yield { offset: pos, length: 2 }).readUInt16BE(0);
    if (length < 2 || pos + length > end) return stumble();
    if ((marker === 0xe1 || marker === 0xed) && plan.mayHold(length)) {
      const payload = yield { offset: pos + 2, length: length - 2 };
      yield* cleanJpegSegment(plan, marker, payload, pos + 2, depth);
    }
    pos += length;
  }
  return stumble();
}

function* walkJpegTrailer(plan: Plan, from: number): Walk {
  let pos = from;
  let candidates = 0;
  while (pos + 4 <= plan.size && candidates < EMBEDDED_FILES_MAX) {
    const window = yield { offset: pos, length: Math.min(SCAN_WINDOW, plan.size - pos) };
    const jpegAt = window.indexOf(JPEG_START);
    const ftypAt = window.indexOf('ftyp', 0, 'latin1');
    const movieAt = ftypAt >= 4 ? ftypAt - 4 : -1;
    if (jpegAt === -1 && movieAt === -1) {
      if (pos + window.length >= plan.size) return;
      pos += Math.max(1, window.length - 7);
      continue;
    }
    candidates++;
    if (movieAt !== -1 && (jpegAt === -1 || movieAt < jpegAt)) {
      const stop = yield* walkMp4(plan, pos + movieAt, plan.size, true);
      pos = Math.max(stop, pos + ftypAt + 1);
    } else {
      const stop = yield* walkJpeg(plan, pos + jpegAt, plan.size, 1);
      pos = stop ?? pos + jpegAt + JPEG_START.length;
    }
  }
  if (candidates >= EMBEDDED_FILES_MAX) plan.note('too_many_structures');
}

function* walkJpegFile(plan: Plan): Walk {
  const end = yield* walkJpeg(plan, 0, plan.size, 0);
  if (end !== null && end < plan.size) yield* walkJpegTrailer(plan, end);
}

const PNG_SIGNATURE_BYTES = 8;
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp';
const PNG_RAW_PROFILE = /^Raw profile type (exif|app1|xmp|iptc|8bim)$/i;
const PNG_NOTHING = 'nuLl';
const PNG_KEYWORD_MAX = 79;

function pngCrc(type: Buffer, data: Buffer): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(crc32(data, crc32(type)));
  return out;
}

function eraseChunk(plan: Plan, pos: number, length: number): void {
  if (length > METADATA_READ_MAX) {
    plan.note('metadata_too_large');
    return;
  }
  const type = Buffer.from(PNG_NOTHING, 'latin1');
  const data = Buffer.alloc(length);
  plan.overwrite(pos + 4, Buffer.concat([type, data, pngCrc(type, data)]));
}

function pngTextStart(
  type: string,
  data: Buffer,
  keywordEnd: number,
): { start: number; compressed: boolean } | null {
  if (type === 'tEXt') return { start: keywordEnd + 1, compressed: false };
  if (type === 'zTXt') return { start: keywordEnd + 2, compressed: true };
  const language = data.indexOf(0, keywordEnd + 3);
  if (language === -1) return null;
  const translated = data.indexOf(0, language + 1);
  if (translated === -1) return null;
  return { start: translated + 1, compressed: data[keywordEnd + 1] === 1 };
}

function* cleanPngText(plan: Plan, type: string, pos: number, length: number): Walk {
  const dataAt = pos + 8;
  const head = yield { offset: dataAt, length: Math.min(length, PNG_KEYWORD_MAX + 1) };
  const keywordEnd = head.indexOf(0);
  if (keywordEnd === -1) return;
  const keyword = head.toString('latin1', 0, keywordEnd);
  if (PNG_RAW_PROFILE.test(keyword)) {
    eraseChunk(plan, pos, length);
    return;
  }
  if (keyword !== PNG_XMP_KEYWORD || !plan.mayHold(length)) return;

  const data = yield { offset: dataAt, length };
  const text = pngTextStart(type, data, keywordEnd);
  if (!text) {
    plan.note('png_text');
    return;
  }
  const packet = data.subarray(text.start);
  if (text.compressed) {
    let inflated: Buffer;
    try {
      inflated = inflateSync(packet, { maxOutputLength: METADATA_READ_MAX });
    } catch {
      plan.note('png_text');
      return;
    }
    const blanked = blankXmpLocation(inflated);
    if (blanked === 'malformed') plan.note('xmp_malformed');
    else if (blanked) eraseChunk(plan, pos, length);
    return;
  }
  const blanked = blankXmpLocation(packet);
  if (blanked === 'malformed') {
    plan.note('xmp_malformed');
    return;
  }
  if (!blanked) return;
  const typeBytes = Buffer.from(type, 'latin1');
  const after = Buffer.concat([data.subarray(0, text.start), blanked]);
  plan.replace(dataAt, data, after);
  plan.overwrite(dataAt + length, pngCrc(typeBytes, after));
}

function* cleanPngExif(plan: Plan, pos: number, length: number): Walk {
  if (!plan.mayHold(length)) return;
  const dataAt = pos + 8;
  const data = yield { offset: dataAt, length };
  const tiff = tiffInExifBlock(data);
  const at = dataAt + (data.length - tiff.length);
  const cleaned = withoutGps(tiff);
  if (cleaned === 'malformed') {
    plan.note('exif_malformed');
    return;
  }
  if (!cleaned) return;
  plan.replace(at, tiff, cleaned);
  const after = Buffer.concat([data.subarray(0, data.length - tiff.length), cleaned]);
  plan.overwrite(dataAt + length, pngCrc(Buffer.from('eXIf', 'latin1'), after));
}

function* walkPng(plan: Plan): Walk {
  let pos = PNG_SIGNATURE_BYTES;
  while (pos + 12 <= plan.size) {
    if (!plan.step()) return;
    const chunk = yield { offset: pos, length: 8 };
    const length = chunk.readUInt32BE(0);
    const type = chunk.toString('latin1', 4, 8);
    const next = pos + 12 + length;
    if (next > plan.size) {
      plan.note('png_structure');
      return;
    }
    if (type === 'IEND') return;
    if (type === 'eXIf') yield* cleanPngExif(plan, pos, length);
    else if (type === 'iTXt' || type === 'zTXt' || type === 'tEXt') {
      yield* cleanPngText(plan, type, pos, length);
    }
    pos = next;
  }
}

function* walkWebp(plan: Plan): Walk {
  if (plan.size < 12) return;
  const riff = yield { offset: 0, length: 12 };
  const riffEnd = Math.min(8 + riff.readUInt32LE(4), plan.size);
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    if (!plan.step()) return;
    const chunk = yield { offset: pos, length: 8 };
    const fourcc = chunk.toString('latin1', 0, 4);
    const length = chunk.readUInt32LE(4);
    const data = pos + 8;
    if (data + length > riffEnd) {
      plan.note('webp_structure');
      return;
    }
    if ((fourcc === 'EXIF' || fourcc === 'XMP ') && plan.mayHold(length)) {
      const bytes = yield { offset: data, length };
      if (fourcc === 'XMP ') cleanXmp(plan, bytes, data);
      else {
        const tiff = tiffInExifBlock(bytes);
        yield* cleanTiff(plan, tiff, data + (bytes.length - tiff.length), 0);
      }
    }
    pos = data + length + (length % 2);
  }
}

const GIF_XMP_APPLICATION = 'XMP DataXMP';

function* skipSubBlocks(plan: Plan, from: number): Walk<number | null> {
  let pos = from;
  while (pos < plan.size) {
    const window = yield { offset: pos, length: Math.min(SMALL_WINDOW, plan.size - pos) };
    let i = 0;
    while (i < window.length) {
      const length = window[i]!;
      if (length === 0) return pos + i + 1;
      i += 1 + length;
    }
    pos += i;
  }
  return null;
}

function* cleanGifXmp(plan: Plan, from: number): Walk<void> {
  const end = yield* skipSubBlocks(plan, from);
  if (end === null) return;
  const length = end - 1 - from;
  if (!plan.mayHold(length)) return;
  const packet = yield { offset: from, length };
  const blanked = blankXmpLocation(packet);
  if (blanked === 'malformed') {
    plan.note('xmp_malformed');
    return;
  }
  if (!blanked) return;
  let hop = 0;
  while (hop < blanked.length && blanked[hop] !== 0) hop += 1 + blanked[hop]!;
  if (hop !== blanked.length) {
    plan.note('gif_xmp');
    return;
  }
  plan.replace(from, packet, blanked);
}

function* walkGif(plan: Plan): Walk {
  if (plan.size < 13) return;
  const header = yield { offset: 0, length: 13 };
  let pos = 13 + gifColorTableSize(header[10]!);
  while (pos < plan.size) {
    if (!plan.step()) return;
    const block = (yield { offset: pos, length: 1 })[0];
    pos++;
    if (block === 0x3b) return;
    if (block === 0x21) {
      if (pos + 1 > plan.size) return;
      const label = (yield { offset: pos, length: 1 })[0];
      pos++;
      if (label === 0xff && pos + 12 <= plan.size) {
        const application = yield { offset: pos, length: 12 };
        if (application[0] === 11 && hasAscii(application, 1, GIF_XMP_APPLICATION)) {
          yield* cleanGifXmp(plan, pos + 12);
        }
      }
    } else if (block === 0x2c) {
      if (pos + 9 > plan.size) return;
      const frame = yield { offset: pos, length: 9 };
      pos += 9 + gifColorTableSize(frame[8]!) + 1;
    } else {
      return;
    }
    const after = yield* skipSubBlocks(plan, pos);
    if (after === null) return;
    pos = after;
  }
}

interface Atom {
  type: string;
  code: number;
  start: number;
  body: number;
  end: number;
}

const LOCATION_ATOMS = new Set(['©xyz', 'loci']);
const XMP_UUID = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');
const META_CHILDREN = new Set(['hdlr', 'keys', 'ilst', 'free']);
const KEYS_MAX_BYTES = 1024 * 1024;

function* readAtom(
  plan: Plan,
  pos: number,
  limit: number,
  options: { topLevel?: boolean; quiet?: boolean } = {},
): Walk<Atom | null> {
  if (!plan.step()) return null;
  const head = yield { offset: pos, length: Math.min(16, limit - pos) };
  if (head.length < 8) return null;
  const declared = head.readUInt32BE(0);
  const start = pos;
  let body = pos + 8;
  let end: number;
  if (declared === 0) {
    if (!options.topLevel) return null;
    end = limit;
  } else if (declared === 1) {
    if (head.length < 16) return null;
    body = pos + 16;
    end = pos + Number(head.readBigUInt64BE(8));
  } else {
    end = pos + declared;
  }
  if (end < body || end > limit) {
    if (!options.quiet) plan.note('mp4_structure');
    return null;
  }
  return {
    type: head.toString('latin1', 4, 8),
    code: head.readUInt32BE(4),
    start,
    body,
    end,
  };
}

function* eachChild(plan: Plan, from: number, to: number, visit: (atom: Atom) => Walk): Walk {
  let pos = from;
  while (pos + 8 <= to) {
    const atom = yield* readAtom(plan, pos, to);
    if (!atom) return;
    yield* visit(atom);
    pos = atom.end;
  }
}

function eraseAtom(plan: Plan, atom: Atom): void {
  plan.overwrite(atom.start + 4, Buffer.from('free', 'latin1'));
  const length = atom.end - atom.body;
  if (length > METADATA_READ_MAX) plan.note('metadata_too_large');
  else plan.overwrite(atom.body, Buffer.alloc(length));
}

function* cleanXmpAtom(plan: Plan, from: number, end: number): Walk {
  const length = end - from;
  if (!plan.mayHold(length)) return;
  cleanXmp(plan, yield { offset: from, length }, from);
}

function* locationKeys(plan: Plan, atom: Atom): Walk<Set<number>> {
  const found = new Set<number>();
  const length = atom.end - atom.body;
  if (length > KEYS_MAX_BYTES) {
    plan.note('metadata_too_large');
    return found;
  }
  if (!plan.mayHold(length)) return found;
  const keys = yield { offset: atom.body, length };
  if (keys.length < 8) return found;
  const count = keys.readUInt32BE(4);
  let pos = 8;
  for (let i = 1; i <= count && pos + 8 <= keys.length; i++) {
    const size = keys.readUInt32BE(pos);
    if (size < 8 || pos + size > keys.length) break;
    if (namesLocation(keys.toString('latin1', pos + 8, pos + size))) found.add(i);
    pos += size;
  }
  return found;
}

function* blankItemData(plan: Plan, item: Atom): Walk {
  let pos = item.body;
  while (pos + 8 <= item.end) {
    const child = yield* readAtom(plan, pos, item.end);
    if (!child) return;
    const length = child.end - child.body - 8;
    if (child.type === 'data' && length > METADATA_READ_MAX) plan.note('metadata_too_large');
    else if (child.type === 'data' && length > 0) {
      plan.overwrite(child.body + 8, Buffer.alloc(length));
    }
    pos = child.end;
  }
}

function* walkMeta(plan: Plan, meta: Atom): Walk {
  const head = yield { offset: meta.body, length: Math.min(8, meta.end - meta.body) };
  const quickTime = head.length === 8 && META_CHILDREN.has(head.toString('latin1', 4, 8));
  const from = meta.body + (quickTime ? 0 : 4);

  const lists: Atom[] = [];
  let located = new Set<number>();
  yield* eachChild(plan, from, meta.end, function* (child) {
    if (child.type === 'keys') located = yield* locationKeys(plan, child);
    else if (child.type === 'ilst') lists.push(child);
  });
  for (const list of lists) {
    yield* eachChild(plan, list.body, list.end, function* (item) {
      if (LOCATION_ATOMS.has(item.type)) eraseAtom(plan, item);
      else if (located.has(item.code)) yield* blankItemData(plan, item);
    });
  }
}

function* walkUdta(plan: Plan, udta: Atom): Walk {
  yield* eachChild(plan, udta.body, udta.end, function* (child) {
    if (LOCATION_ATOMS.has(child.type)) eraseAtom(plan, child);
    else if (child.type === 'meta') yield* walkMeta(plan, child);
    else if (child.type === 'XMP_') yield* cleanXmpAtom(plan, child.body, child.end);
  });
}

function* walkMoov(plan: Plan, moov: Atom): Walk {
  yield* eachChild(plan, moov.body, moov.end, function* (child) {
    if (child.type === 'udta') yield* walkUdta(plan, child);
    else if (child.type === 'meta') yield* walkMeta(plan, child);
    else if (child.type === 'cmov') plan.note('mp4_compressed');
    else if (child.type === 'trak') {
      yield* eachChild(plan, child.body, child.end, function* (part) {
        if (part.type === 'udta') yield* walkUdta(plan, part);
        else if (part.type === 'meta') yield* walkMeta(plan, part);
      });
    }
  });
}

function* walkMp4(plan: Plan, start: number, limit: number, embedded = false): Walk<number> {
  let pos = start;
  while (pos + 8 <= limit) {
    const atom = yield* readAtom(plan, pos, limit, { topLevel: true, quiet: embedded });
    if (!atom) return pos;
    if (atom.type === 'moov') yield* walkMoov(plan, atom);
    else if (atom.type === 'udta') yield* walkUdta(plan, atom);
    else if (atom.type === 'meta') yield* walkMeta(plan, atom);
    else if (atom.type === 'uuid' && atom.end - atom.body >= XMP_UUID.length) {
      const kind = yield { offset: atom.body, length: XMP_UUID.length };
      if (kind.equals(XMP_UUID)) {
        yield* cleanXmpAtom(plan, atom.body + XMP_UUID.length, atom.end);
      }
    }
    pos = atom.end;
  }
  return pos;
}

function* walkMp4File(plan: Plan): Walk {
  yield* walkMp4(plan, 0, plan.size);
}

const WALKERS: Partial<Record<AttachmentType, (plan: Plan) => Walk>> = {
  'image/jpeg': walkJpegFile,
  'image/png': walkPng,
  'image/webp': walkWebp,
  'image/gif': walkGif,
  'video/mp4': walkMp4File,
  'video/quicktime': walkMp4File,
};

const isSystemError = (err: unknown): boolean =>
  err instanceof Error && typeof (err as NodeJS.ErrnoException).syscall === 'string';

function result(plan: Plan): LocationStrip {
  return {
    bytesChanged: plan.patches.reduce((sum, patch) => sum + patch.bytes.length, 0),
    problems: [...plan.problems],
  };
}

export function stripLocationFromBuffer(bytes: Buffer, type: ProfileImageType): LocationStrip {
  const plan = new Plan(bytes.length);
  const walker = WALKERS[type];
  if (!walker) return result(plan);
  try {
    const walk = walker(plan);
    let step = walk.next();
    while (!step.done) {
      const { offset, length } = step.value;
      step = walk.next(bytes.subarray(offset, offset + length));
    }
  } catch {
    plan.note('unexpected');
  }
  for (const { offset, bytes: patch } of plan.patches) patch.copy(bytes, offset);
  return result(plan);
}

export async function stripLocationFromFile(
  file: FileHandle,
  size: number,
  type: AttachmentType,
): Promise<LocationStrip> {
  const plan = new Plan(size);
  const walker = WALKERS[type];
  if (!walker) return result(plan);
  try {
    let window: Buffer = Buffer.alloc(0);
    let windowStart = 0;
    const walk = walker(plan);
    let step = walk.next();
    while (!step.done) {
      const { offset, length } = step.value;
      const wanted = Math.max(0, Math.min(length, size - offset));
      if (wanted > 0 && (offset < windowStart || offset + wanted > windowStart + window.length)) {
        const buffer = Buffer.allocUnsafe(
          Math.min(Math.max(wanted, FILE_READ_WINDOW), size - offset),
        );
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        window = buffer.subarray(0, bytesRead);
        windowStart = offset;
      }
      const from = offset - windowStart;
      step = walk.next(window.subarray(from, from + wanted));
    }
  } catch (err) {
    if (isSystemError(err)) throw err;
    plan.note('unexpected');
  }
  for (const { offset, bytes } of plan.patches) {
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await file.write(
        bytes,
        written,
        bytes.length - written,
        offset + written,
      );
      if (bytesWritten === 0) {
        throw Object.assign(new Error('wrote nothing'), { code: 'EIO', syscall: 'write' });
      }
      written += bytesWritten;
    }
  }
  return result(plan);
}
