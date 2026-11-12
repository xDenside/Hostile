import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { WebSocket as NodeWebSocket } from 'ws';
import {
  encodeJsonFrame,
  FRAME,
  parseRoomCode,
  TUNNEL_MAX_FRAME,
} from '../packages/shared/src/tunnel';
import { startTunnelGateway } from '../apps/server/src/tunnel/gateway';
import { pinNoiseMode, USERS } from './helpers';
import {
  API_URL,
  bridgeFragment,
  GUEST_URL,
  comeBack,
  joinAndAsk,
  joinAndSignIn,
  joinByCode,
  newRoom,
  ROOM_ORIGIN,
  startOwnRoomServer,
  startTunnelHost,
  type TunnelHost,
} from './tunnel-harness';

const { WebSocket } = createRequire(import.meta.url)('ws') as { WebSocket: typeof NodeWebSocket };

const RELAY = `ws://127.0.0.1:${process.env.E2E_RENDEZVOUS_PORT ?? 5292}`;

const openRelay = () =>
  new Promise<NodeWebSocket>((resolve, reject) => {
    const socket = new WebSocket(RELAY);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });

interface RelayEvent {
  topic: string;
  content: string;
  kind: number;
  pubkey: string;
}

async function sniffRelay() {
  const socket = await openRelay();
  const events: RelayEvent[] = [];
  const listening = new Promise<void>((resolve) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as [
        string,
        string,
        { tags: string[][]; content: string; kind: number; pubkey: string },
      ];
      if (message[0] === 'EOSE') resolve();
      if (message[0] === 'EVENT')
        events.push({
          topic: message[2].tags[0]![1]!,
          content: message[2].content,
          kind: message[2].kind,
          pubkey: message[2].pubkey,
        });
    });
  });
  socket.send(JSON.stringify(['REQ', 'all', {}]));
  await listening;
  return { events, close: () => socket.close() };
}

function openedWithCode(events: RelayEvent[], code: string) {
  const key = createHash('sha256')
    .update(`hostile-relay/${parseRoomCode(code)}`)
    .digest();
  const opened: { pubkey: string; text: string; envelope: Record<string, unknown> }[] = [];
  for (const event of events) {
    let text: string;
    try {
      const whole = Buffer.from(event.content, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, whole.subarray(0, 12));
      decipher.setAuthTag(whole.subarray(-16));
      text = Buffer.concat([decipher.update(whole.subarray(12, -16)), decipher.final()]).toString();
    } catch {
      continue;
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(text) as Record<string, unknown>;
    } catch {
      envelope = {};
    }
    opened.push({ pubkey: event.pubkey, text, envelope });
  }
  return opened;
}

async function recordChannels(context: BrowserContext) {
  await context.addInitScript(() => {
    const native = RTCPeerConnection.prototype.createDataChannel;
    const channels: RTCDataChannel[] = [];
    (window as unknown as { __channels: RTCDataChannel[] }).__channels = channels;
    RTCPeerConnection.prototype.createDataChannel = function (label, options) {
      const channel = native.call(this, label, options);
      if (label.startsWith('hostile-')) channels.push(channel);
      return channel;
    };
  });
}

async function recordRemoteFingerprints(context: BrowserContext) {
  await context.addInitScript(() => {
    const native = RTCPeerConnection.prototype.setRemoteDescription as (
      this: RTCPeerConnection,
      description?: RTCSessionDescriptionInit,
    ) => Promise<void>;
    const seen = new Set<string>();
    (window as unknown as { __remoteFingerprints: Set<string> }).__remoteFingerprints = seen;
    RTCPeerConnection.prototype.setRemoteDescription = function (
      this: RTCPeerConnection,
      description?: RTCSessionDescriptionInit,
    ) {
      const found = /a=fingerprint:\S+ (\S+)/i.exec(description?.sdp ?? '');
      if (found) seen.add(found[1]!.toUpperCase());
      return native.call(this, description);
    };
  });
}

const remoteFingerprintsOf = (page: Page) =>
  page.evaluate(() => [
    ...(window as unknown as { __remoteFingerprints: Set<string> }).__remoteFingerprints,
  ]);

function rawExchange(page: Page, frame: Uint8Array) {
  return page.evaluate(
    async (bytes) => {
      const w = window as unknown as { __channels: RTCDataChannel[] };
      const channel = w.__channels.filter((c) => c.label === 'hostile-control').at(-1)!;
      const answers: { type: number; id: number; json: string }[] = [];
      const listener = (e: MessageEvent<ArrayBuffer>) => {
        const b = new Uint8Array(e.data);
        const id = ((b[1]! << 24) | (b[2]! << 16) | (b[3]! << 8) | b[4]!) >>> 0;
        if (b[0] !== 5)
          answers.push({ type: b[0]!, id, json: new TextDecoder().decode(b.subarray(5)) });
      };
      channel.addEventListener('message', listener);
      channel.send(new Uint8Array(bytes));
      await new Promise((r) => setTimeout(r, 1500));
      channel.removeEventListener('message', listener);
      return { answers, state: channel.readyState };
    },
    [...frame],
  );
}

test.describe('tunnel protections', () => {
  test.setTimeout(180_000);
  let host: TunnelHost;
  let canaryHits = 0;
  const canary = createServer((_req, res) => {
    canaryHits++;
    res.end('reached');
  });
  let canaryPort = 0;
  test.beforeAll(async () => {
    await new Promise<void>((resolve) => canary.listen(0, '127.0.0.1', resolve));
    canaryPort = (canary.address() as { port: number }).port;
    host = await startTunnelHost();
  });
  test.afterAll(async () => {
    await host.stop();
    canary.close();
  });

  test('a guest cannot reach another port or host, and an oversized frame is refused', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await recordChannels(context);
    const page = await context.newPage();
    await joinByCode(page, host.code);

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

    const oversized = new Uint8Array(TUNNEL_MAX_FRAME + 1);
    oversized[0] = FRAME.DATA;
    const refused = await rawExchange(page, oversized);
    expect(refused.answers.map((a) => a.json).join()).toContain('frame_too_large');
    expect(refused.state).not.toBe('open');
    await context.close();
  });

  test('a bad code fails with a clear message, and never hangs', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(`http://localhost:${process.env.E2E_GUEST_PORT ?? 5291}/`);
    await page.getByLabel('Room code').fill('not-a-code');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByTestId('join-failed')).toHaveAttribute('data-step', 'code', {
      timeout: 3000,
    });
    await expect(page.getByTestId('join-failed')).toContainText('not a room code');

    const noHost = newRoom().code;
    expect(parseRoomCode(noHost)).not.toBeNull();
    await page.getByLabel('Room code').fill(noHost);
    await page.getByRole('button', { name: /Try again|Connect/ }).click();
    await expect(page.getByTestId('join-failed')).toHaveAttribute('data-step', 'finding-host', {
      timeout: 40_000,
    });
    await expect(page.getByTestId('join-failed')).toContainText('No host answered');
    expect(Date.now() - started).toBeLessThan(45_000);

    await page.routeWebSocket(/:5292/, (ws) => void ws.close());
    await page.reload();
    await page.getByLabel('Room code').fill(newRoom().code);
    await page.getByRole('button', { name: /Try again|Connect/ }).click();
    await expect(page.getByTestId('join-failed')).toHaveAttribute('data-step', 'meeting-point', {
      timeout: 20_000,
    });
    await expect(page.getByLabel('A relay of your own')).toBeVisible();
    await context.close();
  });

  test('a removed member is cut off, and their session opens nothing afterwards', async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    await recordChannels(memberContext);
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    await joinAndSignIn(owner, host.code, USERS.alice);
    const nickname = `Removable ${Date.now().toString().slice(-6)}`;
    await joinAndAsk(member, host.code, nickname);
    const stored = await member.evaluate(() =>
      Object.entries(localStorage)
        .filter(([, value]) => value.includes('_session'))
        .map(([key]) => key),
    );
    expect(stored, 'no session token is kept where page scripts can read it').toEqual([]);
    const guestsBefore = host.gateway.guests();

    const removed = await owner.evaluate(async (nickname) => {
      const session = await (
        await (await import('/src/tunnel/net.ts' as string)).netFetch('/api/auth/session')
      ).json();
      const { netFetch } = await import('/src/tunnel/net.ts' as string);
      const users = await (await netFetch('/api/admin/users')).json();
      const person = users.users.find((u: { displayName: string }) => u.displayName === nickname);
      const res = await netFetch(`/api/admin/users/${person.id}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: '{}',
      });
      return { status: res.status };
    }, nickname);
    expect(removed.status).toBe(200);

    try {
      await expect(member.getByTestId('join-ended')).toContainText('removed', { timeout: 15_000 });
      await expect
        .poll(() => host.gateway.guests(), { timeout: 10_000 })
        .toBeLessThan(guestsBefore);

      await comeBack(member);
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
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("each guest answers to the room's rate limits alone", async ({ browser }) => {
    const server = await startOwnRoomServer({ port: 4293, rateLimits: true });
    const own = await startTunnelHost({ roomUrl: server.url, livekitUrl: null });
    const first = await (await browser.newContext()).newPage();
    const second = await (await browser.newContext()).newPage();
    await joinByCode(first, own.code);
    await joinByCode(second, own.code);
    const tryRefresh = (page: Page, times: number) =>
      page.evaluate(async (times) => {
        const { netFetch } = await import('/src/tunnel/net.ts' as string);
        const statuses: number[] = [];
        for (let i = 0; i < times; i++) {
          const res = await netFetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: 'not-a-token-of-any-kind-here' }),
          });
          statuses.push(res.status);
        }
        return statuses;
      }, times);
    const statuses = await tryRefresh(first, 121);
    expect(statuses.at(-1), 'the first guest has used up its budget').toBe(429);
    expect((await tryRefresh(second, 1))[0], 'the second guest has its own budget').toBe(401);
    await own.stop();
    await server.destroy();
  });
});

async function recordingServer() {
  const seen: { path: string; cookie: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url!, cookie: req.headers.cookie ?? '' });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/public-config')
      return res.end(
        JSON.stringify({
          appName: 'Hostile',
          communityName: 'Your room',
          environment: 'production',
          livekitUrl: null,
          apiVersion: 1,
        }),
      );
    if (req.url?.startsWith('/api/media/page')) {
      res.setHeader('content-type', 'text/html');
      res.setHeader('content-security-policy', "default-src * 'unsafe-inline'");
      return res.end(
        '<!doctype html><title>clean</title><script>document.title="RAN:"+location.origin</script>',
      );
    }
    res.statusCode = req.url === '/api/auth/session' ? 401 : 404;
    res.end(JSON.stringify({ error: { code: 'unauthenticated', message: 'Not signed in.' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => server.close(),
  };
}

test.describe('tunnel protections against other people on the relay', () => {
  test.setTimeout(240_000);

  test("a code holder on the relay cannot read a guest's addresses", async ({ browser }) => {
    const sniffer = await sniffRelay();
    const host = await startTunnelHost();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await joinByCode(page, host.code);
      await page.waitForTimeout(3000);
      const opened = openedWithCode(sniffer.events, host.code);
      const hostKeys = new Set(opened.filter((o) => o.envelope.t === 'h').map((o) => o.pubkey));
      expect(hostKeys.size, 'one host signed what it put on the relay').toBe(1);
      const fromHost = opened.filter((o) => hostKeys.has(o.pubkey));
      const fromGuest = opened.filter((o) => !hostKeys.has(o.pubkey));
      expect(fromHost.map((o) => o.envelope.t)).toEqual(fromHost.map(() => 'h'));
      expect(
        fromHost.some((o) => /"(offer|answer)":/.test(String(o.envelope.b))),
        "the host's half of the exchange was on the relay",
      ).toBe(true);
      expect(
        fromGuest.filter((o) => o.envelope.t === 'g').length,
        "the guest's half went sealed for the host",
      ).toBeGreaterThan(1);
      for (const { envelope, text } of fromGuest) {
        if (envelope.t === 'k') {
          expect(envelope).toEqual({ v: 1, t: 'k' });
          continue;
        }
        expect(Object.keys(envelope).sort(), text.slice(0, 200)).toEqual(['c', 'e', 'i', 't', 'v']);
        expect(envelope.t).toBe('g');
        const sealed = Buffer.from(String(envelope.c), 'base64').toString('latin1');
        for (const words of ['candidate', 'a=fingerprint', 'IN IP4', 'typ host', 'peerId'])
          expect(sealed).not.toContain(words);
      }
    } finally {
      sniffer.close();
      await context.close();
      await host.stop();
    }
  });

  test('a first-time guest never reaches a host the code does not name', async ({ browser }) => {
    const room = newRoom();
    const record = await recordingServer();
    const sniffer = await sniffRelay();
    const fake = await startTunnelHost({
      room: { code: room.code, identity: newRoom().identity },
      roomUrl: record.url,
      livekitUrl: null,
    });
    const context = await browser.newContext();
    let real: TunnelHost | null = null;
    try {
      const page = await context.newPage();
      await pinNoiseMode(page);
      await page.goto(`${GUEST_URL}/`);
      await page.getByLabel('Room code').fill(room.code);
      await page.getByRole('button', { name: 'Connect' }).click();
      await expect(page.getByTestId('join-failed')).toHaveAttribute('data-step', 'finding-host', {
        timeout: 40_000,
      });
      expect(record.seen, 'what reached the host the code does not name').toEqual([]);
      const fromGuest = openedWithCode(sniffer.events, room.code).filter(
        (o) => o.envelope.t !== 'h',
      );
      expect(fromGuest.length).toBeGreaterThan(0);
      expect(
        fromGuest.map((o) => o.envelope),
        'all a first-time guest put on the relay',
      ).toEqual(fromGuest.map(() => ({ v: 1, t: 'k' })));

      await page.getByRole('button', { name: /Try again|Connect/ }).click();
      await expect(page.getByTestId('join-failed')).toHaveCount(0);
      real = await startTunnelHost({ room });
      await expect(page.getByLabel('Nickname')).toBeVisible({ timeout: 45_000 });
      expect(record.seen, 'what reached the host the code does not name').toEqual([]);
    } finally {
      sniffer.close();
      await context.close();
      await fake.stop();
      await real?.stop();
      record.close();
    }
  });

  test('a second host with the same code and key gets neither the guest nor the cookie', async ({
    browser,
  }) => {
    const real = await startTunnelHost();
    const context = await browser.newContext();
    await recordRemoteFingerprints(context);
    const page = await context.newPage();
    await joinAndSignIn(page, real.code, USERS.bob);
    const record = await recordingServer();
    const fake = await startTunnelHost({ room: real.room, roomUrl: record.url, livekitUrl: null });
    try {
      await page.waitForTimeout(15_000);
      expect(record.seen, 'what reached the second host').toEqual([]);
      await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');

      await real.closeBridge();
      await expect.poll(() => real.gateway.guests(), { timeout: 30_000 }).toBe(0);
      await page.waitForTimeout(30_000);
      expect(record.seen, 'what reached the second host').toEqual([]);
      expect(
        await remoteFingerprintsOf(page),
        'certificates the guest saw: the real host and the second one',
      ).toHaveLength(2);

      await real.openBridge();
      await expect.poll(() => real.gateway.guests(), { timeout: 60_000 }).toBe(1);
      await expect(page.getByTestId('connection-state')).toHaveAttribute(
        'data-state',
        'connected',
        { timeout: 45_000 },
      );
      expect(record.seen).toEqual([]);
      const status = await page.evaluate(async () => {
        const { netFetch } = await import('/src/tunnel/net.ts' as string);
        return (await netFetch('/api/auth/session')).status as number;
      });
      expect(status, 'the guest is signed in with the real host').toBe(200);
      await expect
        .poll(() => fake.gateway.guests(), { message: 'links to the second host', timeout: 15_000 })
        .toBe(0);
    } finally {
      await fake.stop();
      await real.stop();
      record.close();
      await context.close();
    }
  });

  test('a page a host sends cannot run on the guest site', async ({ browser }) => {
    const real = await startTunnelHost();
    const record = await recordingServer();
    const evil = await startTunnelHost({ roomUrl: record.url, livekitUrl: null });
    const context = await browser.newContext();
    try {
      const member = await context.newPage();
      await joinAndSignIn(member, real.code, USERS.bob);
      await member.close();
      const lure = await context.newPage();
      await lure.goto(`${GUEST_URL}/#${evil.code}`);
      await expect(lure.getByLabel('Nickname')).toBeVisible({ timeout: 45_000 });
      const opened = await context.newPage();
      await opened.goto(`${GUEST_URL}/api/media/page`);
      expect(await opened.title()).toBe('clean');
      const readable = await opened.evaluate(() => {
        try {
          return Object.keys(localStorage).length;
        } catch {
          return 'refused';
        }
      });
      expect(readable, 'a sandboxed page has no storage of the site').toBe('refused');
    } finally {
      await evil.stop();
      await real.stop();
      record.close();
      await context.close();
    }
  });

  test('a stranger with no code cannot make the host spend anything, or read the relay', async ({
    browser,
  }) => {
    const room = newRoom();
    const code = room.code;
    const secret = randomBytes(32).toString('hex');
    const gateway = await startTunnelGateway({
      roomUrl: API_URL,
      livekitUrl: null,
      origin: ROOM_ORIGIN,
      secret,
      roomTrustProxy: 'loopback',
      roomToken: randomBytes(32).toString('hex'),
    });
    const sniffer = await sniffRelay();
    const events = sniffer.events;
    const hostBrowser = await chromium.launch({
      channel: 'chromium',
      args: [
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--allow-loopback-in-peer-connection',
      ],
    });
    const flooder = await openRelay();
    const context = await browser.newContext();
    try {
      const bridge = await hostBrowser.newPage({ permissions: ['microphone'] });
      await bridge.addInitScript(() => {
        const Native = RTCPeerConnection;
        const count = { made: 0 };
        (window as unknown as { __made: typeof count }).__made = count;
        window.RTCPeerConnection = class extends Native {
          constructor(config?: RTCConfiguration) {
            super(config);
            count.made++;
          }
        };
      });
      await bridge.goto(`${GUEST_URL}/bridge.html#${bridgeFragment(room, gateway.url, secret)}`);
      await expect(bridge.locator('#status')).toHaveAttribute('data-room', 'open', {
        timeout: 30_000,
      });
      const topicOf = (plain: string) =>
        [...createHash('sha1').update(plain).digest()].map((byte) => byte.toString(36)).join('');
      const secretHex = parseRoomCode(code)!;
      const roomId = createHash('sha256').update(`hostile-room/${secretHex}`).digest('hex');
      const rootPlain = `Trystero@hostile-tunnel-1@${roomId.slice(0, 40)}`;
      const topic = topicOf(rootPlain);
      await expect
        .poll(() => events.some((e) => e.topic === topic), { timeout: 20_000 })
        .toBe(true);
      const { kind } = events.find((e) => e.topic === topic)!;
      const forged = Array.from(
        { length: 200 },
        (_, i) => `zzzzzzzzzzzzzzz${String(i).padStart(5, '0')}`,
      );
      const forgedTopics = new Set(forged.map((id) => topicOf(`${rootPlain}@${id}`)));
      const made = () =>
        bridge.evaluate(() => (window as unknown as { __made: { made: number } }).__made.made);
      const before = await made();
      const eventsBefore = events.length;

      for (const peerId of forged) {
        flooder.send(
          JSON.stringify([
            'EVENT',
            {
              kind,
              tags: [['x', topic]],
              created_at: Math.floor(Date.now() / 1000),
              content: JSON.stringify({ peerId }),
              pubkey: randomBytes(32).toString('hex'),
              id: randomBytes(32).toString('hex'),
              sig: randomBytes(64).toString('hex'),
            },
          ]),
        );
      }
      await bridge.waitForTimeout(5000);
      expect((await made()) - before, 'connections the host built for a stranger').toBe(0);
      const answers = events.slice(eventsBefore).filter((e) => forgedTopics.has(e.topic));
      expect(answers, 'what the host published in answer').toEqual([]);

      const page = await context.newPage();
      await joinByCode(page, code);
      expect(gateway.guests()).toBe(1);
      const ours = events.filter((e) => !e.content.includes('zzzzzzz'));
      expect(ours.length).toBeGreaterThan(0);
      for (const event of ours) expect(event.content).toMatch(/^[A-Za-z0-9+/=]+$/);
    } finally {
      sniffer.close();
      flooder.close();
      await context.close();
      await hostBrowser.close();
      await gateway.close();
    }
  });
});
