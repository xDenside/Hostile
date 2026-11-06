import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomSecret, REPO_ROOT } from '../scripts/lib/env.mjs';
import {
  E2E_DATA_DIR,
  E2E_DEVICES_FILE,
  startTestStack,
  TUNNEL_STATE_FILE,
  type TestStack,
} from './stack';

const require = createRequire(import.meta.url);

function resolveBinPath(pkg: string, from: string): string {
  const pkgJsonPath = require.resolve(`${pkg}/package.json`, { paths: [from] });
  const meta = require(pkgJsonPath) as { bin: string | Record<string, string> };
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin[pkg]!;
  return join(pkgJsonPath, '..', rel);
}

declare global {
  var __HOSTILE_STACK__: TestStack | undefined;
}

export default async function globalSetup() {
  const serverDir = join(REPO_ROOT, 'apps', 'server');
  const tsx = resolveBinPath('tsx', serverDir);

  if (!basename(E2E_DATA_DIR).endsWith('_test')) {
    throw new Error(`Refusing to delete ${E2E_DATA_DIR}: its name must end with _test.`);
  }
  rmSync(E2E_DATA_DIR, { recursive: true, force: true });

  execFileSync(process.execPath, [tsx, 'src/cli/seed-dev.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOSTILE_ENV: 'test',
      DATA_DIR: E2E_DATA_DIR,
      PUBLIC_APP_URL: 'http://localhost:5290',
      SESSION_SECRET: randomSecret(32),
    },
    stdio: process.env.E2E_VERBOSE ? 'inherit' : 'ignore',
  });

  execFileSync(process.execPath, [tsx, join(REPO_ROOT, 'e2e', 'seed-devices.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOSTILE_ENV: 'test',
      DATA_DIR: E2E_DATA_DIR,
      PUBLIC_APP_URL: 'http://localhost:5290',
      SESSION_SECRET: randomSecret(32),
      E2E_DEVICES_FILE,
    },
    stdio: process.env.E2E_VERBOSE ? 'inherit' : 'ignore',
  });

  const stack = await startTestStack();
  globalThis.__HOSTILE_STACK__ = stack;
  if (process.env.E2E_TUNNEL_MODE) {
    const { startTunnelHost, GUEST_URL } = await import('./tunnel-harness');
    const host = await startTunnelHost({
      maxGuests: 200,
      maxNewGuestsPerMinute: 1000,
      maxAnonymousGuests: 200,
    });
    mkdirSync(dirname(TUNNEL_STATE_FILE), { recursive: true });
    writeFileSync(
      TUNNEL_STATE_FILE,
      JSON.stringify({
        cookies: [],
        origins: [
          { origin: GUEST_URL, localStorage: [{ name: 'hostile:tunnel:code', value: host.code }] },
        ],
      }),
    );
    const stopStack = stack.stop;
    stack.stop = async () => {
      await host.stop();
      await stopStack();
    };
  }
  process.env.E2E_LIVEKIT_AVAILABLE = stack.livekitAvailable ? '1' : '0';
}
