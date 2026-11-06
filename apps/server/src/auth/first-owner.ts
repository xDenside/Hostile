import { randomUUID } from 'node:crypto';
import { displayNameSchema } from '@hostile/shared';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import { checkProfileImage, setProfileImage } from '../media/profile-media.js';
import { defaultAvatarColor } from './service.js';

export class FirstOwnerError extends Error {}

export async function createFirstOwner(
  db: Db,
  log: Logger,
  input: {
    displayName: string;
    avatar?: Uint8Array;
    banner?: Uint8Array;
    withDefaultChannels?: boolean;
  },
) {
  const displayName = displayNameSchema.safeParse(input.displayName);
  if (!displayName.success) throw new FirstOwnerError(displayName.error.issues[0]!.message);
  if (await db.user.findFirst({ where: { role: 'OWNER' }, select: { id: true } }))
    throw new FirstOwnerError('This room already has an owner.');

  const pictures = (['avatar', 'banner'] as const).flatMap((kind) => {
    const bytes = input[kind];
    return bytes ? [{ kind, bytes: Buffer.from(bytes) }] : [];
  });
  for (const { bytes } of pictures) checkProfileImage(bytes);

  const id = randomUUID();
  let owner = await db.user.create({
    data: {
      id,
      displayName: displayName.data,
      avatarColor: defaultAvatarColor(id),
      role: 'OWNER',
    },
  });
  for (const { kind, bytes } of pictures) owner = await setProfileImage(db, log, id, kind, bytes);
  if (input.withDefaultChannels) {
    const count = await db.channel.count({ where: { archivedAt: null } });
    if (count === 0) {
      await db.channel.createMany({
        data: [
          { name: 'general', type: 'TEXT', position: 0 },
          { name: 'General Voice', type: 'VOICE', position: 1 },
        ],
      });
    }
  }
  return owner;
}
