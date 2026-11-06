import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { BRAND } from '@hostile/shared';
import { log } from './log.js';

export const DEFAULT_PROFILE = 'default';

const PROFILE_PATTERN = /^[a-z0-9_-]{1,32}$/;
const FLAG = '--profile';

export function readProfileArg(argv: readonly string[]): {
  profile: string;
  rejected: string | null;
} {
  let raw: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg.startsWith(`${FLAG}=`)) raw = arg.slice(FLAG.length + 1);
    else if (arg === FLAG) raw = argv[i + 1] ?? '';
  }
  if (raw === null) return { profile: DEFAULT_PROFILE, rejected: null };
  const value = raw.trim().toLowerCase();
  if (!PROFILE_PATTERN.test(value)) return { profile: DEFAULT_PROFILE, rejected: raw };
  return { profile: value, rejected: null };
}

export function applyProfile(profile: string): string {
  app.setName(BRAND.name);
  if (profile !== DEFAULT_PROFILE) {
    const dir = join(app.getPath('userData'), 'profiles', profile);
    mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
    log.info(`profile "${profile}" -> ${dir}`);
  }
  return app.getPath('userData');
}
