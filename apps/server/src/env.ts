import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const DEFAULT_DATA_DIR = resolve(REPO_ROOT, '.local', 'data');

export function loadLocalEnv(): string | null {
  const file = process.env.HOSTILE_ENV_FILE ?? resolve(REPO_ROOT, '.env');
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}
