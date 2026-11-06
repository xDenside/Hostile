import { LIMITS, type ProfileMediaKind } from '@hostile/shared';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import type { User } from '../generated/prisma/client.js';
import { errors, type HttpError } from '../lib/errors.js';
import { sniffImage, type ImageRejection } from '../lib/image-sniff.js';
import { stripLocationFromBuffer } from '../lib/location-strip.js';

export const PROFILE_MEDIA_MAX_BYTES: Record<ProfileMediaKind, number> = {
  avatar: LIMITS.avatarMaxBytes,
  banner: LIMITS.bannerMaxBytes,
};

export function imageTooLarge(kind: ProfileMediaKind) {
  const megabytes = PROFILE_MEDIA_MAX_BYTES[kind] / (1024 * 1024);
  const subject = kind === 'avatar' ? 'An avatar' : 'A banner';
  return errors.payloadTooLarge(
    `That image is too large. ${subject} can be up to ${megabytes} MB.`,
  );
}

const REJECTIONS: Record<ImageRejection, () => HttpError> = {
  unsupported: () => errors.invalidImage(415, 'That file is not a PNG, JPEG, GIF or WebP image.'),
  corrupt: () => errors.invalidImage(400, 'That image is damaged or incomplete. Try another file.'),
  too_many_pixels: () =>
    errors.invalidImage(
      400,
      `That image is too large. It can be at most ${LIMITS.profileImageMaxEdge} pixels on a side.`,
    ),
};

const pointerTo = (kind: ProfileMediaKind, mediaId: string | null) =>
  kind === 'avatar' ? { avatarMediaId: mediaId } : { bannerMediaId: mediaId };

export function checkProfileImage(body: unknown) {
  if (!Buffer.isBuffer(body) || body.length === 0)
    throw errors.invalidImage(400, 'Choose an image to upload.');
  const image = sniffImage(body);
  if (!image.ok) throw REJECTIONS[image.reason]();
  return image;
}

export async function setProfileImage(
  db: Db,
  log: Logger,
  userId: string,
  kind: ProfileMediaKind,
  body: unknown,
): Promise<User> {
  const image = checkProfileImage(body);
  const bytes = body as Buffer<ArrayBuffer>;

  const stripped = stripLocationFromBuffer(bytes, image.type);
  if (stripped.problems.length) {
    log.warn(
      { userId, kind, contentType: image.type, problems: stripped.problems },
      'could not fully check a profile image for location data, and stored it as it is',
    );
  }

  return db.$transaction(async (tx) => {
    const media = await tx.profileMedia.create({
      data: {
        ownerId: userId,
        kind,
        contentType: image.type,
        byteSize: bytes.length,
        width: image.width,
        height: image.height,
        bytes,
      },
      select: { id: true },
    });
    const user = await tx.user.update({
      where: { id: userId },
      data: pointerTo(kind, media.id),
    });
    await tx.profileMedia.deleteMany({
      where: { ownerId: userId, kind, id: { not: media.id } },
    });
    return user;
  });
}

export function clearProfileImage(db: Db, userId: string, kind: ProfileMediaKind): Promise<User> {
  return db.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: pointerTo(kind, null) });
    await tx.profileMedia.deleteMany({ where: { ownerId: userId, kind } });
    return user;
  });
}
