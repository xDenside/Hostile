import { randomUUID } from 'node:crypto';
import { AVATAR_COLORS } from '@hostile/shared';
import { cliContext } from './common.js';

export const DEV_USERS = [
  { displayName: 'Alice (dev)', role: 'OWNER' as const, color: AVATAR_COLORS[0] },
  { displayName: 'Bob (dev)', role: 'MEMBER' as const, color: AVATAR_COLORS[1] },
];

export const DEV_CHANNELS = [
  { name: 'general', type: 'TEXT' as const, position: 0 },
  { name: 'gaming', type: 'TEXT' as const, position: 1 },
  { name: 'General Voice', type: 'VOICE' as const, position: 2 },
  { name: 'Gaming Voice', type: 'VOICE' as const, position: 3 },
];

async function main() {
  const { config, db, close } = await cliContext();
  if (config.env !== 'development' && config.env !== 'test') {
    console.error(
      '✘ Refusing to seed: development seed data is only allowed when HOSTILE_ENV is development or test.',
    );
    process.exit(1);
  }
  try {
    if (await db.user.count()) {
      console.log('• people already exist; left unchanged');
    } else {
      for (const u of DEV_USERS) {
        await db.user.create({
          data: {
            id: randomUUID(),
            displayName: u.displayName,
            avatarColor: u.color,
            role: u.role,
          },
        });
        console.log(`✔ created ${u.displayName}  (development only)`);
      }
    }
    const channelCount = await db.channel.count({ where: { archivedAt: null } });
    if (channelCount === 0) {
      await db.channel.createMany({ data: DEV_CHANNELS });
      console.log(`✔ created channels: ${DEV_CHANNELS.map((c) => c.name).join(', ')}`);
    } else {
      console.log('• channels already exist; left unchanged');
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
