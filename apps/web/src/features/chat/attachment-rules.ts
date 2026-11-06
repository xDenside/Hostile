import {
  ATTACHMENT_IMAGE_TYPES,
  ATTACHMENT_VIDEO_TYPES,
  LIMITS,
  type AttachmentKind,
} from '@hostile/shared';

const MB = 1024 * 1024;

export const ATTACH_ACCEPT = [
  'image/*',
  'video/*',
  ...ATTACHMENT_IMAGE_TYPES,
  ...ATTACHMENT_VIDEO_TYPES,
].join(',');

const IMAGE_TYPES = new Set<string>([...ATTACHMENT_IMAGE_TYPES, 'image/jpg']);
const VIDEO_TYPES = new Set<string>([...ATTACHMENT_VIDEO_TYPES, 'video/x-m4v']);

const KIND_BY_EXTENSION: Record<string, AttachmentKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
};

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export function attachmentKindOf(file: Pick<FileLike, 'name' | 'type'>): AttachmentKind | null {
  const type = file.type.split(';')[0]!.trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) return 'image';
  if (VIDEO_TYPES.has(type)) return 'video';
  if (type) return null;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return KIND_BY_EXTENSION[extension] ?? null;
}

export function refusalFor(file: FileLike): string | null {
  const kind = attachmentKindOf(file);
  if (!kind) {
    return `"${file.name}" is not a PNG, JPEG, GIF or WebP image, or an MP4, MOV or WebM video.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (kind === 'video' && file.size > LIMITS.attachmentVideoMaxBytes) {
    return `"${file.name}" is too large. A video can be up to ${LIMITS.attachmentVideoMaxBytes / MB} MB.`;
  }
  if (kind === 'image' && file.size > LIMITS.attachmentImageMaxBytes) {
    return `"${file.name}" is too large. An image can be up to ${LIMITS.attachmentImageMaxBytes / MB} MB.`;
  }
  return null;
}

export function chooseFiles<T extends FileLike>(
  files: readonly T[],
  alreadyChosen: number,
): { accepted: { file: T; kind: AttachmentKind }[]; refused: string[] } {
  const accepted: { file: T; kind: AttachmentKind }[] = [];
  const refused: string[] = [];
  let overLimit = 0;
  for (const file of files) {
    const refusal = refusalFor(file);
    if (refusal) refused.push(refusal);
    else if (alreadyChosen + accepted.length >= LIMITS.attachmentsPerMessage) overLimit++;
    else accepted.push({ file, kind: attachmentKindOf(file)! });
  }
  if (overLimit) {
    refused.push(
      `A message can have at most ${LIMITS.attachmentsPerMessage} files, so ${overLimit === 1 ? 'one was' : `${overLimit} were`} left out.`,
    );
  }
  return { accepted, refused };
}

export function describeRefusals(refused: readonly string[]): string | undefined {
  const [first, ...rest] = refused;
  if (!first) return undefined;
  return rest.length ? `${first} Other files were not added either.` : first;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / MB;
  return `${megabytes < 100 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

export function dragCarriesFiles(types: readonly string[] | null | undefined): boolean {
  return !!types && types.includes('Files');
}

export function filesFromPaste(data: {
  files: ArrayLike<File>;
  getData(format: string): string;
}): File[] {
  const files = Array.from(data.files);
  if (!files.length) return [];
  if (data.getData('text/plain').trim() && data.getData('text/html')) return [];
  return files;
}

export const MEDIA_MAX_WIDTH = 420;
export const MEDIA_MAX_HEIGHT = 320;
const IMAGE_MIN_EDGE = 64;
const VIDEO_MIN_WIDTH = 160;
const VIDEO_MIN_HEIGHT = 120;

export interface Box {
  width: number;
  height: number;
}

export function fitImage(width: number | null, height: number | null): Box {
  if (!width || !height) return { width: 320, height: 240 };
  const scale = Math.min(1, MEDIA_MAX_WIDTH / width, MEDIA_MAX_HEIGHT / height);
  return {
    width: Math.max(IMAGE_MIN_EDGE, Math.round(width * scale)),
    height: Math.max(IMAGE_MIN_EDGE, Math.round(height * scale)),
  };
}

export function fitVideo(width: number | null, height: number | null): Box {
  if (!width || !height) return { width: MEDIA_MAX_WIDTH, height: 236 };
  const scale = Math.min(MEDIA_MAX_WIDTH / width, MEDIA_MAX_HEIGHT / height);
  return {
    width: Math.max(VIDEO_MIN_WIDTH, Math.round(width * scale)),
    height: Math.max(VIDEO_MIN_HEIGHT, Math.round(height * scale)),
  };
}

export function sameShape(
  width: number,
  height: number,
  reportedWidth: number | null,
  reportedHeight: number | null,
): boolean {
  if (!reportedWidth || !reportedHeight) return false;
  return Math.abs(width / height / (reportedWidth / reportedHeight) - 1) < 0.02;
}

export interface GridCell {
  columns: number;
  rows: number;
  aspect: string;
}

const pair: GridCell = { columns: 3, rows: 1, aspect: '3 / 2' };
const triple: GridCell = { columns: 2, rows: 1, aspect: '1 / 1' };
const rowsOf = (...rows: (2 | 3)[]): GridCell[] =>
  rows.flatMap((size) => Array<GridCell>(size).fill(size === 2 ? pair : triple));

export function attachmentGrid(count: number): GridCell[] {
  switch (count) {
    case 2:
      return Array<GridCell>(2).fill({ columns: 3, rows: 1, aspect: '1 / 1' });
    case 3:
      return [{ columns: 4, rows: 2, aspect: '1 / 1' }, triple, triple];
    case 4:
      return rowsOf(2, 2);
    case 5:
      return rowsOf(2, 3);
    case 6:
      return rowsOf(3, 3);
    case 7:
      return rowsOf(2, 2, 3);
    case 8:
      return rowsOf(2, 3, 3);
    case 9:
      return rowsOf(3, 3, 3);
    case 10:
      return rowsOf(2, 2, 3, 3);
    default:
      return Array<GridCell>(Math.max(count, 0)).fill({ columns: 6, rows: 1, aspect: '1 / 1' });
  }
}

export type AttachmentRun<T> = { kind: 'image'; items: T[] } | { kind: 'video'; items: [T] };

export function attachmentRuns<T extends { kind: AttachmentKind }>(
  items: readonly T[],
): AttachmentRun<T>[] {
  const runs: AttachmentRun<T>[] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (item.kind === 'video') runs.push({ kind: 'video', items: [item] });
    else if (last?.kind === 'image') last.items.push(item);
    else runs.push({ kind: 'image', items: [item] });
  }
  return runs;
}

export function overallPercent(
  files: readonly { id: string; size: number; attachment: unknown }[],
  percents: Readonly<Record<string, number | undefined>>,
): number {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (!total) return 0;
  const done = files.reduce(
    (sum, f) => sum + (f.attachment ? f.size : (f.size * (percents[f.id] ?? 0)) / 100),
    0,
  );
  return Math.min(100, Math.floor((done / total) * 100));
}
