import { basename } from 'node:path';

const TABLES = [
  'message_attachments',
  'messages',
  'read_states',
  'channels',
  'sessions',
  'profile_media',
  'users',
] as const;

export const TRUNCATE_ALL_SQL = `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`;

export function assertTestDataDir(dataDir: string): string {
  const name = basename(dataDir);
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to use data folder "${name}" for tests: the name must end with _test.`,
    );
  }
  return name;
}
