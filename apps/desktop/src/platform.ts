import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import type { DesktopInfo } from '@hostile/shared';

export function unpackagedDockIcon(mainDir: string): string | null {
  const path = join(mainDir, '..', 'build', 'icon-mac.png');
  return existsSync(path) ? path : null;
}

export function systemVersion(): string {
  try {
    return process.getSystemVersion();
  } catch {
    return release();
  }
}

export function atLeastMacOS(major: number, minor = 0): boolean {
  if (process.platform !== 'darwin') return false;
  const parts = systemVersion()
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const actualMajor = parts[0] ?? 0;
  const actualMinor = parts[1] ?? 0;
  if (!Number.isFinite(actualMajor)) return false;
  if (actualMajor !== major) return actualMajor > major;
  return actualMinor >= minor;
}

export function platformName(): DesktopInfo['platform'] {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform;
  return 'linux';
}
