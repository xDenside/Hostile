import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { decodeCredit, encodeFrame, encodeJsonFrame, FRAME } from '@hostile/shared';
import { GATEWAY_TOKEN_HEADER } from '../../src/http/gateway-address.js';
import { startTunnelGateway, type GatewayOptions } from '../../src/tunnel/gateway.js';

const SECRET = 's'.repeat(32);
const ROOM_TOKEN = 'r'.repeat(43);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Guest {
  socket: WebSocket;
  frames: { type: number; id: number; json: string; body: Buffer }[];
  send(frame: Uint8Array): void;
  ping(): Promise<void>;
  byeReason(): string | null;
}

const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function startUpstream(onSocket?: (socket: WebSocket) => void) {
  const server = http.createServer((_req, res) => res.end('{"ok":true}'));
  const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  sockets.on('connection', (socket) => onSocket?.(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startGateway(roomUrl: string, options: Partial<GatewayOptions> = {}) {
  const gateway = await startTunnelGateway({
    roomUrl,
    livekitUrl: null,
    origin: 'http://localhost',
    roomTrustProxy: 'loopback',
    roomToken: ROOM_TOKEN,
    secret: SECRET,
    ...options,
  });
  closers.push(() => gateway.close());
  return gateway;
}

async function connect(url: string): Promise<Guest> {
  const socket = new WebSocket(url);
  socket.binaryType = 'nodebuffer';
  const frames: Guest['frames'] = [];
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => socket.send(JSON.stringify({ secret: SECRET })));
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return resolve();
      const raw = data as Buffer;
      frames.push({
        type: raw[0]!,
        id: raw.readUInt32BE(1),
        json: raw.subarray(5).toString('utf8'),
        body: raw.subarray(5),
      });
    });
    socket.on('close', () => resolve());
    socket.on('error', reject);
  });
  closers.push(() => socket.terminate());
  const guest: Guest = {
    socket,
    frames,
    send: (frame) => socket.send(frame, { binary: true }),
    async ping() {
      const before = frames.filter((f) => f.type === FRAME.PONG).length;
      guest.send(encodeFrame(FRAME.PING, 0));
      await expect
        .poll(() => frames.filter((f) => f.type === FRAME.PONG).length, { timeout: 15_000 })
        .toBeGreaterThan(before);
    },
    byeReason() {
      const bye = frames.find((f) => f.type === FRAME.BYE);
      return bye ? (JSON.parse(bye.json) as { reason: string }).reason : null;
    },
  };
  return guest;
}

const openWs = (id: number, extra: object = {}) =>
  encodeJsonFrame(FRAME.OPEN_WS, id, {
    target: 'room',
    path: '/socket.io/',
    protocols: [],
    headers: {},
    ...extra,
  });

async function waitForHead(guest: Guest, id: number) {
  await expect
    .poll(() => guest.frames.some((f) => f.type === FRAME.HEAD && f.id === id), { timeout: 5000 })
    .toBe(true);
}

describe('the gateway under frames no honest guest sends', () => {
  const atOpen: [string, Uint8Array][] = [
    ['a subprotocol that is not a token', openWs(1, { protocols: ['bad proto'] })],
    ['the same subprotocol twice', openWs(1, { protocols: ['a', 'a'] })],
    ['a line break in a header', openWs(1, { headers: { 'user-agent': 'a\r\nX-Evil: 1' } })],
  ];
  it.each(atOpen)('survives %s when opening a socket', async (_name, frame) => {
    const gateway = await startGateway(await startUpstream());
    const guest = await connect(gateway.url);
    guest.send(frame);
    await guest.ping();
    expect(guest.frames.find((f) => f.id === 1)?.type).toBe(FRAME.RESET);
    expect(gateway.guests()).toBe(1);
  });

  const atClose: [string, unknown][] = [
    ['a reason that is not a string', { code: 1000, reason: 5 }],
    ['a reason short in characters and long in bytes', { code: 1000, reason: '€'.repeat(100) }],
    ['a code that is a string', { code: '3000' }],
    ['a code that is a fraction', { code: 3000.5, reason: 'x' }],
    ['a body that is not an object', 5],
  ];
  it.each(atClose)('survives %s when closing a socket', async (_name, body) => {
    const gateway = await startGateway(await startUpstream());
    const guest = await connect(gateway.url);
    guest.send(openWs(1));
    await waitForHead(guest, 1);
    guest.send(encodeJsonFrame(FRAME.CLOSE, 1, body));
    await guest.ping();
    expect(gateway.guests()).toBe(1);
  });

  it('still closes with an honest code and reason, within the 123 bytes a close can carry', async () => {
    let closed: { code: number; reason: string } | null = null;
    const gateway = await startGateway(
      await startUpstream((socket) =>
        socket.on('close', (code, reason) => {
          closed = { code, reason: reason.toString('utf8') };
        }),
      ),
    );
    const guest = await connect(gateway.url);
    guest.send(openWs(1));
    await waitForHead(guest, 1);
    guest.send(encodeJsonFrame(FRAME.CLOSE, 1, { code: 3001, reason: '€'.repeat(100) }));
    await expect.poll(() => closed, { timeout: 5000 }).not.toBeNull();
    const { code, reason } = closed!;
    expect(code).toBe(3001);
    expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
    expect(reason).toMatch(/^€+$/);
  });

  it('ends a guest for an empty socket message instead of keeping it for nothing', async () => {
    const gateway = await startGateway(await startUpstream());
    const guest = await connect(gateway.url);
    guest.send(openWs(1));
    await waitForHead(guest, 1);
    guest.send(encodeFrame(FRAME.MESSAGE, 1));
    await expect.poll(() => guest.byeReason(), { timeout: 5000 }).toBe('protocol_error');
    expect(gateway.guests()).toBe(0);
  });

  it('never gives back more credit than it took', async () => {
    const gateway = await startGateway(await startUpstream());
    const guest = await connect(gateway.url);
    guest.send(openWs(1));
    await waitForHead(guest, 1);
    const piece = (last: boolean) => {
      const body = new Uint8Array(10_001);
      body[0] = last ? 1 : 0;
      return encodeFrame(FRAME.MESSAGE, 1, body);
    };
    for (let i = 0; i < 6; i++) guest.send(piece(false));
    guest.send(piece(true));
    const sent = 7 * 10_001;
    await expect
      .poll(() => guest.frames.filter((f) => f.type === FRAME.CREDIT).length, { timeout: 5000 })
      .toBeGreaterThan(0);
    const granted = guest.frames
      .filter((f) => f.type === FRAME.CREDIT)
      .reduce((sum, f) => sum + decodeCredit(f.body), 0);
    expect(granted).toBe(sent);
  });
});

describe('how fast a guest may open streams', () => {
  it('ends a guest that opens streams in a closed loop, and spares the next one', async () => {
    const gateway = await startGateway(await startUpstream());
    const guest = await connect(gateway.url);
    const open = (id: number) =>
      encodeJsonFrame(FRAME.OPEN_HTTP, id, {
        target: 'room',
        path: '/api/health',
        method: 'GET',
        headers: {},
        hasBody: false,
      });
    for (let id = 1; id <= 1000; id++) {
      guest.send(open(id));
      guest.send(encodeFrame(FRAME.RESET, id));
    }
    await expect.poll(() => guest.byeReason(), { timeout: 5000 }).toBe('too_many_streams');

    const next = await connect(gateway.url);
    next.send(open(1));
    await expect
      .poll(() => next.frames.find((f) => f.type === FRAME.HEAD)?.json ?? '', { timeout: 5000 })
      .toContain('"status":200');
    expect(next.byeReason()).toBeNull();
  });

  it('lets a page load its files in one burst', async () => {
    const gateway = await startGateway(await startUpstream());
    const guest = await connect(gateway.url);
    for (let round = 0; round < 3; round++) {
      const base = 1 + round * 100;
      for (let id = base; id < base + 60; id++)
        guest.send(
          encodeJsonFrame(FRAME.OPEN_HTTP, id, {
            target: 'room',
            path: '/api/health',
            method: 'GET',
            headers: {},
            hasBody: false,
          }),
        );
      await expect
        .poll(() => guest.frames.filter((f) => f.type === FRAME.END).length, { timeout: 5000 })
        .toBe(60 * (round + 1));
    }
    expect(guest.byeReason()).toBeNull();
  });
});

describe('guests who have not signed in', () => {
  const signedInRoom = () => startUpstream((socket) => socket.send('40{"sid":"abc"}'));

  it('are not allowed to keep every seat with pings', async () => {
    const gateway = await startGateway(await startUpstream(), {
      maxGuests: 4,
      maxAnonymousGuests: 2,
    });
    const first = await connect(gateway.url);
    const second = await connect(gateway.url);
    expect(gateway.guests()).toBe(2);
    await first.ping();
    await second.ping();
    const third = await connect(gateway.url);
    await third.ping();
    expect(first.byeReason()).toBe('room_full');
    expect(second.byeReason()).toBeNull();
    expect(gateway.guests()).toBe(2);
  });

  it('are cut off at the time limit, with the reason', async () => {
    const gateway = await startGateway(await startUpstream(), { signInLimitMs: 150 });
    const waiting = await connect(gateway.url);
    await expect.poll(() => waiting.byeReason(), { timeout: 5000 }).toBe('sign_in_timeout');
    expect(gateway.guests()).toBe(0);
  });

  it('keep their seat once a socket has been accepted', async () => {
    const gateway = await startGateway(await signedInRoom(), {
      maxGuests: 4,
      maxAnonymousGuests: 1,
      signInLimitMs: 150,
    });
    const member = await connect(gateway.url);
    member.send(openWs(1));
    await waitForHead(member, 1);
    await expect
      .poll(() => member.frames.some((f) => f.type === FRAME.MESSAGE), { timeout: 5000 })
      .toBe(true);
    await sleep(400);
    expect(member.byeReason()).toBeNull();

    const another = await connect(gateway.url);
    const thirdParty = await connect(gateway.url);
    await thirdParty.ping();
    expect(member.byeReason()).toBeNull();
    expect(another.byeReason()).toBe('room_full');
  });

  it('a socket the room refused does not count as signing in', async () => {
    const refusing = await startUpstream((socket) =>
      socket.send('44{"message":"unauthenticated"}'),
    );
    const gateway = await startGateway(refusing, { signInLimitMs: 300 });
    const guest = await connect(gateway.url);
    guest.send(openWs(1));
    await expect.poll(() => guest.byeReason(), { timeout: 5000 }).toBe('sign_in_timeout');
  });

  it('a full room stays full for those who have signed in', async () => {
    const gateway = await startGateway(await signedInRoom(), { maxGuests: 1 });
    const member = await connect(gateway.url);
    member.send(openWs(1));
    await expect
      .poll(() => member.frames.some((f) => f.type === FRAME.MESSAGE), { timeout: 5000 })
      .toBe(true);
    const late = await connect(gateway.url);
    await expect.poll(() => late.byeReason(), { timeout: 5000 }).toBe('room_full');
    expect(member.byeReason()).toBeNull();
  });
});

describe('what the gateway tells the servers behind it', () => {
  it('shows the room its token, and neither a guest nor LiveKit gets near it', async () => {
    const seen: Record<string, http.IncomingHttpHeaders> = {};
    const listen = async (name: string) => {
      const server = http.createServer((req, res) => {
        seen[name] = req.headers;
        res.end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const gateway = await startGateway(await listen('room'), {
      livekitUrl: await listen('livekit'),
    });
    const guest = await connect(gateway.url);
    const open = (id: number, target: string, path: string) =>
      encodeJsonFrame(FRAME.OPEN_HTTP, id, {
        target,
        path,
        method: 'GET',
        headers: { 'x-forwarded-for': '203.0.113.9', [GATEWAY_TOKEN_HEADER]: 'a guess' },
        hasBody: false,
      });
    guest.send(open(1, 'room', '/api/health'));
    guest.send(open(2, 'livekit', '/'));
    await waitForHead(guest, 1);
    await waitForHead(guest, 2);
    expect(seen.room![GATEWAY_TOKEN_HEADER]).toBe(ROOM_TOKEN);
    expect(seen.room!['x-forwarded-for']).toMatch(/^fd68:/);
    expect(seen.livekit![GATEWAY_TOKEN_HEADER]).toBeUndefined();
    expect(seen.livekit!['x-forwarded-for']).toMatch(/^fd68:/);
  });
});

describe('the session cookie stays with the gateway', () => {
  async function room(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    const seen: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers);
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }
  const get = (id: number, path: string, headers: object = {}) =>
    encodeJsonFrame(FRAME.OPEN_HTTP, id, {
      target: 'room',
      path,
      method: 'GET',
      headers,
      hasBody: false,
    });

  it('keeps a Set-Cookie from the guest, sends it on, and ignores a cookie the guest names', async () => {
    const upstream = await room((req, res) => {
      if (req.url === '/api/join/t')
        res.setHeader('Set-Cookie', 'hostile_session=secret; HttpOnly');
      res.end('{}');
    });
    const gateway = await startGateway(upstream.url);
    const guest = await connect(gateway.url);
    guest.send(get(1, '/api/join/t'));
    await waitForHead(guest, 1);
    const head = guest.frames.find((f) => f.id === 1 && f.type === FRAME.HEAD)!;
    expect(head.json).not.toContain('secret');
    expect(head.json.toLowerCase()).not.toContain('set-cookie');
    guest.send(get(3, '/api/auth/session', { cookie: 'hostile_session=stolen' }));
    await waitForHead(guest, 3);
    expect(upstream.seen[1]!.cookie).toBe('hostile_session=secret');
    const other = await connect(gateway.url);
    other.send(get(1, '/api/auth/session'));
    await waitForHead(other, 1);
    expect(upstream.seen[2]!.cookie).toBeUndefined();
  });

  it('refuses a call connection unless the link signed in as the person the call token names', async () => {
    const upstream = await room((req, res) => {
      if (req.url === '/api/join/t') res.setHeader('Set-Cookie', 'hostile_session=secret');
      if (req.url === '/api/auth/session') {
        res.statusCode = req.headers.cookie ? 200 : 401;
        res.end(JSON.stringify({ user: { id: 'u1' } }));
        return;
      }
      res.end('{}');
    });
    let calls = 0;
    const livekit = await startUpstream(() => calls++);
    const gateway = await startGateway(upstream.url, { livekitUrl: livekit });
    const token = (sub: string) =>
      `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.y`;
    const rtc = (id: number, sub: string) =>
      encodeJsonFrame(FRAME.OPEN_WS, id, {
        target: 'livekit',
        path: `/rtc?access_token=${token(sub)}`,
        protocols: [],
        headers: {},
      });
    const guest = await connect(gateway.url);
    guest.send(rtc(1, 'u1'));
    await expect.poll(() => guest.frames.find((f) => f.id === 1)?.type).toBe(FRAME.RESET);
    guest.send(get(3, '/api/join/t'));
    await waitForHead(guest, 3);
    guest.send(rtc(5, 'u2'));
    await expect.poll(() => guest.frames.find((f) => f.id === 5)?.type).toBe(FRAME.RESET);
    expect(calls).toBe(0);
    guest.send(rtc(7, 'u1'));
    await expect.poll(() => calls).toBe(1);
  });
});
