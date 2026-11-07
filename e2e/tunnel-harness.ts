import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import {
  formatRoomCode,
  ROOM_CODE_BYTES,
  ROOM_CODE_SALT_BYTES,
  roomCodeInput,
  type BridgeIdentity,
} from '../packages/shared/src/tunnel';
import { startTunnelGateway, type TunnelGateway } from '../apps/server/src/tunnel/gateway';
import { REPO_ROOT, randomSecret } from '../scripts/lib/env.mjs';
import { waitForHttp } from '../scripts/lib/net.mjs';
import { deviceOf, pinNoiseMode, putOnTunnelDevice, type Person } from './helpers';

export const GUEST_URL = `http://localhost:${process.env.E2E_GUEST_PORT ?? 5291}`;
export const API_URL = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 4290}`;
export const LIVEKIT_URL = `http://127.0.0.1:${process.env.E2E_LIVEKIT_PORT ?? 17990}`;
export const ROOM_ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? 5290}`;

export interface TunnelRoom {
  code: string;
  identity: BridgeIdentity;
}

export function newRoom(): TunnelRoom {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(x!, 'base64url'),
    Buffer.from(y!, 'base64url'),
  ]);
  const salt = randomBytes(ROOM_CODE_SALT_BYTES);
  const hash = createHash('sha256').update(roomCodeInput(raw, salt)).digest();
  return {
    code: formatRoomCode(hash.subarray(0, ROOM_CODE_BYTES)),
    identity: {
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      publicKey: raw.toString('base64url'),
      salt: salt.toString('base64url'),
    },
  };
}

export const bridgeFragment = (room: TunnelRoom, gatewayUrl: string, gatewaySecret: string) =>
  btoa(JSON.stringify({ code: room.code, identity: room.identity, gatewayUrl, gatewaySecret }));

const HOST_ARGS = [
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--allow-loopback-in-peer-connection',
];

export interface TunnelHost {
  code: string;
  room: TunnelRoom;
  gateway: TunnelGateway;
  page: Page;
  browser: Browser;
  closeBridge(): Promise<void>;
  openBridge(): Promise<void>;
  stop(): Promise<void>;
}

export async function startTunnelHost(
  options: {
    room?: TunnelRoom;
    roomUrl?: string;
    livekitUrl?: string | null;
    guestUrl?: string;
    maxGuests?: number;
    maxNewGuestsPerMinute?: number;
    maxAnonymousGuests?: number;
  } = {},
): Promise<TunnelHost> {
  const room = options.room ?? newRoom();
  const secret = randomSecret(32);
  const gateway = await startTunnelGateway({
    roomUrl: options.roomUrl ?? API_URL,
    livekitUrl: options.livekitUrl === undefined ? LIVEKIT_URL : options.livekitUrl,
    origin: ROOM_ORIGIN,
    secret,
    roomTrustProxy: 'loopback',
    roomToken: randomSecret(32),
    ...(options.maxGuests ? { maxGuests: options.maxGuests } : {}),
    ...(options.maxNewGuestsPerMinute
      ? { maxNewGuestsPerMinute: options.maxNewGuestsPerMinute }
      : {}),
    ...(options.maxAnonymousGuests ? { maxAnonymousGuests: options.maxAnonymousGuests } : {}),
  });
  const browser = await chromium.launch({ channel: 'chromium', args: HOST_ARGS });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const host: TunnelHost = {
    code: room.code,
    room,
    gateway,
    browser,
    page: null as unknown as Page,
    async openBridge() {
      host.page = await context.newPage();
      const config = bridgeFragment(room, gateway.url, secret);
      await host.page.goto(`${options.guestUrl ?? GUEST_URL}/bridge.html#${config}`);
      await expect(host.page.locator('#status')).toHaveAttribute('data-room', 'open', {
        timeout: 30_000,
      });
    },
    async closeBridge() {
      await host.page.close();
    },
    async stop() {
      await browser.close().catch(() => undefined);
      await gateway.close();
    },
  };
  await host.openBridge();
  return host;
}

export async function joinByCode(page: Page, code: string, url = GUEST_URL) {
  await pinNoiseMode(page);
  await page.goto(`${url}/`);
  await page.getByLabel('Room code').fill(code);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByLabel('Nickname')).toBeVisible({ timeout: 45_000 });
}

export async function comeBack(page: Page, url = GUEST_URL) {
  await pinNoiseMode(page);
  await page.goto(`${url}/`);
  await expect(page.getByLabel('Nickname')).toBeVisible({ timeout: 30_000 });
}

export async function askHere(page: Page, nickname: string) {
  await page.getByLabel('Nickname').fill(nickname);
  await page.getByRole('button', { name: 'Ask to join' }).click();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
    timeout: 30_000,
  });
}

export async function joinAndAsk(page: Page, code: string, nickname: string) {
  await joinByCode(page, code);
  await askHere(page, nickname);
}

export async function signInHere(page: Page, who: Person) {
  await putOnTunnelDevice(page, deviceOf(who));
  await page.reload();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
    timeout: 30_000,
  });
}

export async function joinAndSignIn(page: Page, code: string, who: Person) {
  await joinByCode(page, code);
  await signInHere(page, who);
}

export function watchForLeaks(page: Page) {
  const leaks: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    const direct =
      url.includes(`:${process.env.E2E_API_PORT ?? 4290}`) ||
      url.includes(`:${process.env.E2E_LIVEKIT_PORT ?? 17990}`) ||
      url.includes(`:${process.env.E2E_WEB_PORT ?? 5290}/`);
    const pathname = new URL(url).pathname;
    const toSite = /^\/(api|socket\.io)\//.test(pathname) && !request.serviceWorker();
    const answeredByWorker =
      request.isNavigationRequest() === false && /^\/api\/(media|attachments)\//.test(pathname);
    if (direct || (toSite && !answeredByWorker)) leaks.push(`${request.method()} ${url}`);
  });
  return leaks;
}

export const OWN_OWNER_SECRET = 'own-room-owner-secret-with-enough-length-for-the-check';

export async function startOwnRoomServer(options: {
  port: number;
  rateLimits?: boolean;
  autoAdmit?: boolean;
}) {
  const require = createRequire(import.meta.url);
  const serverDir = join(REPO_ROOT, 'apps', 'server');
  const tsxJson = require.resolve('tsx/package.json', { paths: [serverDir] });
  const tsx = join(
    tsxJson,
    '..',
    (require(tsxJson) as { bin: string | Record<string, string> }).bin as string,
  );
  const dataDir = join(mkdtempSync(join(tmpdir(), 'hostile-tunnel-')), 'data_test');
  const env = {
    ...process.env,
    HOSTILE_ENV: 'test',
    DATA_DIR: dataDir,
    PUBLIC_APP_URL: ROOM_ORIGIN,
    SESSION_SECRET: randomSecret(32),
    API_HOST: '127.0.0.1',
    API_PORT: String(options.port),
    TRUST_PROXY: 'loopback',
    LIVEKIT_API_KEY: '',
    LIVEKIT_API_SECRET: '',
    LIVEKIT_INTERNAL_URL: '',
    LIVEKIT_PUBLIC_URL: '',
    RATE_LIMIT_DISABLED: options.rateLimits ? 'false' : 'true',
    JOIN_AUTO_ADMIT: options.autoAdmit ? 'true' : 'false',
    OWNER_SECRET: OWN_OWNER_SECRET,
    COMMUNITY_NAME: 'Second Test Room',
    LOG_LEVEL: 'warn',
    LOG_PRETTY: 'false',
  };
  execFileSync(process.execPath, [tsx, 'src/cli/seed-dev.ts'], {
    cwd: serverDir,
    env,
    stdio: 'ignore',
  });
  let child: ChildProcess | null = null;
  const url = `http://127.0.0.1:${options.port}`;
  const server = {
    url,
    async start() {
      child = spawn(process.execPath, [tsx, 'src/main.ts'], {
        cwd: serverDir,
        env,
        stdio: 'ignore',
        detached: true,
      });
      if (!(await waitForHttp(`${url}/api/health`, 45_000, (r) => r.status < 500)))
        throw new Error('The second room server did not start.');
    },
    async kill() {
      const running = child;
      child = null;
      if (!running) return;
      const gone = new Promise((resolve) => running.once('exit', resolve));
      try {
        process.kill(-running.pid!, 'SIGTERM');
      } catch {
        return;
      }
      const forced = setTimeout(() => {
        try {
          process.kill(-running.pid!, 'SIGKILL');
        } catch {}
      }, 6000);
      await gone;
      clearTimeout(forced);
    },
    async destroy() {
      await server.kill();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  await server.start();
  return server;
}
