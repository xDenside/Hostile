import { randomUUID } from 'node:crypto';
import {
  access,
  constants,
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { LIMITS, type AttachmentType } from '@hostile/shared';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import type { MessageAttachment } from '../generated/prisma/client.js';
import { setRequestDeadline, touchRequestDeadline } from '../http/request-deadline.js';
import { errors, HttpError } from '../lib/errors.js';
import {
  decodeRefusal,
  detectImageType,
  sniffImageFile,
  type ImageRejection,
} from '../lib/image-sniff.js';
import { stripLocationFromFile } from '../lib/location-strip.js';
import { attachmentKind } from '../lib/mappers.js';
import { sniffVideo, VIDEO_SNIFF_BYTES } from '../lib/video-sniff.js';

export const DISK_RESERVE_BYTES = 3 * 1024 * 1024 * 1024;

const DISK_CHECK_EVERY_BYTES = 8 * 1024 * 1024;

export const UNCLAIMED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const TEMP_SUFFIX = '.part';

const UPLOAD_IDLE_MS = 2 * 60 * 1000;
const UPLOAD_MAX_MS = 2 * 60 * 60 * 1000;

const SNIFF_BYTES = VIDEO_SNIFF_BYTES;

const MB = 1024 * 1024;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const allowanceUsed = () =>
  errors.payloadTooLarge(
    `You have uploaded ${LIMITS.attachmentDailyBytes / (1024 * MB)} GB of files in the last 24 hours, which is the most one person can. Try again later.`,
  );

const maxBytesFor = (type: AttachmentType): number =>
  attachmentKind(type) === 'video'
    ? LIMITS.attachmentVideoMaxBytes
    : LIMITS.attachmentImageMaxBytes;

const tooLarge = (type: AttachmentType) =>
  errors.payloadTooLarge(
    attachmentKind(type) === 'video'
      ? `That video is too large. A video can be up to ${LIMITS.attachmentVideoMaxBytes / MB} MB.`
      : `That image is too large. An image can be up to ${LIMITS.attachmentImageMaxBytes / MB} MB.`,
  );

const unsupported = () =>
  errors.invalidAttachment(
    415,
    'That file is not a PNG, JPEG, GIF or WebP image, or an MP4, MOV or WebM video.',
  );

const DECODE_REFUSALS = {
  memory: (width: number, height: number) =>
    errors.invalidAttachment(
      400,
      `That image is ${width} by ${height} pixels in a very small file, which could run other people's devices out of memory. Save it at a smaller size and try again.`,
    ),
  animation: () =>
    errors.invalidAttachment(
      400,
      "That animation has too many large frames for other people's devices to play. Save it shorter or at a smaller size and try again.",
    ),
};

const IMAGE_REJECTIONS: Record<ImageRejection, () => HttpError> = {
  unsupported,
  corrupt: () =>
    errors.invalidAttachment(400, 'That image is damaged or incomplete. Try another file.'),
  too_many_pixels: () =>
    errors.invalidAttachment(
      400,
      `That image is too large. It can be at most ${LIMITS.attachmentMaxEdge} pixels on a side.`,
    ),
};

const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const base = raw.replace(UNSAFE_NAME_CHARS, '').split(/[/\\]/).pop() ?? '';
  const name = base
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!name) return null;
  const chars = Array.from(name);
  if (chars.length <= LIMITS.attachmentFileNameMax) return name;
  const extension = /\.[^.]{1,16}$/.exec(name)?.[0] ?? '';
  const room = LIMITS.attachmentFileNameMax - Array.from(extension).length;
  return chars.slice(0, room).join('').trimEnd() + extension;
}

const EXTENSIONS: Record<AttachmentType, readonly [string, ...string[]]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg', 'jfif'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'video/mp4': ['mp4', 'm4v'],
  'video/quicktime': ['mov', 'qt'],
  'video/webm': ['webm'],
};

export function nameMatchingType(name: string, type: AttachmentType): string {
  const [preferred, ...others] = EXTENSIONS[type];
  const current = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  if (current === preferred || others.includes(current ?? '')) return name;
  const room = LIMITS.attachmentFileNameMax - preferred.length - 1;
  return `${Array.from(name).slice(0, room).join('').trimEnd()}.${preferred}`;
}

export function clampDimension(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.min(Math.round(value), LIMITS.attachmentMaxEdge);
}

export function inlineDisposition(fileName: string): string {
  const plain = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(Buffer.from(fileName).toString()).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

function declaredLength(req: IncomingMessage): number | null {
  const header = req.headers['content-length'];
  if (header === undefined) return null;
  const length = Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

const isSystemError = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error && typeof (err as NodeJS.ErrnoException).syscall === 'string';

export interface UploadDetails {
  channelId: string;
  uploaderId: string;
  name: unknown;
  width: unknown;
  height: unknown;
}

export class AttachmentStore {
  freeBytes = async (dir: string): Promise<number> => {
    const disk = await statfs(dir);
    return disk.bavail * disk.bsize;
  };

  linkFile: (from: string, to: string) => Promise<void> = link;

  private sweeper: NodeJS.Timeout | null = null;

  private readonly uploading = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    readonly dir: string,
  ) {}

  private pathOf(id: string): string {
    return join(this.dir, id);
  }

  async start(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const probe = join(this.dir, `${randomUUID()}${TEMP_SUFFIX}`);
      await writeFile(probe, '');
      await rm(probe);
      const names = await readdir(this.dir);
      await Promise.all(
        names
          .filter((name) => name.endsWith(TEMP_SUFFIX))
          .map((name) => rm(join(this.dir, name), { force: true })),
      );
      this.log.info({ dir: this.dir }, 'attachments are stored in UPLOADS_DIR');
    } catch (err) {
      this.log.error(
        { err, dir: this.dir },
        'UPLOADS_DIR IS NOT WRITABLE: file uploads will be refused until this is fixed. Chat still works.',
      );
    }
    await this.sweepQuietly();
    this.sweeper = setInterval(() => void this.sweepQuietly(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private async sweepQuietly(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.log.error({ err }, 'could not sweep unclaimed attachments');
    }
  }

  async sweep(now: number = Date.now()): Promise<number> {
    const cutoff = new Date(now - UNCLAIMED_UPLOAD_TTL_MS);
    const removed = await this.db.$queryRaw<{ id: string }[]>`
      DELETE FROM "message_attachments"
      WHERE "messageId" IS NULL AND "createdAt" < ${cutoff}
      RETURNING "id"`;
    await this.removeFiles(removed.map((row) => row.id));
    await this.db.uploadHour.deleteMany({
      where: { hour: { lt: new Date(now - DAY_MS - HOUR_MS) } },
    });
    return removed.length;
  }

  async storedInLastDay(userId: string, now: number = Date.now()): Promise<number> {
    const total = await this.db.uploadHour.aggregate({
      where: { userId, hour: { gt: new Date(now - DAY_MS) } },
      _sum: { bytes: true },
    });
    return total._sum.bytes ?? 0;
  }

  private async recordStored(userId: string, bytes: number): Promise<void> {
    const hour = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    try {
      await this.db.uploadHour.upsert({
        where: { userId_hour: { userId, hour } },
        create: { userId, hour, bytes },
        update: { bytes: { increment: bytes } },
      });
    } catch (err) {
      this.log.error(
        { err, userId, bytes },
        'could not count an upload toward its daily allowance',
      );
    }
  }

  async removeFiles(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await rm(this.pathOf(id), { force: true });
        } catch (err) {
          this.log.error({ err, attachmentId: id }, 'could not remove an attachment file');
        }
      }),
    );
  }

  async hasFile(id: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(id))).isFile();
    } catch {
      return false;
    }
  }

  private async assertWritable(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await access(this.dir, constants.W_OK);
    } catch (err) {
      this.log.error({ err, dir: this.dir }, 'UPLOADS_DIR is not writable; refused an upload');
      throw errors.uploadsUnavailable();
    }
  }

  private async assertRoomFor(incoming: number): Promise<void> {
    let free: number;
    try {
      free = await this.freeBytes(this.dir);
    } catch (err) {
      this.log.error({ err, dir: this.dir }, 'could not read the free space in UPLOADS_DIR');
      throw errors.uploadsUnavailable();
    }
    if (free - incoming < DISK_RESERVE_BYTES) {
      this.log.warn({ free, incoming }, 'refused an upload to keep the disk from filling up');
      throw errors.diskFull();
    }
  }

  async receive(req: IncomingMessage, upload: UploadDetails): Promise<MessageAttachment | null> {
    const encoding = req.headers['content-encoding'];
    if (encoding && encoding !== 'identity')
      throw errors.invalidAttachment(415, 'Send the file as it is, without compressing it.');
    const declared = declaredLength(req);
    if (declared !== null && declared > LIMITS.attachmentVideoMaxBytes)
      throw errors.payloadTooLarge(
        `That file is too large. An image can be up to ${LIMITS.attachmentImageMaxBytes / MB} MB and a video up to ${LIMITS.attachmentVideoMaxBytes / MB} MB.`,
      );
    const userId = upload.uploaderId;
    const stored = await this.storedInLastDay(userId);
    const left = () => LIMITS.attachmentDailyBytes - stored - (this.uploading.get(userId) ?? 0);
    if (left() <= 0 || (declared !== null && declared > left())) throw allowanceUsed();
    await this.assertWritable();
    await this.assertRoomFor(declared ?? 0);

    let counted = 0;
    const count = (bytes: number) => {
      counted += bytes;
      this.uploading.set(userId, (this.uploading.get(userId) ?? 0) + bytes);
      if (left() < 0) throw allowanceUsed();
    };

    const startedAt = Date.now();
    setRequestDeadline(req, UPLOAD_IDLE_MS);

    const id = randomUUID();
    const tempPath = `${this.pathOf(id)}${TEMP_SUFFIX}`;
    const body = req.iterator({ destroyOnReturn: false }) as AsyncGenerator<Buffer>;
    let file: FileHandle | null = null;
    try {
      const head: Buffer[] = [];
      let received = 0;
      let ended = false;
      while (received < SNIFF_BYTES && !ended) {
        const next = await body.next();
        touchRequestDeadline(req);
        if (next.done) ended = true;
        else {
          head.push(next.value);
          received += next.value.length;
          count(next.value.length);
        }
      }
      if (received === 0) throw errors.invalidAttachment(400, 'Choose a file to upload.');
      const headBytes = Buffer.concat(head);
      const imageType = detectImageType(headBytes);
      const type = imageType ?? sniffVideo(headBytes);
      if (!type) throw unsupported();
      const maxBytes = maxBytesFor(type);
      if (declared !== null && declared > maxBytes) throw tooLarge(type);

      file = await open(tempPath, 'wx+', 0o600);
      await file.writeFile(headBytes);

      let checkedAt = received;
      while (!ended) {
        const next = await body.next();
        touchRequestDeadline(req);
        if (next.done) break;
        received += next.value.length;
        if (received > maxBytes) throw tooLarge(type);
        count(next.value.length);
        if (Date.now() - startedAt > UPLOAD_MAX_MS) throw errors.uploadTooSlow();
        await file.writeFile(next.value);
        if (received - checkedAt >= DISK_CHECK_EVERY_BYTES) {
          checkedAt = received;
          await this.assertRoomFor(declared === null ? 0 : declared - received);
        }
      }

      let width: number | null = null;
      let height: number | null = null;
      if (imageType) {
        const image = await sniffImageFile(file, received, imageType, LIMITS.attachmentMaxEdge);
        if (!image.ok) throw IMAGE_REJECTIONS[image.reason]();
        const refusal = decodeRefusal(image.cost, received);
        if (refusal === 'memory') throw DECODE_REFUSALS.memory(image.width, image.height);
        if (refusal === 'animation') throw DECODE_REFUSALS.animation();
        width = image.width;
        height = image.height;
      } else {
        const claimedWidth = clampDimension(upload.width);
        const claimedHeight = clampDimension(upload.height);
        if (claimedWidth !== null && claimedHeight !== null) {
          width = claimedWidth;
          height = claimedHeight;
        }
      }
      const stripped = await stripLocationFromFile(file, received, type);
      if (stripped.problems.length) {
        this.log.warn(
          { attachmentId: id, contentType: type, problems: stripped.problems },
          'could not fully check an upload for location data, and stored it as it is',
        );
      }
      await file.close();
      file = null;

      const row = await this.db.messageAttachment.create({
        data: {
          id,
          channelId: upload.channelId,
          uploaderId: upload.uploaderId,
          contentType: type,
          fileName: nameMatchingType(
            sanitizeFileName(upload.name) ?? `attachment-${id.slice(0, 8)}`,
            type,
          ),
          byteSize: received,
          width,
          height,
        },
      });
      try {
        await rename(tempPath, this.pathOf(id));
      } catch (err) {
        await this.db.messageAttachment.delete({ where: { id } }).catch((deleteErr: unknown) => {
          this.log.error({ err: deleteErr, attachmentId: id }, 'could not remove a failed upload');
        });
        throw err;
      }
      await this.recordStored(userId, received);
      return row;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (req.destroyed && !req.complete) return null;
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
        this.log.error({ err, dir: this.dir }, 'the disk filled up during an upload');
        throw errors.diskFull();
      }
      if (isSystemError(err)) {
        this.log.error({ err, dir: this.dir }, 'could not store an upload');
        throw errors.uploadsUnavailable();
      }
      throw err;
    } finally {
      const still = (this.uploading.get(userId) ?? 0) - counted;
      if (still > 0) this.uploading.set(userId, still);
      else this.uploading.delete(userId);
      await body.return(undefined);
      await file?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch((err: unknown) => {
        this.log.error({ err, tempPath }, 'could not remove a temp file');
      });
    }
  }

  async duplicateFiles(sources: { id: string; byteSize: number }[]): Promise<string[]> {
    const made: string[] = [];
    try {
      for (const source of sources) {
        const id = randomUUID();
        await this.linkOrCopy(source, id);
        made.push(id);
      }
      return made;
    } catch (err) {
      await this.removeFiles(made);
      if (err instanceof HttpError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw errors.notFound('Attachment');
      if (code === 'ENOSPC') {
        this.log.error({ err, dir: this.dir }, 'the disk filled up copying files for a forward');
        throw errors.diskFull();
      }
      if (isSystemError(err)) {
        this.log.error({ err, dir: this.dir }, 'could not store the files of a forward');
        throw errors.uploadsUnavailable();
      }
      throw err;
    }
  }

  private async linkOrCopy(source: { id: string; byteSize: number }, id: string): Promise<void> {
    const from = this.pathOf(source.id);
    const to = this.pathOf(id);
    try {
      await this.linkFile(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'].includes(code)) {
        throw err;
      }
    }
    await this.assertRoomFor(source.byteSize);
    const tempPath = `${to}${TEMP_SUFFIX}`;
    try {
      await copyFile(from, tempPath, constants.COPYFILE_EXCL);
      await rename(tempPath, to);
    } finally {
      await rm(tempPath, { force: true }).catch((err: unknown) => {
        this.log.error({ err, tempPath }, 'could not remove a temp file');
      });
    }
  }

  async discard(actorId: string, id: string): Promise<void> {
    const row = await this.db.messageAttachment.findUnique({
      where: { id },
      select: { uploaderId: true, messageId: true },
    });
    if (!row) throw errors.notFound('Attachment');
    if (row.uploaderId !== actorId)
      throw errors.forbidden('You can only remove your own attachments.');
    const removed = await this.db.messageAttachment.deleteMany({
      where: { id, uploaderId: actorId, messageId: null },
    });
    if (removed.count !== 1)
      throw errors.conflict('That attachment is on a message now. Delete the message instead.');
    await this.removeFiles([id]);
  }
}
