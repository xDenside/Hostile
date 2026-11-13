import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AttachmentDTO,
  ClientToServerEvents,
  MessageDTO,
  ServerToClientEvents,
} from '@hostile/shared';
import { LIMITS } from '@hostile/shared';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ATTACHMENT_UPLOADS_PER_HOUR } from '../../src/http/routes/chat.js';
import { AttachmentStore, DISK_RESERVE_BYTES } from '../../src/media/attachments.js';
import {
  bearerAuth,
  createChannel,
  createUser,
  loginDesktop,
  loginWeb,
  sendMessage,
  webAuth,
  type DesktopSession,
  type WebSession,
} from '../support/factories.js';
import {
  resetDatabase,
  startTestApi,
  TEST_APP_ORIGIN,
  waitFor,
  type TestApi,
} from '../support/harness.js';
import {
  buildAnimatedWebp,
  buildApng,
  buildBlankPng,
  buildGif,
  buildJpeg,
  buildJpegOfSize,
  buildPng,
  jpegSegment,
  REAL_IMAGES,
} from '../support/images.js';
import { REAL_LOCATED } from '../support/located-files.js';
import {
  atom,
  buildExif,
  EXIF_PREFIX,
  hasGpsPointer,
  jpegExifSegment,
  jpegWith,
  mp4With,
  orientationIn,
  qtText,
  XYZ,
} from '../support/location-builders.js';
import { buildFtyp, REAL_MATROSKA, REAL_OLD_QUICKTIME, REAL_VIDEOS } from '../support/videos.js';

let api: TestApi;
let alice: { id: string; session: DesktopSession };
let bob: { id: string; session: DesktopSession };
let owner: { id: string; session: DesktopSession };

const PNG = REAL_IMAGES.png;
const MP4 = REAL_VIDEOS.mp4;
const MB = 1024 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(async () => {
  api = await startTestApi();
  await resetDatabase(api.ctx);
  const [aliceUser, bobUser, ownerUser] = await Promise.all([
    createUser(api.ctx),
    createUser(api.ctx),
    createUser(api.ctx, { role: 'OWNER' }),
  ]);
  const [aliceSession, bobSession, ownerSession] = await Promise.all([
    loginDesktop(api, aliceUser),
    loginDesktop(api, bobUser),
    loginDesktop(api, ownerUser),
  ]);
  alice = { id: aliceUser.id, session: aliceSession };
  bob = { id: bobUser.id, session: bobSession };
  owner = { id: ownerUser.id, session: ownerSession };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await api?.stop();
});

const newChannel = () => createChannel(api.ctx, { type: 'TEXT' });

interface Answer {
  status: number;
  body: {
    attachment: AttachmentDTO;
    error: {
      code: string;
      message: string;
      retryAfterSec?: number;
      issues?: { path: string; message: string }[];
    };
  };
  headers: Headers;
}

interface UploadOptions {
  session?: DesktopSession;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  init?: RequestInit;
  on?: TestApi;
}

async function upload(
  channelId: string,
  body: RequestInit['body'],
  options: UploadOptions = {},
): Promise<Answer> {
  const query = new URLSearchParams(options.query).toString();
  const target = options.on ?? api;
  const res = await fetch(
    `${target.baseUrl}/api/channels/${channelId}/attachments${query ? `?${query}` : ''}`,
    {
      method: 'POST',
      headers: options.headers ?? bearerAuth(options.session ?? alice.session),
      body,
      ...options.init,
    },
  );
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as Answer['body'],
    headers: res.headers,
  };
}

async function uploaded(
  channelId: string,
  bytes: Buffer = PNG.bytes,
  options: UploadOptions = {},
): Promise<AttachmentDTO> {
  const answer = await upload(channelId, bytes, options);
  if (answer.status !== 201)
    throw new Error(`Upload failed: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body.attachment;
}

function streamOf(head: Buffer, total: number, chunk = MB): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const piece = sent === 0 ? head : Buffer.alloc(Math.min(chunk, total - sent));
      sent += piece.length;
      controller.enqueue(piece);
    },
  });
}

const streaming = { duplex: 'half' } as RequestInit;

const send = (
  session: DesktopSession,
  channelId: string,
  body: { content?: string; attachmentIds?: string[]; clientNonce?: string },
) =>
  api
    .http()
    .post(`/api/channels/${channelId}/messages`)
    .set(bearerAuth(session))
    .send({ content: '', clientNonce: randomUUID(), ...body });

const edit = (session: DesktopSession, messageId: string, content: string) =>
  api.http().patch(`/api/messages/${messageId}`).set(bearerAuth(session)).send({ content });

const removeMessage = (session: DesktopSession, messageId: string) =>
  api.http().delete(`/api/messages/${messageId}`).set(bearerAuth(session));

const discard = (id: string, headers: Record<string, string>) =>
  fetch(`${api.baseUrl}/api/attachments/${id}`, { method: 'DELETE', headers });

const fetchFile = (path: string, init: RequestInit = {}) => fetch(`${api.baseUrl}${path}`, init);

const filesOnDisk = (target = api) => readdirSync(target.uploadsDir);
const tempFiles = (target = api) => filesOnDisk(target).filter((name) => name.endsWith('.part'));
const hasFile = (id: string) => existsSync(join(api.uploadsDir, id));
const row = (id: string) => api.ctx.db.messageAttachment.findUnique({ where: { id } });
const rowsIn = (channelId: string) => api.ctx.db.messageAttachment.count({ where: { channelId } });
const messagesIn = (channelId: string) => api.ctx.db.message.count({ where: { channelId } });

async function expectNothingStored(channelId: string) {
  expect(await rowsIn(channelId)).toBe(0);
  await waitFor('temp files to be gone', () => tempFiles().length === 0);
}

describe('accepted uploads', () => {
  const images = Object.entries(REAL_IMAGES).filter(([name]) =>
    ['png', 'jpeg', 'gifAnimated', 'webpLossy'].includes(name),
  );
  for (const [name, image] of images) {
    test(`a real ${name} is stored, described and served back byte for byte`, async () => {
      const channel = await newChannel();
      const fileName = `real.${image.type.split('/')[1]}`;
      const answer = await upload(channel.id, image.bytes, { query: { name: fileName } });
      expect(answer.status).toBe(201);
      const attachment = answer.body.attachment;
      expect(attachment).toEqual({
        id: expect.stringMatching(UUID_V4),
        kind: 'image',
        url: `/api/attachments/${attachment.id}`,
        contentType: image.type,
        fileName,
        byteSize: image.bytes.length,
        width: image.width,
        height: image.height,
      });

      const res = await fetchFile(attachment.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(image.type);
      expect(Buffer.from(await res.arrayBuffer()).equals(image.bytes)).toBe(true);
    });
  }

  for (const [name, video] of Object.entries(REAL_VIDEOS)) {
    test(`a real ${name} is stored, described and served back byte for byte`, async () => {
      const channel = await newChannel();
      const answer = await upload(channel.id, video.bytes, {
        query: { name: `clip.${name}`, width: '32', height: '18' },
      });
      expect(answer.status).toBe(201);
      const attachment = answer.body.attachment;
      expect(attachment).toEqual({
        id: expect.stringMatching(UUID_V4),
        kind: 'video',
        url: `/api/attachments/${attachment.id}`,
        contentType: video.type,
        fileName: `clip.${name}`,
        byteSize: video.bytes.length,
        width: 32,
        height: 18,
      });
      const res = await fetchFile(attachment.url);
      expect(res.headers.get('content-type')).toBe(video.type);
      expect(Buffer.from(await res.arrayBuffer()).equals(video.bytes)).toBe(true);
    });
  }

  for (const [name, bytes] of Object.entries(REAL_OLD_QUICKTIME)) {
    test(`QuickTime with no file type box is stored as QuickTime: ${name}`, async () => {
      const channel = await newChannel();
      const answer = await upload(channel.id, bytes, { query: { name: 'old.mov' } });
      expect(answer.status).toBe(201);
      expect(answer.body.attachment).toMatchObject({
        kind: 'video',
        contentType: 'video/quicktime',
        fileName: 'old.mov',
      });
    });
  }

  test('a file much larger than a sniff, in pieces with no length, arrives whole', async () => {
    const channel = await newChannel();
    const total = 3 * MB + 123;
    const answer = await upload(channel.id, streamOf(MP4.bytes, total, 64 * 1024), {
      init: streaming,
    });
    expect(answer.status).toBe(201);
    expect(answer.body.attachment.byteSize).toBe(total);
    const res = await fetchFile(answer.body.attachment.url);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBe(total);
    expect(bytes.subarray(0, MP4.bytes.length).equals(MP4.bytes)).toBe(true);
    expect(bytes.subarray(MP4.bytes.length).every((byte) => byte === 0)).toBe(true);
  });

  test('the type comes from the bytes, whatever the request claims', async () => {
    const channel = await newChannel();
    for (const claimed of ['image/gif', 'text/html', 'application/octet-stream']) {
      const answer = await upload(channel.id, PNG.bytes, {
        headers: { ...bearerAuth(alice.session), 'Content-Type': claimed },
        query: { name: 'photo.gif' },
      });
      expect(answer.status, claimed).toBe(201);
      expect(answer.body.attachment.contentType, claimed).toBe('image/png');
    }
  });

  test('a body labelled JSON is still a file, even past the JSON size limit', async () => {
    const channel = await newChannel();
    const bytes = buildPng(16, 16, LIMITS.jsonBodyBytes + 1024);
    const answer = await upload(channel.id, bytes, {
      headers: { ...bearerAuth(alice.session), 'Content-Type': 'application/json' },
    });
    expect(answer.status).toBe(201);
    expect(answer.body.attachment.byteSize).toBe(bytes.length);
  });

  test('a 48 megapixel photo passes, and an edge past the limit does not', async () => {
    const channel = await newChannel();
    const phone = await upload(channel.id, buildJpegOfSize(8000, 6000, 1_600_000));
    expect(phone.status).toBe(201);
    expect(phone.body.attachment).toMatchObject({ width: 8000, height: 6000 });

    const over = await upload(channel.id, buildPng(LIMITS.attachmentMaxEdge + 1, 1));
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('validation_error');
    expect(over.body.error.message).toBe(
      `That image is too large. It can be at most ${LIMITS.attachmentMaxEdge} pixels on a side.`,
    );
  });

  test('a small file that would decode to a gigabyte is refused, with nothing stored', async () => {
    const channel = await newChannel();
    const edge = LIMITS.attachmentMaxEdge;
    const bomb = buildBlankPng(edge, edge);
    expect(bomb.length).toBeLessThan(40_000);
    const refused = await upload(channel.id, bomb);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('validation_error');
    expect(refused.body.error.message).toContain(`${edge} by ${edge} pixels in a very small file`);
    await expectNothingStored(channel.id);

    for (const [name, bytes] of [
      ['a GIF grown by one frame', buildGif(1, 1, [{ width: edge, height: edge }])],
      ['the same as a JPEG', buildJpeg(edge, edge)],
    ] as const) {
      const answer = await upload(channel.id, bytes);
      expect(answer.status, name).toBe(400);
      expect(answer.body.error.message, name).toContain('in a very small file');
      await expectNothingStored(channel.id);
    }
  });

  test('so is a long run of huge frames, in each of the formats that can have them', async () => {
    const channel = await newChannel();
    const frames = Array.from({ length: 300 }, () => [4000, 4000] as [number, number]);
    const files = [
      buildGif(
        4000,
        4000,
        frames.map(([width, height]) => ({ width, height })),
      ),
      buildApng(4000, 4000, frames),
      buildAnimatedWebp(4000, 4000, frames),
    ];
    for (const bytes of files) {
      const answer = await upload(channel.id, bytes);
      expect(answer.status).toBe(400);
      expect(answer.body.error.message).toContain('too many large frames');
      await expectNothingStored(channel.id);
    }
  });

  test('what compresses as well as a bomb but is no danger goes through', async () => {
    const channel = await newChannel();
    const files: [Buffer, number, number][] = [
      [buildBlankPng(3840, 2160, 8), 3840, 2160],
      [buildBlankPng(3840, 2160, 1), 3840, 2160],
      [buildBlankPng(7680, 4320, 1), 7680, 4320],
      [buildPng(7680, 4320, 108_000), 7680, 4320],
      [buildJpegOfSize(16_320, 12_240, 4_800_000), 16_320, 12_240],
    ];
    for (const [bytes, width, height] of files) {
      const answer = await upload(channel.id, bytes);
      expect(answer.status).toBe(201);
      expect(answer.body.attachment).toMatchObject({ width, height });
    }
  });

  test('the file on disk is named by the id and nothing else', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id, PNG.bytes, {
      query: { name: '../../../evil.html' },
    });
    expect(attachment.fileName).toBe('evil.html.png');
    expect(hasFile(attachment.id)).toBe(true);
    expect(filesOnDisk().filter((name) => name.includes('evil'))).toEqual([]);
    expect(tempFiles()).toEqual([]);
  });

  test('a name with nothing usable in it is replaced by one that says what the file is', async () => {
    const channel = await newChannel();
    const cases: [Record<string, string>, Buffer, string][] = [
      [{}, PNG.bytes, 'png'],
      [{ name: '' }, REAL_IMAGES.jpeg.bytes, 'jpg'],
      [{ name: '../..' }, REAL_IMAGES.gif87.bytes, 'gif'],
      [{ name: '\u0000\u0001' }, REAL_VIDEOS.webm.bytes, 'webm'],
      [{ name: '/' }, REAL_VIDEOS.mov.bytes, 'mov'],
    ];
    for (const [query, bytes, extension] of cases) {
      const attachment = await uploaded(channel.id, bytes, { query });
      expect(attachment.fileName).toBe(`attachment-${attachment.id.slice(0, 8)}.${extension}`);
    }
  });

  test('a repeated name parameter is not trusted to be a string', async () => {
    const channel = await newChannel();
    const res = await fetch(
      `${api.baseUrl}/api/channels/${channel.id}/attachments?name=a.png&name=b.png&width=1&width=2`,
      { method: 'POST', headers: bearerAuth(alice.session), body: MP4.bytes },
    );
    expect(res.status).toBe(201);
    const { attachment } = (await res.json()) as { attachment: AttachmentDTO };
    expect(attachment.fileName).toMatch(/^attachment-/);
    expect(attachment.width).toBeNull();
  });

  test("an image's size comes from the file, whatever the client measured", async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id, PNG.bytes, {
      query: { width: '999', height: '888' },
    });
    expect(attachment).toMatchObject({ width: PNG.width, height: PNG.height });
  });

  test("a video's size is the client's, clamped, and only when both sides make sense", async () => {
    const channel = await newChannel();
    const cases: [Record<string, string>, number | null, number | null][] = [
      [{ width: '1920', height: '1080' }, 1920, 1080],
      [{ width: '1920.6', height: '1080.2' }, 1921, 1080],
      [{ width: '99999999', height: '1080' }, LIMITS.attachmentMaxEdge, 1080],
      [{ width: '1920' }, null, null],
      [{ height: '1080' }, null, null],
      [{ width: '0', height: '1080' }, null, null],
      [{ width: '-1920', height: '1080' }, null, null],
      [{ width: 'wide', height: 'tall' }, null, null],
      [{}, null, null],
    ];
    for (const [query, width, height] of cases) {
      const attachment = await uploaded(channel.id, MP4.bytes, { query });
      expect(attachment.width, JSON.stringify(query)).toBe(width);
      expect(attachment.height, JSON.stringify(query)).toBe(height);
    }
  });
});

describe('refused uploads', () => {
  const unsupported =
    'That file is not a PNG, JPEG, GIF or WebP image, or an MP4, MOV or WebM video.';
  const notAccepted: [string, Buffer | string][] = [
    ['plain text', 'just some words, in a file called photo.png'],
    ['HTML', '<!doctype html><html><script>alert(1)</script></html>'],
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['Matroska, which is not WebM', REAL_MATROSKA],
    ['a HEIC photo', buildFtyp('heic')],
    ['an AVIF image', buildFtyp('avif')],
    ['M4A audio', buildFtyp('M4A ')],
  ];
  for (const [name, body] of notAccepted) {
    test(`${name} is refused with 415, and nothing is stored`, async () => {
      const channel = await newChannel();
      const answer = await upload(channel.id, body, {
        headers: { ...bearerAuth(alice.session), 'Content-Type': 'image/png' },
        query: { name: 'photo.png' },
      });
      expect(answer.status).toBe(415);
      expect(answer.body.error).toEqual({ code: 'validation_error', message: unsupported });
      await expectNothingStored(channel.id);
    });
  }

  test('a wrong type is refused from its start, without the rest being stored', async () => {
    const channel = await newChannel();
    const before = filesOnDisk().length;
    let tempSeen = false;
    const answer = await upload(
      channel.id,
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          tempSeen ||= tempFiles().length > 0;
          controller.enqueue(Buffer.alloc(64 * 1024, 0x41));
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      }),
      { init: streaming },
    );
    expect(answer.status).toBe(415);
    expect(tempSeen).toBe(false);
    expect(filesOnDisk().length).toBe(before);
  });

  test('a PNG cut off in the middle is refused with 400, and gone', async () => {
    const channel = await newChannel();
    const answer = await upload(channel.id, PNG.bytes.subarray(0, 60));
    expect(answer.status).toBe(400);
    expect(answer.body.error.message).toBe(
      'That image is damaged or incomplete. Try another file.',
    );
    await expectNothingStored(channel.id);
  });

  test('an empty body, or none at all, says what to do', async () => {
    const channel = await newChannel();
    for (const body of [Buffer.alloc(0), null]) {
      const answer = await upload(channel.id, body);
      expect(answer.status).toBe(400);
      expect(answer.body.error.message).toBe('Choose a file to upload.');
    }
    await expectNothingStored(channel.id);
  });

  test('a compressed body is refused as the client error it is', async () => {
    const channel = await newChannel();
    const answer = await upload(channel.id, PNG.bytes, {
      headers: { ...bearerAuth(alice.session), 'Content-Encoding': 'gzip' },
    });
    expect(answer.status).toBe(415);
    await expectNothingStored(channel.id);
  });

  test('an archived or unknown channel takes nothing, and a malformed id is a 400', async () => {
    const archived = await createChannel(api.ctx, { type: 'TEXT', archived: true });
    expect((await upload(archived.id, PNG.bytes)).status).toBe(404);
    expect((await upload(randomUUID(), PNG.bytes)).status).toBe(404);
    expect((await upload('not-a-uuid', PNG.bytes)).status).toBe(400);
    expect(await rowsIn(archived.id)).toBe(0);
  });

  test('voice channels take attachments too, on the same tables', async () => {
    const voice = await createChannel(api.ctx, { type: 'VOICE' });
    const attachment = await uploaded(voice.id);
    const res = await send(alice.session, voice.id, { attachmentIds: [attachment.id] });
    expect(res.status).toBe(201);
    expect(res.body.message.attachments).toHaveLength(1);
  });
});

describe('size limits', () => {
  const imageMessage = 'That image is too large. An image can be up to 10 MB.';
  const videoMessage = 'That video is too large. A video can be up to 30 MB.';

  test('an image of exactly the limit is accepted, and one byte more is a 413', async () => {
    const channel = await newChannel();
    const limit = LIMITS.attachmentImageMaxBytes;
    const atLimit = await upload(channel.id, buildPng(64, 64, limit));
    expect(atLimit.status).toBe(201);
    expect(atLimit.body.attachment.byteSize).toBe(limit);

    const over = await upload(channel.id, buildPng(64, 64, limit + 1));
    expect(over.status).toBe(413);
    expect(over.body.error).toEqual({ code: 'payload_too_large', message: imageMessage });
    expect(await rowsIn(channel.id)).toBe(1);
    await waitFor('temp files to be gone', () => tempFiles().length === 0);
  });

  test('a video has its own, larger limit', async () => {
    const channel = await newChannel();
    const size = LIMITS.attachmentImageMaxBytes + MB;
    const video = Buffer.concat([MP4.bytes, Buffer.alloc(size - MP4.bytes.length)]);
    const answer = await upload(channel.id, video);
    expect(answer.status).toBe(201);
    expect(answer.body.attachment.byteSize).toBe(size);
  });

  test('an image with no length is cut off at the limit, with its temp file gone', async () => {
    const channel = await newChannel();
    const head = buildPng(64, 64, 1024);
    const limit = LIMITS.attachmentImageMaxBytes;
    const answer = await upload(channel.id, streamOf(head, limit + 8 * MB), { init: streaming });
    expect(answer.status).toBe(413);
    expect(answer.body.error.message).toBe(imageMessage);
    await expectNothingStored(channel.id);
  });

  test('a video with no length is cut off at its limit, with its temp file gone', async () => {
    const channel = await newChannel();
    const limit = LIMITS.attachmentVideoMaxBytes;
    const answer = await upload(channel.id, streamOf(MP4.bytes, limit + 8 * MB), {
      init: streaming,
    });
    expect(answer.status).toBe(413);
    expect(answer.body.error.message).toBe(videoMessage);
    await expectNothingStored(channel.id);
  });

  async function statusForHeaders(channelId: string, contentLength: number, head?: Buffer) {
    const socket = connect(api.port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.write(
      `POST /api/channels/${channelId}/attachments HTTP/1.1\r\nHost: x\r\n` +
        `Authorization: Bearer ${alice.session.accessToken}\r\n` +
        `Content-Length: ${contentLength}\r\n\r\n`,
    );
    if (head) socket.write(head);
    try {
      return await new Promise<string>((resolve, reject) => {
        let text = '';
        socket.on('data', (chunk) => {
          text += chunk.toString('latin1');
          if (text.includes('\r\n\r\n')) resolve(text);
        });
        socket.once('close', () => reject(new Error(`Closed with no answer: ${text}`)));
      });
    } finally {
      socket.destroy();
    }
  }

  test('a declared length past every limit is refused before any of it is sent', async () => {
    const channel = await newChannel();
    const answer = await statusForHeaders(channel.id, LIMITS.attachmentVideoMaxBytes + 1);
    expect(answer).toMatch(/^HTTP\/1\.1 413 /);
    expect(answer).toMatch(/content-type: application\/json/i);
    await expectNothingStored(channel.id);
  });

  test('a declared length past the limit of its type is refused once the type is known', async () => {
    const channel = await newChannel();
    const head = buildPng(64, 64, 8192);
    const answer = await statusForHeaders(channel.id, LIMITS.attachmentImageMaxBytes + 1, head);
    expect(answer).toMatch(/^HTTP\/1\.1 413 /);
    await expectNothingStored(channel.id);
  });
});

describe('the daily allowance', () => {
  const HOUR = 60 * 60 * 1000;
  const allowanceMessage =
    'You have uploaded 1 GB of files in the last 24 hours, which is the most one person can. Try again later.';

  async function memberWhoStored(bytes: number, hoursAgo = 0) {
    const user = await createUser(api.ctx);
    const session = await loginDesktop(api, user);
    const hour = new Date(Math.floor((Date.now() - hoursAgo * HOUR) / HOUR) * HOUR);
    await api.ctx.db.uploadHour.create({ data: { userId: user.id, hour, bytes } });
    return { id: user.id, session };
  }

  test('what fits in the allowance is stored, and one byte past it is a 413', async () => {
    const channel = await newChannel();
    const member = await memberWhoStored(LIMITS.attachmentDailyBytes - 2000);

    const first = await upload(channel.id, buildPng(16, 16, 1000), { session: member.session });
    expect(first.status).toBe(201);

    const over = await upload(channel.id, buildPng(16, 16, 1001), { session: member.session });
    expect(over.status).toBe(413);
    expect(over.body.error).toEqual({ code: 'payload_too_large', message: allowanceMessage });

    const last = await upload(channel.id, buildPng(16, 16, 1000), { session: member.session });
    expect(last.status).toBe(201);
    expect(await api.ctx.attachments.storedInLastDay(member.id)).toBe(LIMITS.attachmentDailyBytes);
    expect(await rowsIn(channel.id)).toBe(2);
    await waitFor('temp files to be gone', () => tempFiles().length === 0);
  });

  test('a body with no length is cut off where the allowance ends', async () => {
    const channel = await newChannel();
    const member = await memberWhoStored(LIMITS.attachmentDailyBytes - 3 * MB);
    const answer = await upload(channel.id, streamOf(MP4.bytes, 8 * MB), {
      session: member.session,
      init: streaming,
    });
    expect(answer.status).toBe(413);
    expect(answer.body.error.message).toBe(allowanceMessage);
    await expectNothingStored(channel.id);
  });

  test('deleting a file gives none of the allowance back', async () => {
    const channel = await newChannel();
    const member = await memberWhoStored(LIMITS.attachmentDailyBytes - 1000);
    const file = await uploaded(channel.id, buildPng(16, 16, 1000), { session: member.session });
    expect((await discard(file.id, bearerAuth(member.session))).status).toBe(204);

    const again = await upload(channel.id, buildPng(16, 16, 1000), { session: member.session });
    expect(again.status).toBe(413);
    expect(again.body.error.message).toBe(allowanceMessage);
  });

  test('one member at the allowance does not stop another', async () => {
    const channel = await newChannel();
    await memberWhoStored(LIMITS.attachmentDailyBytes);
    const other = await memberWhoStored(0);
    const answer = await upload(channel.id, PNG.bytes, { session: other.session });
    expect(answer.status).toBe(201);
  });

  test('what was stored over a day ago no longer counts, and the sweep forgets it', async () => {
    const channel = await newChannel();
    const member = await memberWhoStored(LIMITS.attachmentDailyBytes, 25);
    const answer = await upload(channel.id, PNG.bytes, { session: member.session });
    expect(answer.status).toBe(201);

    await api.ctx.attachments.sweep(Date.now() + 2 * HOUR);
    const left = await api.ctx.db.uploadHour.findMany({ where: { userId: member.id } });
    expect(left.map((row) => row.bytes)).toEqual([PNG.bytes.length]);
  });
});

describe('a client that goes away', () => {
  test('leaves no temp file and no row', async () => {
    const channel = await newChannel();
    const socket = connect(api.port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.write(
      `POST /api/channels/${channel.id}/attachments HTTP/1.1\r\nHost: x\r\n` +
        `Authorization: Bearer ${alice.session.accessToken}\r\n` +
        `Content-Length: ${MB}\r\n\r\n`,
    );
    socket.write(buildPng(64, 64, 16 * 1024));
    await waitFor('the temp file to appear', () => tempFiles().length === 1);

    socket.destroy();
    await waitFor('the temp file to go', () => tempFiles().length === 0);
    expect(await rowsIn(channel.id)).toBe(0);
  });

  test('sending a shorter body than it promised is the same thing', async () => {
    const channel = await newChannel();
    const socket = connect(api.port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.write(
      `POST /api/channels/${channel.id}/attachments HTTP/1.1\r\nHost: x\r\n` +
        `Authorization: Bearer ${alice.session.accessToken}\r\n` +
        `Content-Length: ${PNG.bytes.length + 1}\r\n\r\n`,
    );
    socket.end(PNG.bytes);
    socket.resume();
    await new Promise((resolve) => socket.once('close', resolve));
    await waitFor('the temp file to go', () => tempFiles().length === 0);
    expect(await rowsIn(channel.id)).toBe(0);
  });
});

describe('the server timeouts', () => {
  test("Node's whole-request timeout is off, and its one for headers is not", () => {
    expect(api.server.requestTimeout).toBe(0);
    expect(api.server.headersTimeout).toBe(60_000);
  });
});

describe('serving a file', () => {
  const FILE = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  const VIDEO = Buffer.concat([MP4.bytes, FILE]);

  const expectSecurityHeaders = (res: Response) => {
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  };

  async function videoUrl() {
    const channel = await newChannel();
    return (await uploaded(channel.id, VIDEO, { query: { name: 'clip.mp4' } })).url;
  }

  test('every header, on a plain GET', async () => {
    const url = await videoUrl();
    const res = await fetchFile(url);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe(String(VIDEO.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-disposition')).toBe(
      `inline; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
    );
    expect(res.headers.get('etag')).toBe(`"${url.split('/').pop()}"`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('a name the browser can read back, and that cannot break the header', async () => {
    const channel = await newChannel();
    const name = 'Отчёт "финал" 100%.png';
    const attachment = await uploaded(channel.id, PNG.bytes, { query: { name } });
    expect(attachment.fileName).toBe(name);
    const header = (await fetchFile(attachment.url)).headers.get('content-disposition')!;
    expect(header).toMatch(/^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''[\x21-\x7e]+$/);
    expect(decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(header)![1]!)).toBe(name);
  });

  test('a Range request gets 206, a correct Content-Range and exactly those bytes', async () => {
    const url = await videoUrl();
    const res = await fetchFile(url, { headers: { Range: 'bytes=100-199' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 100-199/${VIDEO.length}`);
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(100, 200))).toBe(true);
    expectSecurityHeaders(res);
  });

  test('the other forms of a range a video element sends', async () => {
    const url = await videoUrl();
    const open = await fetchFile(url, { headers: { Range: `bytes=${VIDEO.length - 10}-` } });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe(
      `bytes ${VIDEO.length - 10}-${VIDEO.length - 1}/${VIDEO.length}`,
    );
    expect(Buffer.from(await open.arrayBuffer()).equals(VIDEO.subarray(-10))).toBe(true);

    const all = await fetchFile(url, { headers: { Range: 'bytes=0-' } });
    expect(all.status).toBe(206);
    expect(Buffer.from(await all.arrayBuffer()).equals(VIDEO)).toBe(true);

    const suffix = await fetchFile(url, { headers: { Range: 'bytes=-5' } });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer()).equals(VIDEO.subarray(-5))).toBe(true);
  });

  test('a range past the end is a 416 that says how long the file is, and is not cached', async () => {
    const url = await videoUrl();
    const res = await fetchFile(url, { headers: { Range: `bytes=${VIDEO.length}-` } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${VIDEO.length}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('etag')).toBeNull();
    expect(await res.text()).toBe('');
  });

  test('If-Range with the ETag gets the range, and with anything else the whole file', async () => {
    const url = await videoUrl();
    const etag = (await fetchFile(url)).headers.get('etag')!;
    const same = await fetchFile(url, { headers: { Range: 'bytes=0-9', 'If-Range': etag } });
    expect(same.status).toBe(206);
    const other = await fetchFile(url, { headers: { Range: 'bytes=0-9', 'If-Range': '"other"' } });
    expect(other.status).toBe(200);
    expect(Buffer.from(await other.arrayBuffer()).equals(VIDEO)).toBe(true);
  });

  test('a revalidation with the ETag gets a 304 and no body', async () => {
    const url = await videoUrl();
    const etag = (await fetchFile(url)).headers.get('etag')!;
    const res = await api.http().get(url).set('If-None-Match', etag);
    expect(res.status).toBe(304);
    expect(res.text ?? '').toBe('');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['etag']).toBe(etag);
  });

  test('HEAD reports the file without sending it', async () => {
    const url = await videoUrl();
    const res = await fetchFile(url, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe(String(VIDEO.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expectSecurityHeaders(res);
    expect(await res.text()).toBe('');
  });

  const expectPlain404 = async (res: Response) => {
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Attachment not found.' },
    });
  };

  test('an unknown id and a malformed one get the same plain 404, never cached', async () => {
    await expectPlain404(await fetchFile(`/api/attachments/${randomUUID()}`));
    await expectPlain404(await fetchFile('/api/attachments/not-a-uuid'));
    await expectPlain404(await fetchFile("/api/attachments/'%20OR%201=1--"));
    await expectPlain404(await fetchFile('/api/attachments/..%2F..%2Fetc%2Fpasswd'));
    const head = await fetchFile(`/api/attachments/${randomUUID()}`, { method: 'HEAD' });
    expect(head.status).toBe(404);
    expect(head.headers.get('cache-control')).toBe('no-store');
  });

  test('a row whose file is missing, as after restoring a database, is a 404', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    rmSync(join(api.uploadsDir, attachment.id));
    expect(await row(attachment.id)).not.toBeNull();
    await expectPlain404(await fetchFile(attachment.url));
    const ranged = await fetchFile(attachment.url, { headers: { Range: 'bytes=0-1' } });
    expect(ranged.status).toBe(404);
  });

  test('a file that vanishes after the check is a 404 as well', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    vi.spyOn(api.ctx.attachments, 'hasFile').mockResolvedValue(true);
    rmSync(join(api.uploadsDir, attachment.id));
    await expectPlain404(await fetchFile(attachment.url));
  });

  test('needs no session, and a stale cookie does not get in the way', async () => {
    const url = await videoUrl();
    expect((await fetchFile(url)).status).toBe(200);
    const res = await fetchFile(url, {
      headers: { Cookie: 'hostile_session=expired-nonsense' },
    });
    expect(res.status).toBe(200);
  });

  test('every Origin gets the same answer, so a long-lived cache entry suits them all', async () => {
    const url = await videoUrl();
    for (const origin of [undefined, TEST_APP_ORIGIN, 'https://elsewhere.example']) {
      const res = await fetchFile(url, origin ? { headers: { Origin: origin } } : {});
      expect(res.status, origin).toBe(200);
      expect(res.headers.get('access-control-allow-origin'), origin).toBe('*');
      expect(res.headers.get('vary'), origin).toBeNull();
    }
  });

  test('the desktop client can get a preflight for a discard, past the public route', async () => {
    const res = await fetchFile(`/api/attachments/${randomUUID()}`, {
      method: 'OPTIONS',
      headers: { Origin: 'hostile://hostile', 'Access-Control-Request-Method': 'DELETE' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('hostile://hostile');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
  });
});

describe('who may upload', () => {
  const tooLarge = buildPng(64, 64, LIMITS.attachmentImageMaxBytes + 1);

  test('an unauthenticated upload is refused', async () => {
    const channel = await newChannel();
    for (const body of [PNG.bytes, tooLarge]) {
      const answer = await upload(channel.id, body, { headers: {} });
      expect(answer.status).toBe(401);
      expect(answer.body.error.code).toBe('unauthenticated');
    }
    await expectNothingStored(channel.id);
  });

  test('a bad bearer token is refused', async () => {
    const channel = await newChannel();
    const answer = await upload(channel.id, PNG.bytes, {
      headers: { Authorization: 'Bearer hsa1.nope.nope' },
    });
    expect(answer.status).toBe(401);
  });

  test('a cookie session needs the CSRF token', async () => {
    const channel = await newChannel();
    const web: WebSession = await loginWeb(api, alice);
    for (const body of [PNG.bytes, tooLarge]) {
      const answer = await upload(channel.id, body, { headers: { Cookie: web.cookie } });
      expect(answer.status).toBe(403);
      expect(answer.body.error.code).toBe('csrf_failed');
    }
    const wrong = await upload(channel.id, PNG.bytes, {
      headers: { Cookie: web.cookie, 'X-CSRF-Token': 'not-the-token' },
    });
    expect(wrong.status).toBe(403);
    await expectNothingStored(channel.id);

    const right = await upload(channel.id, PNG.bytes, { headers: webAuth(web) });
    expect(right.status).toBe(201);
  });

  test('a foreign Origin is refused, and the app itself is not', async () => {
    const channel = await newChannel();
    const foreign = await upload(channel.id, tooLarge, {
      headers: { ...bearerAuth(alice.session), Origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('origin_not_allowed');
    await expectNothingStored(channel.id);

    const own = await upload(channel.id, PNG.bytes, {
      headers: { ...bearerAuth(alice.session), Origin: TEST_APP_ORIGIN },
    });
    expect(own.status).toBe(201);
  });
});

describe('discarding an upload', () => {
  test('removes the row and the file, and the URL stops working', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const res = await discard(attachment.id, bearerAuth(alice.session));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await row(attachment.id)).toBeNull();
    expect(hasFile(attachment.id)).toBe(false);
    expect((await fetchFile(attachment.url)).status).toBe(404);
    expect((await discard(attachment.id, bearerAuth(alice.session))).status).toBe(404);
  });

  test('another member cannot do it, not even the owner', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    for (const session of [bob.session, owner.session]) {
      const res = await discard(attachment.id, bearerAuth(session));
      expect(res.status).toBe(403);
      expect(((await res.json()) as Answer['body']).error.message).toBe(
        'You can only remove your own attachments.',
      );
    }
    expect(await row(attachment.id)).not.toBeNull();
    expect(hasFile(attachment.id)).toBe(true);
  });

  test('one already on a message stays there, file and all', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    await send(alice.session, channel.id, { attachmentIds: [attachment.id] }).expect(201);
    const res = await discard(attachment.id, bearerAuth(alice.session));
    expect(res.status).toBe(409);
    expect(await row(attachment.id)).not.toBeNull();
    expect(hasFile(attachment.id)).toBe(true);
  });

  test('needs a session and the CSRF token, and a real id', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    expect((await discard(attachment.id, {})).status).toBe(401);

    const web = await loginWeb(api, alice);
    const noToken = await discard(attachment.id, { Cookie: web.cookie });
    expect(noToken.status).toBe(403);
    expect(((await noToken.json()) as Answer['body']).error.code).toBe('csrf_failed');
    expect(await row(attachment.id)).not.toBeNull();

    expect((await discard('not-a-uuid', bearerAuth(alice.session))).status).toBe(400);
    expect((await discard(attachment.id, webAuth(web))).status).toBe(204);
  });
});

describe('sending attachments', () => {
  test('they come back on the message in the order they were listed', async () => {
    const channel = await newChannel();
    const a = await uploaded(channel.id, PNG.bytes, { query: { name: 'a.png' } });
    const b = await uploaded(channel.id, MP4.bytes, { query: { name: 'b.mp4' } });
    const c = await uploaded(channel.id, REAL_IMAGES.jpeg.bytes, { query: { name: 'c.jpg' } });
    const res = await send(alice.session, channel.id, {
      content: 'look',
      attachmentIds: [c.id, a.id, b.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.message.content).toBe('look');
    expect(res.body.message.attachments).toEqual([c, a, b]);
    const rows = await api.ctx.db.messageAttachment.findMany({
      where: { messageId: res.body.message.id },
      orderBy: { position: 'asc' },
    });
    expect(rows.map((r) => [r.id, r.position])).toEqual([
      [c.id, 0],
      [a.id, 1],
      [b.id, 2],
    ]);
  });

  test('the most a message can carry is ten', async () => {
    const channel = await newChannel();
    const eleven = await Promise.all(
      Array.from({ length: LIMITS.attachmentsPerMessage + 1 }, () => uploaded(channel.id)),
    );
    const ids = eleven.map((attachment) => attachment.id);
    const over = await send(alice.session, channel.id, { attachmentIds: ids });
    expect(over.status).toBe(400);
    expect(over.body.error.issues[0].path).toBe('attachmentIds');
    expect(await messagesIn(channel.id)).toBe(0);

    const atLimit = await send(alice.session, channel.id, {
      attachmentIds: ids.slice(0, LIMITS.attachmentsPerMessage),
    });
    expect(atLimit.status).toBe(201);
    expect(atLimit.body.message.attachments).toHaveLength(LIMITS.attachmentsPerMessage);
  });

  test('the same one twice is refused', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const res = await send(alice.session, channel.id, {
      content: 'twice',
      attachmentIds: [attachment.id, attachment.id],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.issues[0].message).toBe('An attachment is listed more than once.');
    expect((await row(attachment.id))!.messageId).toBeNull();
  });

  async function expectNotClaimed(
    res: { status: number; body: Answer['body'] },
    channelId: string,
    attachmentId?: string,
  ) {
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('attachments_not_claimable');
    expect(res.body.error.issues![0]!.path).toBe('attachmentIds');
    expect(await messagesIn(channelId)).toBe(0);
    const channel = await api.ctx.db.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(channel.changeCounter).toBe(0);
    expect(channel.lastMessageSeq).toBe(0);
    if (attachmentId) expect((await row(attachmentId))!.messageId).toBeNull();
  }

  test("another member cannot claim someone else's upload", async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const res = await send(bob.session, channel.id, {
      content: 'mine now',
      attachmentIds: [attachment.id],
    });
    await expectNotClaimed(res, channel.id, attachment.id);
    const byOwner = await send(owner.session, channel.id, { attachmentIds: [attachment.id] });
    await expectNotClaimed(byOwner, channel.id, attachment.id);
  });

  test('an upload to another channel cannot be claimed', async () => {
    const [here, there] = await Promise.all([newChannel(), newChannel()]);
    const attachment = await uploaded(there.id);
    const res = await send(alice.session, here.id, {
      content: 'moved',
      attachmentIds: [attachment.id],
    });
    await expectNotClaimed(res, here.id, attachment.id);
  });

  test('an id that does not exist cannot be claimed', async () => {
    const channel = await newChannel();
    const res = await send(alice.session, channel.id, { attachmentIds: [randomUUID()] });
    await expectNotClaimed(res, channel.id);
  });

  test('one bad id in a list claims none of the good ones', async () => {
    const channel = await newChannel();
    const good = await uploaded(channel.id);
    const res = await send(alice.session, channel.id, {
      attachmentIds: [good.id, randomUUID()],
    });
    await expectNotClaimed(res, channel.id, good.id);
  });

  test('a refused send leaves its nonce free for the retry that fixes it', async () => {
    const channel = await newChannel();
    const good = await uploaded(channel.id);
    const clientNonce = randomUUID();
    const refused = await send(alice.session, channel.id, {
      clientNonce,
      attachmentIds: [randomUUID()],
    });
    await expectNotClaimed(refused, channel.id);
    const retried = await send(alice.session, channel.id, {
      clientNonce,
      attachmentIds: [good.id],
    });
    expect(retried.status).toBe(201);
    expect(retried.body.duplicate).toBe(false);
  });

  test('one cannot be claimed twice', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const first = await send(alice.session, channel.id, { attachmentIds: [attachment.id] });
    expect(first.status).toBe(201);

    const second = await send(alice.session, channel.id, {
      content: 'again',
      attachmentIds: [attachment.id],
    });
    expect(second.status).toBe(400);
    expect(second.body.error.issues[0].path).toBe('attachmentIds');
    expect(await messagesIn(channel.id)).toBe(1);
    expect((await row(attachment.id))!.messageId).toBe(first.body.message.id);
  });

  test('one cannot be claimed twice at once either', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        send(alice.session, channel.id, { attachmentIds: [attachment.id] }),
      ),
    );
    const winners = results.filter((res) => res.status === 201);
    expect(winners).toHaveLength(1);
    expect(results.filter((res) => res.status === 400)).toHaveLength(5);
    expect(await messagesIn(channel.id)).toBe(1);
    expect((await row(attachment.id))!.messageId).toBe(winners[0]!.body.message.id);
  });

  test('a retry returns the original message, with its attachments', async () => {
    const channel = await newChannel();
    const [a, b] = [await uploaded(channel.id), await uploaded(channel.id, MP4.bytes)];
    const clientNonce = randomUUID();
    const body = { clientNonce, content: 'once', attachmentIds: [b.id, a.id] };

    const first = await send(alice.session, channel.id, body);
    expect(first.status).toBe(201);
    const retry = await send(alice.session, channel.id, body);
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.message.id).toBe(first.body.message.id);
    expect(retry.body.message.attachments).toEqual([b, a]);
    expect(await messagesIn(channel.id)).toBe(1);
  });

  test('retries racing each other all get the one message', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const clientNonce = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        send(alice.session, channel.id, { clientNonce, attachmentIds: [attachment.id] }),
      ),
    );
    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    expect(results.filter((res) => res.status === 200)).toHaveLength(5);
    for (const res of results) {
      expect(res.body.message.attachments.map((a: AttachmentDTO) => a.id)).toEqual([attachment.id]);
    }
    expect(await messagesIn(channel.id)).toBe(1);
  });
});

describe('empty text', () => {
  test('a message may have none only when it has attachments', async () => {
    const channel = await newChannel();
    for (const content of ['', '   ', '\n']) {
      for (const attachmentIds of [undefined, []]) {
        const res = await send(alice.session, channel.id, {
          content,
          ...(attachmentIds ? { attachmentIds } : {}),
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('validation_error');
        expect(res.body.error.issues[0]).toEqual({ path: 'content', message: 'Message is empty.' });
      }
    }
    expect(await messagesIn(channel.id)).toBe(0);

    const attachment = await uploaded(channel.id);
    const res = await send(alice.session, channel.id, {
      content: '  \n ',
      attachmentIds: [attachment.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.message.content).toBe('');
  });

  test('a message with attachments may be edited to empty, and they stay', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const sent = await send(alice.session, channel.id, {
      content: 'caption',
      attachmentIds: [attachment.id],
    });
    const res = await edit(alice.session, sent.body.message.id, '');
    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe('');
    expect(res.body.message.editedAt).not.toBeNull();
    expect(res.body.message.attachments).toEqual([attachment]);

    const back = await edit(alice.session, sent.body.message.id, 'caption again');
    expect(back.body.message.content).toBe('caption again');
    expect(back.body.message.attachments).toEqual([attachment]);
  });

  test('a message without attachments may not be edited to empty', async () => {
    const channel = await newChannel();
    const message = await sendMessage(api, alice.session, channel.id, 'words');
    for (const content of ['', '   ']) {
      const res = await edit(alice.session, message.id, content);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(res.body.error.issues[0]).toEqual({ path: 'content', message: 'Message is empty.' });
    }
    const stored = await api.ctx.db.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(stored.content).toBe('words');
    expect(stored.editedAt).toBeNull();
  });

  test('an edit cannot touch the attachments themselves', async () => {
    const channel = await newChannel();
    const [kept, other] = [await uploaded(channel.id), await uploaded(channel.id)];
    const sent = await send(alice.session, channel.id, { attachmentIds: [kept.id] });
    const res = await api
      .http()
      .patch(`/api/messages/${sent.body.message.id}`)
      .set(bearerAuth(alice.session))
      .send({ content: 'x', attachmentIds: [other.id] });
    expect(res.status).toBe(400);
    expect((await row(other.id))!.messageId).toBeNull();
  });
});

describe('deleting a message', () => {
  test('removes the rows and the files, and the DTO says none are left', async () => {
    const channel = await newChannel();
    const [a, b] = [await uploaded(channel.id), await uploaded(channel.id, MP4.bytes)];
    const sent = await send(alice.session, channel.id, { attachmentIds: [a.id, b.id] });
    expect(hasFile(a.id)).toBe(true);

    const res = await removeMessage(alice.session, sent.body.message.id);
    expect(res.status).toBe(200);
    expect(res.body.message.deleted).toBe(true);
    expect(res.body.message.attachments).toEqual([]);

    expect(await rowsIn(channel.id)).toBe(0);
    expect(hasFile(a.id)).toBe(false);
    expect(hasFile(b.id)).toBe(false);
    expect((await fetchFile(a.url)).status).toBe(404);
  });

  test("the owner's moderation takes the files too", async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const sent = await send(alice.session, channel.id, { attachmentIds: [attachment.id] });
    expect((await removeMessage(owner.session, sent.body.message.id)).status).toBe(200);
    expect(hasFile(attachment.id)).toBe(false);
  });

  test('a stranger cannot, and the files stay', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const sent = await send(alice.session, channel.id, { attachmentIds: [attachment.id] });
    expect((await removeMessage(bob.session, sent.body.message.id)).status).toBe(403);
    expect(await row(attachment.id)).not.toBeNull();
    expect(hasFile(attachment.id)).toBe(true);
  });

  test('a file that cannot be removed is logged, and the delete still stands', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const sent = await send(alice.session, channel.id, { attachmentIds: [attachment.id] });
    const path = join(api.uploadsDir, attachment.id);
    rmSync(path);
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), 'x');
    const logged = vi.spyOn(api.ctx.log, 'error');

    const res = await removeMessage(alice.session, sent.body.message.id);
    expect(res.status).toBe(200);
    expect(res.body.message.deleted).toBe(true);
    expect(await rowsIn(channel.id)).toBe(0);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: attachment.id }),
      'could not remove an attachment file',
    );
    rmSync(path, { recursive: true });
  });

  test('a rolled-back delete keeps its files', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    const sent = await send(alice.session, channel.id, { attachmentIds: [attachment.id] });
    await api.ctx.db.channel.update({
      where: { id: channel.id },
      data: { archivedAt: new Date() },
    });
    expect((await removeMessage(alice.session, sent.body.message.id)).status).toBe(404);
    expect(await row(attachment.id)).not.toBeNull();
    expect(hasFile(attachment.id)).toBe(true);
  });
});

describe('what removes nothing', () => {
  test('archiving a channel leaves its files served', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id);
    await send(alice.session, channel.id, { attachmentIds: [attachment.id] }).expect(201);
    await api.ctx.db.channel.update({
      where: { id: channel.id },
      data: { archivedAt: new Date() },
    });
    expect(await row(attachment.id)).not.toBeNull();
    expect((await fetchFile(attachment.url)).status).toBe(200);
  });

  test('disabling a member leaves their files served', async () => {
    const channel = await newChannel();
    const user = await createUser(api.ctx);
    const session = await loginDesktop(api, user);
    const attachment = await uploaded(channel.id, PNG.bytes, { session });
    await send(session, channel.id, { attachmentIds: [attachment.id] }).expect(201);
    await api.ctx.db.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    expect(await row(attachment.id)).not.toBeNull();
    expect((await fetchFile(attachment.url)).status).toBe(200);
  });
});

describe('the sweep', () => {
  const HOUR = 60 * 60 * 1000;
  const age = (id: string, ms: number) =>
    api.ctx.db.messageAttachment.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - ms) },
    });

  test('removes old unclaimed uploads, and leaves claimed and fresh ones', async () => {
    const channel = await newChannel();
    const stale = await uploaded(channel.id);
    const nearly = await uploaded(channel.id);
    const fresh = await uploaded(channel.id);
    const claimed = await uploaded(channel.id);
    await send(alice.session, channel.id, { attachmentIds: [claimed.id] }).expect(201);

    await age(stale.id, 25 * HOUR);
    await age(nearly.id, 23 * HOUR);
    await age(claimed.id, 24 * 400 * HOUR);

    expect(await api.ctx.attachments.sweep()).toBe(1);

    expect(await row(stale.id)).toBeNull();
    expect(hasFile(stale.id)).toBe(false);
    expect((await fetchFile(stale.url)).status).toBe(404);
    for (const kept of [nearly, fresh, claimed]) {
      expect(await row(kept.id)).not.toBeNull();
      expect(hasFile(kept.id)).toBe(true);
    }
  });

  test('a swept upload can no longer be sent', async () => {
    const channel = await newChannel();
    const stale = await uploaded(channel.id);
    await age(stale.id, 25 * HOUR);
    await api.ctx.attachments.sweep();
    const res = await send(alice.session, channel.id, { attachmentIds: [stale.id] });
    expect(res.status).toBe(400);
    expect(res.body.error.issues[0].path).toBe('attachmentIds');
  });

  test('a row with no file, as after restoring a database, is swept all the same', async () => {
    const channel = await newChannel();
    const stale = await uploaded(channel.id);
    rmSync(join(api.uploadsDir, stale.id));
    await age(stale.id, 25 * HOUR);
    expect(await api.ctx.attachments.sweep()).toBe(1);
    expect(await row(stale.id)).toBeNull();
  });

  test('starting up clears stray temp files, and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hostile-startup-'));
    const finished = randomUUID();
    writeFileSync(join(dir, finished), 'a finished file');
    writeFileSync(join(dir, `${randomUUID()}.part`), 'from a process that died');
    writeFileSync(join(dir, `${randomUUID()}.part`), 'from a process that died');

    const store = new AttachmentStore(api.ctx.db, api.ctx.log, dir);
    await store.start();
    store.stop();

    expect(readdirSync(dir)).toEqual([finished]);
    rmSync(dir, { recursive: true });
  });
});

describe('the disk guard', () => {
  const diskFullMessage =
    'The server is almost out of disk space, so it cannot take this file. Tell the owner.';
  const free = (...answers: number[]) => {
    const spy = vi.spyOn(api.ctx.attachments, 'freeBytes');
    for (const answer of answers) spy.mockResolvedValueOnce(answer);
    return spy;
  };

  test('reads the real disk, and it answers in bytes', async () => {
    const bytes = await api.ctx.attachments.freeBytes(api.uploadsDir);
    expect(bytes).toBeGreaterThan(0);
    expect(Number.isSafeInteger(bytes)).toBe(true);
  });

  test('takes a file that leaves exactly the reserve free, and not a byte less', async () => {
    const channel = await newChannel();
    const size = PNG.bytes.length;

    free(DISK_RESERVE_BYTES + size);
    expect((await upload(channel.id, PNG.bytes)).status).toBe(201);
    expect(await rowsIn(channel.id)).toBe(1);

    free(DISK_RESERVE_BYTES + size - 1);
    const refused = await upload(channel.id, PNG.bytes);
    expect(refused.status).toBe(507);
    expect(refused.body.error).toEqual({ code: 'uploads_unavailable', message: diskFullMessage });
    expect(await rowsIn(channel.id)).toBe(1);
    await waitFor('temp files to be gone', () => tempFiles().length === 0);
  });

  test('refuses a file of unknown length when the disk is already at the reserve', async () => {
    const channel = await newChannel();
    free(DISK_RESERVE_BYTES - 1);
    const refused = await upload(channel.id, streamOf(MP4.bytes, 4 * MB), { init: streaming });
    expect(refused.status).toBe(507);
    await expectNothingStored(channel.id);
  });

  test('keeps checking while a file of known length arrives', async () => {
    const channel = await newChannel();
    const size = 24 * MB;
    const video = Buffer.concat([MP4.bytes, Buffer.alloc(size - MP4.bytes.length)]);
    const spy = free(DISK_RESERVE_BYTES + size);
    spy.mockResolvedValue(DISK_RESERVE_BYTES);
    const refused = await upload(channel.id, video);
    expect(refused.status).toBe(507);
    expect(refused.body.error.message).toBe(diskFullMessage);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    await expectNothingStored(channel.id);
  });

  test('keeps checking while a file of unknown length arrives', async () => {
    const channel = await newChannel();
    const spy = free(DISK_RESERVE_BYTES + 1);
    spy.mockResolvedValue(DISK_RESERVE_BYTES - 1);
    const refused = await upload(channel.id, streamOf(MP4.bytes, 40 * MB), { init: streaming });
    expect(refused.status).toBe(507);
    await expectNothingStored(channel.id);
  });

  test('takes the disk running out for real, past every check', async () => {
    const channel = await newChannel();
    const spy = vi.spyOn(api.ctx.attachments, 'freeBytes');
    spy.mockRejectedValue(Object.assign(new Error('statfs failed'), { code: 'EIO' }));
    const answer = await upload(channel.id, PNG.bytes);
    expect(answer.status).toBe(503);
    expect(answer.body.error.code).toBe('uploads_unavailable');
    await expectNothingStored(channel.id);
  });
});

describe('where attachments show up', () => {
  const open: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];

  afterEach(() => {
    for (const socket of open.splice(0)) socket.disconnect();
  });

  async function listen(session: DesktopSession) {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(api.baseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      auth: { token: session.accessToken },
    });
    open.push(socket);
    const created: MessageDTO[] = [];
    const updated: MessageDTO[] = [];
    socket.on('message:created', (message) => created.push(message));
    socket.on('message:updated', (message) => updated.push(message));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return { created, updated };
  }

  const history = (channelId: string) =>
    api.http().get(`/api/channels/${channelId}/messages`).set(bearerAuth(alice.session));
  const changes = (channelId: string, since: number) =>
    api
      .http()
      .get(`/api/channels/${channelId}/changes?since=${since}`)
      .set(bearerAuth(alice.session));

  test('history, changes and the socket events carry them, in order', async () => {
    const channel = await newChannel();
    const events = await listen(bob.session);
    const [a, b] = [await uploaded(channel.id), await uploaded(channel.id, MP4.bytes)];
    await sendMessage(api, alice.session, channel.id, 'just words');
    const sent = await send(alice.session, channel.id, {
      content: 'with files',
      attachmentIds: [b.id, a.id],
    });
    const id = sent.body.message.id as string;

    const inHistory = (await history(channel.id)).body.messages as MessageDTO[];
    expect(inHistory.map((m) => m.attachments)).toEqual([[], [b, a]]);

    const inChanges = (await changes(channel.id, 0)).body.changes as MessageDTO[];
    expect(inChanges.map((m) => m.attachments)).toEqual([[], [b, a]]);

    const onCreated = await waitFor('message:created with files', () =>
      events.created.find((m) => m.id === id),
    );
    expect(onCreated.attachments).toEqual([b, a]);
    expect(events.created.find((m) => m.content === 'just words')?.attachments).toEqual([]);

    await edit(alice.session, id, '').expect(200);
    const onEdited = await waitFor('message:updated after the edit', () => events.updated[0]);
    expect(onEdited.content).toBe('');
    expect(onEdited.attachments).toEqual([b, a]);

    const seq = sent.body.message.changeSeq as number;
    const afterEdit = (await changes(channel.id, seq)).body.changes as MessageDTO[];
    expect(afterEdit.map((m) => m.attachments)).toEqual([[b, a]]);

    await removeMessage(alice.session, id).expect(200);
    const onDeleted = await waitFor('message:updated after the delete', () => events.updated[1]);
    expect(onDeleted.deleted).toBe(true);
    expect(onDeleted.attachments).toEqual([]);

    const afterDelete = (await changes(channel.id, seq)).body.changes as MessageDTO[];
    expect(afterDelete.map((m) => [m.id, m.deleted, m.attachments])).toEqual([[id, true, []]]);
    const finalHistory = (await history(channel.id)).body.messages as MessageDTO[];
    expect(finalHistory.map((m) => m.content)).toEqual(['just words']);
  });

  test('a refused send tells nobody', async () => {
    const channel = await newChannel();
    const events = await listen(bob.session);
    const attachment = await uploaded(channel.id);
    await send(bob.session, channel.id, { attachmentIds: [attachment.id] }).expect(400);
    await sendMessage(api, alice.session, channel.id, 'next');
    await waitFor('the next message', () => events.created[0]);
    expect(events.created.map((m) => m.content)).toEqual(['next']);
  });
});

describe('with the rate limiter on', () => {
  let limited: TestApi;

  beforeAll(async () => {
    limited = await startTestApi({ rateLimit: true });
  });

  afterAll(async () => {
    await limited?.stop();
  });

  test('attempts are counted before the body, and the file is not read', async () => {
    const channel = await newChannel();
    const user = await createUser(limited.ctx);
    const session = await loginDesktop(limited, user);
    const stranger = await loginDesktop(limited, await createUser(limited.ctx));

    for (let i = 0; i < ATTACHMENT_UPLOADS_PER_HOUR; i++) {
      const attempt = await upload(channel.id, Buffer.from('not a file'), { session, on: limited });
      expect(attempt.status, `attempt ${i}`).toBe(415);
    }

    const over = await upload(channel.id, PNG.bytes, { session, on: limited });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('rate_limited');
    expect(over.body.error.retryAfterSec).toBeGreaterThan(0);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(filesOnDisk(limited)).toEqual([]);

    expect((await upload(channel.id, PNG.bytes, { session: stranger, on: limited })).status).toBe(
      201,
    );
  });
});

describe('with storage that cannot be written', () => {
  let broken: TestApi;
  let parent: string;

  beforeAll(async () => {
    parent = mkdtempSync(join(tmpdir(), 'hostile-broken-'));
    writeFileSync(join(parent, 'a-file'), '');
    broken = await startTestApi({ env: { UPLOADS_DIR: join(parent, 'a-file', 'uploads') } });
  });

  afterAll(async () => {
    await broken?.stop();
    rmSync(parent, { recursive: true, force: true });
  });

  test('the app comes up and serves text chat, and refuses only the uploads', async () => {
    const health = await fetch(`${broken.baseUrl}/api/health`);
    expect(health.status).toBeLessThan(500);

    const channel = await newChannel();
    const session = await loginDesktop(broken, await createUser(broken.ctx));
    const message = await sendMessage(broken, session, channel.id, 'still talking');
    expect(message.content).toBe('still talking');

    const answer = await upload(channel.id, PNG.bytes, { session, on: broken });
    expect(answer.status).toBe(503);
    expect(answer.body.error).toEqual({
      code: 'uploads_unavailable',
      message: 'The server cannot store files right now. Tell the owner.',
    });
    expect(await rowsIn(channel.id)).toBe(0);
  });

  test('says so loudly at startup, and carries on', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = new AttachmentStore(
      broken.ctx.db,
      log as unknown as typeof broken.ctx.log,
      join(parent, 'a-file', 'uploads'),
    );
    await expect(store.start()).resolves.toBeUndefined();
    store.stop();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ dir: join(parent, 'a-file', 'uploads') }),
      expect.stringMatching(/^UPLOADS_DIR IS NOT WRITABLE/),
    );
  });

  test('fixing the disk needs no restart', async () => {
    rmSync(join(parent, 'a-file'));
    const channel = await newChannel();
    const session = await loginDesktop(broken, await createUser(broken.ctx));
    const answer = await upload(channel.id, PNG.bytes, { session, on: broken });
    expect(answer.status).toBe(201);
  });
});

describe('location data in an upload', () => {
  const located = Object.entries(REAL_LOCATED);
  const onDisk = (id: string) => readFileSync(join(api.uploadsDir, id));
  const LOCATION_TEXT = ['+48.8584', 'Paris', 'France', 'Champ de Mars', 'GPSLatitude'];

  for (const [name, { bytes, type }] of located) {
    test(`${name} is stored without it, and is served that way`, async () => {
      const channel = await newChannel();
      const attachment = await uploaded(channel.id, bytes);
      expect(attachment.contentType).toBe(type);
      expect(attachment.byteSize).toBe(bytes.length);

      const stored = onDisk(attachment.id);
      const served = Buffer.from(await (await fetchFile(attachment.url)).arrayBuffer());
      expect(served.equals(stored)).toBe(true);
      expect(stored.length).toBe(bytes.length);
      expect(stored.equals(bytes)).toBe(false);
      for (const text of LOCATION_TEXT) {
        expect(stored.includes(Buffer.from(text)), text).toBe(false);
      }
      if (type === 'image/jpeg' || type === 'image/png' || type === 'image/webp') {
        expect(hasGpsPointer(stored)).toBe(false);
        expect(orientationIn(stored)).toBe(6);
      }
    });
  }

  test('a photo turned by its orientation records the size it is drawn at', async () => {
    const channel = await newChannel();
    const jpeg = await uploaded(channel.id, REAL_LOCATED.appleJpeg.bytes);
    expect([jpeg.width, jpeg.height]).toEqual([32, 64]);
    const png = await uploaded(channel.id, REAL_LOCATED.applePng.bytes);
    expect([png.width, png.height]).toEqual([32, 64]);
    const webp = await uploaded(channel.id, REAL_LOCATED.pillowWebp.bytes);
    expect([webp.width, webp.height]).toEqual([64, 32]);
    const straight = jpegWith(jpegExifSegment(buildExif({ orientation: 1 }).tiff));
    const flat = await uploaded(channel.id, straight);
    expect([flat.width, flat.height]).toEqual([40, 20]);
  });

  test('that size is what the message carries, and what a reader gets later', async () => {
    const channel = await newChannel();
    const attachment = await uploaded(channel.id, REAL_LOCATED.appleJpeg.bytes);
    const sent = await send(alice.session, channel.id, { attachmentIds: [attachment.id] });
    expect(sent.status).toBe(201);
    const [fromMessage] = (sent.body.message as MessageDTO).attachments;
    expect([fromMessage!.width, fromMessage!.height]).toEqual([32, 64]);
  });

  test('a file that does not parse as expected is stored as it came, and logged with no value in it', async () => {
    const warn = vi.spyOn(api.ctx.log, 'warn');
    const channel = await newChannel();
    const coordinates = 'lat 48.8584 lon 2.2945';
    const broken = jpegWith(
      jpegSegment(0xe1, Buffer.concat([EXIF_PREFIX, Buffer.from(coordinates, 'latin1')])),
    );
    const attachment = await uploaded(channel.id, broken);
    expect(onDisk(attachment.id).equals(broken)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]! as unknown as [object, string];
    expect(fields).toMatchObject({ contentType: 'image/jpeg', problems: ['exif_malformed'] });
    expect(JSON.stringify(fields) + message).not.toContain('48.8584');
  });

  test('a video with an atom that lies about its size is stored as it came', async () => {
    const warn = vi.spyOn(api.ctx.log, 'warn');
    const channel = await newChannel();
    const lying = atom('udta', qtText(XYZ, '+48.8584+002.2945/'));
    lying.writeUInt32BE(0xffffff, 0);
    const file = mp4With(atom('moov', lying));
    const attachment = await uploaded(channel.id, file);
    expect(onDisk(attachment.id).equals(file)).toBe(true);
    expect(warn.mock.calls[0]![0]).toMatchObject({ problems: ['mp4_structure'] });
  });

  test('a file with no location comes back byte for byte, with nothing logged', async () => {
    const warn = vi.spyOn(api.ctx.log, 'warn');
    const channel = await newChannel();
    for (const image of [...Object.values(REAL_IMAGES), ...Object.values(REAL_VIDEOS)]) {
      const attachment = await uploaded(channel.id, image.bytes);
      expect(onDisk(attachment.id).equals(image.bytes)).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test('nothing but the renamed file is left in the directory', async () => {
    const channel = await newChannel();
    await uploaded(channel.id, REAL_LOCATED.pillowJpeg.bytes);
    expect(tempFiles()).toEqual([]);
  });

  test('a disk that fails during cleaning refuses the upload, rather than keep the location', async () => {
    const channel = await newChannel();
    const probe = await openFile(api.uploadsDir, 'r');
    const handles = Object.getPrototypeOf(probe) as { write(): Promise<unknown> };
    await probe.close();
    const failure = Object.assign(new Error('write failed'), { code: 'EIO', syscall: 'write' });
    const write = vi.spyOn(handles, 'write').mockRejectedValue(failure);
    const answer = await upload(channel.id, REAL_LOCATED.pillowJpeg.bytes);
    expect(write).toHaveBeenCalled();
    expect(answer.status).toBe(503);
    expect(answer.body.error.code).toBe('uploads_unavailable');
    await expectNothingStored(channel.id);
  });
});
