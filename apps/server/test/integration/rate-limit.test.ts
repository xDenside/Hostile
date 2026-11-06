import { randomUUID } from 'node:crypto';
import type { ClientToServerEvents, ServerToClientEvents } from '@hostile/shared';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { bearerAuth, createChannel, createUser, loginDesktop } from '../support/factories.js';
import {
  quietFor,
  resetDatabase,
  startTestApi,
  waitFor,
  type TestApi,
} from '../support/harness.js';

let api: TestApi;
let channelId: string;
let sender: Awaited<ReturnType<typeof loginDesktop>>;

beforeAll(async () => {
  api = await startTestApi({ rateLimit: true, env: { TRUST_PROXY: 'loopback' } });
  await resetDatabase(api.ctx);
  const user = await createUser(api.ctx);
  channelId = (await createChannel(api.ctx, { type: 'TEXT' })).id;
  sender = await loginDesktop(api, user);
});

afterAll(async () => {
  await api?.stop();
});

test('a burst of messages from one account is throttled', async () => {
  const send = () =>
    api
      .http()
      .post(`/api/channels/${channelId}/messages`)
      .set(bearerAuth(sender))
      .send({ content: 'burst', clientNonce: randomUUID() });

  for (let i = 1; i <= 30; i++) {
    expect((await send()).status, `send ${i}`).toBe(201);
  }
  const throttled = await send();
  expect(throttled.status).toBe(429);
  expect(throttled.body.error.code).toBe('rate_limited');
  expect(throttled.body.error.retryAfterSec).toBeLessThanOrEqual(10);

  expect(await api.ctx.db.message.count({ where: { channelId } })).toBe(30);
});

test('forwards and sends share one limit', async () => {
  const user = await createUser(api.ctx);
  const session = await loginDesktop(api, user);
  const other = (await createChannel(api.ctx, { type: 'TEXT' })).id;
  const send = () =>
    api
      .http()
      .post(`/api/channels/${channelId}/messages`)
      .set(bearerAuth(session))
      .send({ content: 'burst', clientNonce: randomUUID() });
  const forward = (messageId: string) =>
    api
      .http()
      .post(`/api/messages/${messageId}/forward`)
      .set(bearerAuth(session))
      .send({ channelId: other, clientNonce: randomUUID() });

  const first = await send();
  expect(first.status).toBe(201);
  for (let i = 2; i <= 30; i++) {
    const res = await (i % 2 ? send() : forward(first.body.message.id));
    expect(res.status, `request ${i}`).toBe(201);
  }
  const throttled = await forward(first.body.message.id);
  expect(throttled.status).toBe(429);
  expect(throttled.body.error.code).toBe('rate_limited');
  expect((await send()).status).toBe(429);
  expect(await api.ctx.db.message.count({ where: { channelId: other } })).toBe(15);
});

test('a flood of voice:self-state events from one socket is dropped past its budget', async () => {
  const flooder = await createUser(api.ctx);
  const session = await loginDesktop(api, flooder);
  const applied = vi.spyOn(api.ctx.voice, 'setSelfState');
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(api.baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    auth: { token: session.accessToken },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    for (let i = 0; i < 60; i++) {
      socket.emit('voice:self-state', {
        channelId,
        muted: i % 2 === 0,
        deafened: false,
        watching: [],
      });
    }
    await waitFor('the budget to be spent', () => applied.mock.calls.length >= 40);
    await quietFor(100);
    expect(applied.mock.calls.length).toBe(40);
    expect(socket.connected).toBe(true);
  } finally {
    socket.disconnect();
    applied.mockRestore();
  }
});

test('profile image uploads are limited per user, counting attempts that were refused', async () => {
  const [busy, bystander] = await Promise.all([createUser(api.ctx), createUser(api.ctx)]);
  const [busySession, bystanderSession] = await Promise.all([
    loginDesktop(api, busy),
    loginDesktop(api, bystander),
  ]);
  const upload = (session: Awaited<ReturnType<typeof loginDesktop>>, body: string) =>
    api
      .http()
      .put('/api/auth/profile/media/avatar')
      .set(bearerAuth(session))
      .set('Content-Type', 'text/plain')
      .send(body);

  for (let i = 1; i <= 30; i++) {
    const res = await upload(busySession, 'not an image');
    expect(res.status, `upload ${i}`).toBe(415);
  }

  const limited = await upload(busySession, 'not an image');
  expect(limited.status).toBe(429);
  expect(limited.body.error.code).toBe('rate_limited');
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

  expect((await upload(bystanderSession, 'not an image')).status).toBe(415);
});
