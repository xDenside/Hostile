import { createServer } from 'node:http';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { encodeJsonFrame, FRAME } from '../packages/shared/src/tunnel';
import {
  GUEST_URL,
  hostApi,
  hostFirstRun,
  joinThroughHost,
  launch,
  newUserDir,
  rawExchange,
  recordChannels,
  removeDir,
  type Instance,
} from './host-harness';

const OWNER = { displayName: 'Room Host' };
const MEMBER = { displayName: 'Cut Off' };

async function connect(page: Page, code: string) {
  await page.goto(GUEST_URL);
  await page.getByLabel('Room code').fill(code);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByLabel('Nickname')).toBeVisible({ timeout: 45_000 });
}

test.describe.serial('protections through the real host in the app', () => {
  test.setTimeout(240_000);
  const hostDir = newUserDir('protect');
  let host: Instance;
  let browser: Browser;
  let code = '';
  let canaryHits = 0;
  const canary = createServer((_req, res) => {
    canaryHits++;
    res.end('reached');
  });
  let canaryPort = 0;

  test.beforeAll(async () => {
    await new Promise<void>((resolve) => canary.listen(0, '127.0.0.1', resolve));
    canaryPort = (canary.address() as { port: number }).port;
    browser = await chromium.launch({ channel: 'chromium' });
    host = await launch(hostDir);
    code = await hostFirstRun(host, OWNER);
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await host?.app.close().catch(() => undefined);
    canary.close();
    removeDir(hostDir);
  });

  test('a guest reaches the room and nothing else on the PC', async () => {
    const context = await browser.newContext();
    await recordChannels(context);
    const page = await context.newPage();
    await connect(page, code);
    const attempts: [string, string, string][] = [
      ['http', 'room', `http://127.0.0.1:${canaryPort}/`],
      ['http', 'room', `//127.0.0.1:${canaryPort}/api/x`],
      ['http', 'room', `\\\\127.0.0.1:${canaryPort}/api/x`],
      ['http', 'room', `/api/../../x`],
      ['http', 'room', `/api/%2e%2e/x`],
      ['http', 'room', `/api/livekit/webhook`],
      ['http', 'room', `/assets/secret`],
      ['http', `http://127.0.0.1:${canaryPort}`, `/api/x`],
      ['http', 'livekit', `/twirp/livekit.RoomService/ListRooms`],
      ['http', 'canary', `/`],
      ['ws', 'room', `/api/health`],
      ['ws', `ws://127.0.0.1:${canaryPort}`, `/socket.io/`],
      ['ws', 'livekit', `/twirp`],
    ];
    let id = 1000;
    for (const [kind, target, path] of attempts) {
      const frame =
        kind === 'http'
          ? encodeJsonFrame(FRAME.OPEN_HTTP, id, {
              target,
              path,
              method: 'POST',
              headers: {},
              hasBody: false,
            })
          : encodeJsonFrame(FRAME.OPEN_WS, id, { target, path, protocols: [], headers: {} });
      const { answers } = await rawExchange(page, frame);
      const answer = answers.find((a) => a.id === id);
      expect(answer?.type, `${kind} ${target} ${path} must be reset`).toBe(FRAME.RESET);
      id++;
    }
    expect(canaryHits, 'requests that reached the other port').toBe(0);
    const spoof = await rawExchange(
      page,
      encodeJsonFrame(FRAME.OPEN_HTTP, id, {
        target: 'room',
        path: '/api/health',
        method: 'GET',
        headers: { host: `127.0.0.1:${canaryPort}`, 'x-forwarded-for': '1.2.3.4' },
        hasBody: false,
      }),
    );
    expect(spoof.answers.find((a) => a.type === FRAME.HEAD)?.json).toContain('"status":200');
    expect(canaryHits).toBe(0);
    await context.close();
  });

  test('a removed member is cut off, and their session opens nothing afterwards', async () => {
    const { page } = host;
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    const context = await browser.newContext();
    await recordChannels(context);
    const member = await context.newPage();
    await member.goto(GUEST_URL);
    await joinThroughHost(page, member, code, MEMBER.displayName);
    const stored = await member.evaluate(() =>
      Object.entries(localStorage)
        .filter(([, value]) => value.includes('_session'))
        .map(([key]) => key),
    );
    expect(stored, 'no session token is kept where page scripts can read it').toEqual([]);

    const row = page.getByTestId('member-row').filter({ hasText: MEMBER.displayName });
    await page.getByRole('button', { name: 'Hosting' }).click();
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: 'Remove' }).click();
    await row.getByRole('button', { name: 'Remove' }).last().click();

    await expect(member.getByTestId('join-ended')).toContainText('removed', { timeout: 20_000 });

    await member.goto(`${GUEST_URL}/`);
    await expect(member.getByLabel('Nickname')).toBeVisible({ timeout: 45_000 });
    await expect(member.getByTestId('connection-state')).toHaveCount(0);

    const replay = await rawExchange(
      member,
      encodeJsonFrame(FRAME.OPEN_HTTP, 5000, {
        target: 'room',
        path: '/api/bootstrap',
        method: 'GET',
        headers: {},
        hasBody: false,
      }),
    );
    expect(replay.answers.find((a) => a.type === FRAME.HEAD)?.json).toMatch(/"status":40[13]/);
    await context.close();
  });

  test('a program on this PC cannot name new addresses to escape the limits', async () => {
    const api = await hostApi(host.page);
    const statuses: number[] = [];
    for (let i = 1; i <= 122; i++) {
      const answer = await fetch(`${api}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: api,
          'x-forwarded-for': `198.51.100.${i}`,
        },
        body: JSON.stringify({ refreshToken: 'not-a-token-of-any-kind-here' }),
      });
      statuses.push(answer.status);
    }
    const limited = statuses.indexOf(429);
    expect(limited).toBeGreaterThan(0);
    expect(statuses.slice(0, limited).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(limited).every((status) => status === 429)).toBe(true);
  });
});
