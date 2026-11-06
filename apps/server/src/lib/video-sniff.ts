import type { AttachmentVideoType } from '@hostile/shared';

export const VIDEO_SNIFF_BYTES = 4096;

const NOT_VIDEO_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'avif',
  'avis',
  'avci',
  'avcs',
  'crx ',
  'jp2 ',
  'jpm ',
  'jpx ',
  'M4A ',
  'M4B ',
  'M4P ',
]);

function sniffIsoBmff(head: Buffer): AttachmentVideoType | null {
  if (head.length < 16) return null;
  if (head.toString('latin1', 4, 8) !== 'ftyp' || head.readUInt32BE(0) < 16) return null;
  const brand = head.toString('latin1', 8, 12);
  if (brand === 'qt  ') return 'video/quicktime';
  return NOT_VIDEO_BRANDS.has(brand) ? null : 'video/mp4';
}

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const EBML_DOC_TYPE_ID = 0x4282;

function readVint(
  bytes: Buffer,
  pos: number,
  maxLength: number,
  keepMarker: boolean,
): { value: number; length: number } | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > maxLength || pos + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[pos + i]!;
  return { value, length };
}

function webmDocType(head: Buffer): string | null {
  if (head.length < EBML_MAGIC.length || !head.subarray(0, 4).equals(EBML_MAGIC)) return null;
  const headerSize = readVint(head, 4, 8, false);
  if (!headerSize) return null;
  let pos = 4 + headerSize.length;
  const end = Math.min(pos + headerSize.value, head.length);
  while (pos < end) {
    const id = readVint(head, pos, 4, true);
    if (!id) return null;
    const size = readVint(head, pos + id.length, 8, false);
    if (!size) return null;
    const data = pos + id.length + size.length;
    if (id.value === EBML_DOC_TYPE_ID) {
      if (data + size.value > head.length) return null;
      return head.toString('latin1', data, data + size.value).replace(/\0+$/, '');
    }
    pos = data + size.value;
  }
  return null;
}

const QUICKTIME_PADDING = new Set(['wide', 'free', 'skip', 'pnot']);

function sniffOldQuickTime(head: Buffer): AttachmentVideoType | null {
  let pos = 0;
  while (pos + 8 <= head.length) {
    const type = head.toString('latin1', pos + 4, pos + 8);
    if (type === 'moov' || type === 'mdat') return 'video/quicktime';
    const size = head.readUInt32BE(pos);
    if (!QUICKTIME_PADDING.has(type) || size < 8) return null;
    pos += size;
  }
  return null;
}

export function sniffVideo(head: Buffer): AttachmentVideoType | null {
  if (webmDocType(head) === 'webm') return 'video/webm';
  return sniffIsoBmff(head) ?? sniffOldQuickTime(head);
}
