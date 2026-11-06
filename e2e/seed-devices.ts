import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomToken, sha256Hex } from '../apps/server/src/auth/crypto.js';
import { cliContext } from '../apps/server/src/cli/common.js';

async function main() {
  const file = process.env.E2E_DEVICES_FILE;
  if (!file) throw new Error('E2E_DEVICES_FILE says where these go');
  const { config, db, close } = await cliContext();
  if (config.env !== 'test') throw new Error('Refusing to make sessions outside the test server');
  try {
    const devices: Record<string, string> = {};
    for (const user of await db.user.findMany()) {
      const token = randomToken(32);
      await db.session.create({
        data: {
          userId: user.id,
          client: 'WEB',
          tokenHash: sha256Hex(token),
          lastUsedAt: new Date(),
        },
      });
      devices[user.displayName] = token;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(devices));
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
