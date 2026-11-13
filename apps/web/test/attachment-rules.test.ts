import { describe, expect, it } from 'vitest';
import { ATTACHMENT_IMAGE_TYPES, ATTACHMENT_VIDEO_TYPES, LIMITS } from '@hostile/shared';
import {
  ATTACH_ACCEPT,
  attachmentGrid,
  attachmentKindOf,
  attachmentRuns,
  chooseFiles,
  describeRefusals,
  dragCarriesFiles,
  filesFromPaste,
  fitImage,
  fitVideo,
  formatBytes,
  MEDIA_MAX_HEIGHT,
  MEDIA_MAX_WIDTH,
  overallPercent,
  refusalFor,
  sameShape,
} from '../src/features/chat/attachment-rules';

const MB = 1024 * 1024;
const file = (name: string, type: string, size = 10) => ({ name, type, size });

describe('what may be attached', () => {
  it('takes every type the server accepts, by its own name for it', () => {
    for (const type of ATTACHMENT_IMAGE_TYPES)
      expect(attachmentKindOf({ name: 'x', type })).toBe('image');
    for (const type of ATTACHMENT_VIDEO_TYPES)
      expect(attachmentKindOf({ name: 'x', type })).toBe('video');
  });

  it('offers the exact types as well as the wide ones a phone needs for its camera roll', () => {
    const offered = ATTACH_ACCEPT.split(',');
    expect(offered).toEqual(
      expect.arrayContaining(['image/*', 'video/*', 'video/quicktime', 'image/webp']),
    );
  });

  it('refuses what the server would, and names the file', () => {
    for (const [name, type] of [
      ['photo.heic', 'image/heic'],
      ['photo.avif', 'image/avif'],
      ['logo.svg', 'image/svg+xml'],
      ['notes.txt', 'text/plain'],
      ['clip.mkv', 'video/x-matroska'],
    ] as const) {
      expect(refusalFor(file(name, type))).toContain(`"${name}" is not a PNG`);
    }
  });

  it('goes by the extension only when the browser could say nothing', () => {
    expect(attachmentKindOf({ name: 'IMG_1.MOV', type: '' })).toBe('video');
    expect(attachmentKindOf({ name: 'a.jpeg', type: '' })).toBe('image');
    expect(attachmentKindOf({ name: 'a.exe', type: '' })).toBeNull();
    expect(attachmentKindOf({ name: 'no-extension', type: '' })).toBeNull();
    expect(attachmentKindOf({ name: 'not-really.png', type: 'text/html' })).toBeNull();
  });

  it('holds each kind to its own size limit, exact to the byte', () => {
    const image = LIMITS.attachmentImageMaxBytes;
    const video = LIMITS.attachmentVideoMaxBytes;
    expect(refusalFor(file('a.png', 'image/png', image))).toBeNull();
    expect(refusalFor(file('a.png', 'image/png', image + 1))).toContain(
      'An image can be up to 10 MB',
    );
    expect(refusalFor(file('a.mp4', 'video/mp4', video))).toBeNull();
    expect(refusalFor(file('a.mp4', 'video/mp4', video + 1))).toContain(
      'A video can be up to 30 MB',
    );
  });

  it('refuses an empty file, which the server would call a mistake anyway', () => {
    expect(refusalFor(file('a.png', 'image/png', 0))).toBe('"a.png" is empty.');
  });
});

describe('choosing a batch', () => {
  const png = (name: string) => file(name, 'image/png');

  it('takes up to the limit, counting what is already there, and says how many it left out', () => {
    const { accepted, refused } = chooseFiles([png('1'), png('2'), png('3'), png('4')], 8);
    expect(accepted.map((a) => a.file.name)).toEqual(['1', '2']);
    expect(refused).toEqual(['A message can have at most 10 files, so 2 were left out.']);
  });

  it('says one, in words', () => {
    const { refused } = chooseFiles([png('1')], LIMITS.attachmentsPerMessage);
    expect(refused).toEqual(['A message can have at most 10 files, so one was left out.']);
  });

  it('does not let a refused file use up a place', () => {
    const { accepted, refused } = chooseFiles([file('a.txt', 'text/plain'), png('ok')], 9);
    expect(accepted.map((a) => a.file.name)).toEqual(['ok']);
    expect(refused).toHaveLength(1);
  });

  it('sums up many refusals in one notice', () => {
    expect(describeRefusals([])).toBeUndefined();
    expect(describeRefusals(['One thing.'])).toBe('One thing.');
    expect(describeRefusals(['One thing.', 'Another.', 'A third.'])).toBe(
      'One thing. Other files were not added either.',
    );
  });
});

describe('formatBytes', () => {
  it('is short and plain at every size', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4120)).toBe('4 KB');
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB');
    expect(formatBytes(200 * MB)).toBe('200 MB');
  });
});

describe('where files come from', () => {
  const clipboard = (files: File[], text = '', html = '') => ({
    files,
    getData: (format: string) =>
      format === 'text/plain' ? text : format === 'text/html' ? html : '',
  });
  const image = new File(['x'], 'image.png', { type: 'image/png' });

  it('reacts to a drag of files and to nothing else', () => {
    expect(dragCarriesFiles(['Files'])).toBe(true);
    expect(dragCarriesFiles(['text/uri-list', 'Files'])).toBe(true);
    expect(dragCarriesFiles(['text/plain', 'text/uri-list'])).toBe(false);
    expect(dragCarriesFiles([])).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
  });

  it('attaches a pasted image', () => {
    expect(filesFromPaste(clipboard([image]))).toEqual([image]);
    expect(filesFromPaste(clipboard([image], '', '<img src="x">'))).toEqual([image]);
    expect(filesFromPaste(clipboard([image], 'image.png'))).toEqual([image]);
  });

  it('leaves a paste with no file as a text paste', () => {
    expect(filesFromPaste(clipboard([], 'words'))).toEqual([]);
  });

  it('leaves Word and Excel alone, whose picture of the selection is not what was meant', () => {
    expect(filesFromPaste(clipboard([image], 'a cell', '<td>a cell</td>'))).toEqual([]);
  });
});

describe('the shape of one file', () => {
  it('fits an image within the limits, keeping its shape', () => {
    expect(fitImage(1600, 900)).toEqual({ width: MEDIA_MAX_WIDTH, height: 236 });
    expect(fitImage(900, 1600)).toEqual({ width: 180, height: MEDIA_MAX_HEIGHT });
  });

  it('never makes an image larger than it is', () => {
    expect(fitImage(120, 80)).toEqual({ width: 120, height: 80 });
  });

  it('gives an extreme panorama, or a tiny image, a box it can be aimed at', () => {
    expect(fitImage(5000, 100)).toEqual({ width: MEDIA_MAX_WIDTH, height: 64 });
    expect(fitImage(1, 1)).toEqual({ width: 64, height: 64 });
  });

  it('has a shape ready when the size is unknown', () => {
    expect(fitImage(null, null)).toEqual({ width: 320, height: 240 });
    expect(fitVideo(null, null)).toEqual({ width: MEDIA_MAX_WIDTH, height: 236 });
  });

  it('gives a video room for its controls, however small the picture is', () => {
    expect(fitVideo(32, 18)).toEqual({ width: MEDIA_MAX_WIDTH, height: 236 });
    expect(fitVideo(1080, 1920)).toEqual({ width: 180, height: MEDIA_MAX_HEIGHT });
    const thin = fitVideo(2000, 100);
    expect(thin.width).toBe(MEDIA_MAX_WIDTH);
    expect(thin.height).toBeGreaterThanOrEqual(120);
  });

  it('notices when a photo is drawn another way round than its header says', () => {
    expect(sameShape(4032, 3024, 4032, 3024)).toBe(true);
    expect(sameShape(3024, 4032, 4032, 3024)).toBe(false);
    expect(sameShape(100, 100, null, null)).toBe(false);
  });
});

describe('a grid of images', () => {
  it('fills every row of six columns, for every count a message can have', () => {
    for (let count = 2; count <= LIMITS.attachmentsPerMessage; count++) {
      const cells = attachmentGrid(count);
      expect(cells).toHaveLength(count);
      if (count === 3) continue;
      let row = 0;
      for (const cell of cells) {
        row += cell.columns;
        expect(row).toBeLessThanOrEqual(6);
        if (row === 6) row = 0;
      }
      expect(row).toBe(0);
    }
  });

  it('lines up three: one large, and two whose heights add up to it', () => {
    const [large, ...small] = attachmentGrid(3);
    expect(large).toMatchObject({ columns: 4, rows: 2 });
    expect(small.map((c) => c.columns)).toEqual([2, 2]);
  });
});

describe('runs', () => {
  const a = (id: string, kind: 'image' | 'video') => ({ id, kind });

  it('groups images, stands each video alone, and keeps the order they were sent in', () => {
    const runs = attachmentRuns([
      a('1', 'image'),
      a('2', 'image'),
      a('3', 'video'),
      a('4', 'video'),
      a('5', 'image'),
    ]);
    expect(runs.map((r) => [r.kind, r.items.map((i) => i.id)])).toEqual([
      ['image', ['1', '2']],
      ['video', ['3']],
      ['video', ['4']],
      ['image', ['5']],
    ]);
  });
});

describe('progress', () => {
  const f = (id: string, size: number, attachment: unknown = null) => ({ id, size, attachment });

  it('counts by bytes, so a small photo does not count for as much as a large video', () => {
    const files = [f('photo', 100), f('video', 900)];
    expect(overallPercent(files, { photo: 100 })).toBe(10);
    expect(overallPercent(files, { photo: 100, video: 50 })).toBe(55);
  });

  it('counts a finished file in full, whatever its percentage last said', () => {
    expect(overallPercent([f('a', 100, {}), f('b', 100)], {})).toBe(50);
  });

  it('does not divide by nothing', () => {
    expect(overallPercent([], {})).toBe(0);
  });
});
