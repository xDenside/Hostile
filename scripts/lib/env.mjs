import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ENV_FILE = process.env.HOSTILE_ENV_FILE
  ? resolve(process.env.HOSTILE_ENV_FILE)
  : join(REPO_ROOT, '.env');
export const ENV_EXAMPLE = join(REPO_ROOT, '.env.example');
export const LOCAL_DIR = join(REPO_ROOT, '.local');
export const TOOLS_DIR = join(REPO_ROOT, '.tools');

export const DEFAULTS = {
  WEB_PORT: '5190',
  API_PORT: '4191',
  LIVEKIT_PORT: '17890',
  LIVEKIT_RTC_UDP_PORT: '17892',
};

export function readEnvFile(file = ENV_FILE) {
  if (!existsSync(file)) return null;
  return parseEnv(readFileSync(file, 'utf8'));
}

export function loadRepoEnv() {
  const fromFile = readEnvFile() ?? {};
  const merged = { ...DEFAULTS, ...fromFile };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k in merged) merged[k] = v;
  }
  return merged;
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function randomKeyId(prefix = 'APIdev') {
  return `${prefix}${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
}

export function upsertEnvValues(values, file = ENV_FILE) {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  for (const [key, raw] of Object.entries(values)) {
    const value = /[\s#"']/.test(raw) ? JSON.stringify(raw) : raw;
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, line);
    else text += (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
  }
  writeFileSync(file, text, { mode: 0o600 });
  restrictToOwner(file);
}

export function restrictToOwner(file) {
  if (process.platform === 'win32') return;
  chmodSync(file, 0o600);
}

export function isLoopback(host) {
  const h = String(host)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}
