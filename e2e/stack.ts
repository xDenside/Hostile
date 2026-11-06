import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { loadRepoEnv, LOCAL_DIR, REPO_ROOT, randomSecret } from '../scripts/lib/env.mjs';
import { findLivekitBinary, renderDevLivekitConfig } from '../scripts/lib/livekit.mjs';
import { isTcpPortFree, isUdpPortFree, waitForHttp } from '../scripts/lib/net.mjs';
import { startLocalRendezvous } from './local-rendezvous';

export const E2E_OWNER_SECRET = 'e2e-owner-secret-with-enough-length-for-the-check';

export interface TestStack {
  webPort: number;
  apiPort: number;
  livekitPort: number;
  livekitAvailable: boolean;
  stop(): Promise<void>;
}

export const E2E_DATA_DIR = join(LOCAL_DIR, 'e2e', 'data_test');

export const E2E_DEVICES_FILE = join(LOCAL_DIR, 'e2e', 'devices.json');
export const E2E_SESSION_COOKIE = 'hostile_session';
export const E2E_WEB_URL = `http://localhost:${process.env.E2E_WEB_PORT ?? 5290}`;

export const TUNNEL_STATE_FILE = join(LOCAL_DIR, 'e2e', 'tunnel-state.json');

const require = createRequire(import.meta.url);

function resolveBin(pkg: string, from: string): string {
  const pkgJson = require.resolve(`${pkg}/package.json`, { paths: [from] });
  const meta = require(pkgJson) as { bin: string | Record<string, string> };
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin[pkg]!;
  return join(pkgJson, '..', rel);
}

function start(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = (chunk: Buffer) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${chunk}`);
  };
  child.stdout?.on('data', log);
  child.stderr?.on('data', log);
  return child;
}

export async function startTestStack(): Promise<TestStack> {
  const env = loadRepoEnv();
  const webPort = Number(process.env.E2E_WEB_PORT ?? 5290);
  const apiPort = Number(process.env.E2E_API_PORT ?? 4290);
  const livekitPort = Number(process.env.E2E_LIVEKIT_PORT ?? 17990);
  const livekitUdpPort = Number(process.env.E2E_LIVEKIT_UDP_PORT ?? 17992);
  const apiKey = 'APItestkey00';
  const apiSecret = randomSecret(32);
  const processes: ChildProcess[] = [];

  const lk = findLivekitBinary(env);
  let livekitAvailable = false;
  if (lk && !lk.missing) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    const configPath = join(LOCAL_DIR, 'livekit.test.yaml');
    writeFileSync(
      configPath,
      renderDevLivekitConfig(
        {
          ...env,
          LIVEKIT_PORT: String(livekitPort),
          LIVEKIT_RTC_UDP_PORT: String(livekitUdpPort),
          LIVEKIT_API_KEY: apiKey,
          LIVEKIT_API_SECRET: apiSecret,
          LIVEKIT_NODE_IP: '127.0.0.1',
          LIVEKIT_LOG_LEVEL: 'warn',
        },
        { apiPort },
      ),
      { mode: 0o600 },
    );
    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      !((await isTcpPortFree(livekitPort)) && (await isUdpPortFree(livekitUdpPort)))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const livekit = spawnLivekit(lk.path, configPath);
    processes.push(livekit);
    livekitAvailable =
      (await waitForHttp(`http://127.0.0.1:${livekitPort}/`, 20_000)) && livekit.exitCode === null;
    if (!livekitAvailable) {
      console.warn('[e2e] LiveKit did not start; media tests will be skipped.');
    }
  } else {
    console.warn('[e2e] livekit-server not found; media tests will be skipped.');
  }

  const serverDir = join(REPO_ROOT, 'apps', 'server');
  const apiEnv: NodeJS.ProcessEnv = {
    HOSTILE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: String(apiPort),
    PUBLIC_APP_URL: `http://localhost:${webPort}`,
    DATA_DIR: E2E_DATA_DIR,
    SESSION_SECRET: randomSecret(32),
    LIVEKIT_API_KEY: livekitAvailable ? apiKey : '',
    LIVEKIT_API_SECRET: livekitAvailable ? apiSecret : '',
    LIVEKIT_INTERNAL_URL: livekitAvailable ? `http://127.0.0.1:${livekitPort}` : '',
    LIVEKIT_PUBLIC_URL: livekitAvailable ? `ws://localhost:${livekitPort}` : '',
    VOICE_RECONCILE_INTERVAL_SEC: '5',
    LOG_LEVEL: process.env.E2E_VERBOSE ? 'debug' : 'warn',
    LOG_PRETTY: 'false',
    RATE_LIMIT_DISABLED: 'true',
    JOIN_AUTO_ADMIT: 'true',
    OWNER_SECRET: E2E_OWNER_SECRET,
    COMMUNITY_NAME: 'Test Room',
    TRUST_PROXY: 'loopback',
  };
  const apiDeadline = Date.now() + 20_000;
  while (!(await isTcpPortFree(apiPort))) {
    if (Date.now() > apiDeadline) {
      throw new Error(`Port ${apiPort} is still in use, probably by an API from an earlier run.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  processes.push(start('api', [resolveBin('tsx', serverDir), 'src/main.ts'], serverDir, apiEnv));
  if (
    !(await waitForHttp(`http://127.0.0.1:${apiPort}/api/health`, 45_000, (r) => r.status < 500))
  ) {
    throw new Error('API did not start for e2e tests');
  }

  const webDir = join(REPO_ROOT, 'apps', 'web');
  processes.push(
    start('web', [resolveBin('vite', webDir), '--strictPort'], webDir, {
      API_PORT: String(apiPort),
      WEB_PORT: String(webPort),
      VITE_NO_WATCH: '1',
    }),
  );
  if (!(await waitForHttp(`http://localhost:${webPort}/`, 45_000, (r) => r.status < 500))) {
    throw new Error('Web client did not start for e2e tests');
  }

  const rendezvousPort = Number(process.env.E2E_RENDEZVOUS_PORT ?? 5292);
  const guestPort = Number(process.env.E2E_GUEST_PORT ?? 5291);
  const rendezvous = await startLocalRendezvous(rendezvousPort);
  processes.push(
    start('guest-web', [resolveBin('vite', webDir), '--strictPort'], webDir, {
      WEB_PORT: String(guestPort),
      VITE_NO_WATCH: '1',
      HOSTILE_GUEST: '1',
      HOSTILE_TEST_RELAYS: `ws://127.0.0.1:${rendezvousPort}`,
    }),
  );
  if (!(await waitForHttp(`http://localhost:${guestPort}/`, 45_000, (r) => r.status < 500))) {
    throw new Error('Guest site did not start for e2e tests');
  }

  return {
    webPort,
    apiPort,
    livekitPort,
    livekitAvailable,
    async stop() {
      await rendezvous.stop();
      for (const child of processes.reverse()) {
        child.kill('SIGTERM');
      }
      await new Promise((r) => setTimeout(r, 500));
      for (const child of processes) if (!child.killed) child.kill('SIGKILL');
    },
  };
}

function spawnLivekit(bin: string, configPath: string): ChildProcess {
  const child = spawn(bin, ['--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = (chunk: Buffer) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[livekit] ${chunk}`);
  };
  child.stdout?.on('data', log);
  child.stderr?.on('data', log);
  return child;
}
