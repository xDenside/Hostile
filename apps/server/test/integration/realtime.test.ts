import { randomUUID } from 'node:crypto';
import type { ClientToServerEvents, ServerToClientEvents } from '@hostile/shared';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import {
  bearerAuth,
  createChannel,
  createUser,
  loginDesktop,
  loginWeb,
  sendMessage,
  type DesktopSession,
} from '../support/factories.js';
import {
  quietFor,
  resetDatabase,
  startTestApi,
  waitFor,
  type TestApi,
} from '../support/harness.js';

let api: TestApi;
let channelId: string;
let alice: { id: string; session: DesktopSession };
let bob: { id: string; session: DesktopSession };

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
interface Connection {
  socket: AppSocket;
  received: { event: string; payload: unknown }[];
}

const open: AppSocket[] = [];

beforeAll(async () => {
  api = await startTestApi();
  await resetDatabase(api.ctx);
  const [aliceUser, bobUser] = await Promise.all([createUser(api.ctx), createUser(api.ctx)]);
  channelId = (await createChannel(api.ctx, { type: 'TEXT' })).id;
  const [aliceSession, bobSession] = await Promise.all([
    loginDesktop(api, aliceUser),
    loginDesktop(api, bobUser),
  ]);
  alice = { id: aliceUser.id, session: aliceSession };
  bob = { id: bobUser.id, session: bobSession };
});

afterEach(() => {
  for (const socket of open.splice(0)) socket.disconnect();
});

afterAll(async () => {
  await api?.stop();
});

async function connect(options: { token?: string; cookie?: string }): Promise<Connection> {
  const socket: AppSocket = io(api.baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    ...(options.token ? { auth: { token: options.token } } : {}),
    ...(options.cookie ? { extraHeaders: { Cookie: options.cookie } } : {}),
  });
  open.push(socket);
  const received: { event: string; payload: unknown }[] = [];
  socket.onAny((event: string, payload: unknown) => received.push({ event, payload }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return { socket, received };
}

const eventsNamed = (connection: Connection, name: string) =>
  connection.received.filter((e) => e.event === name);

const waitForEvent = (connection: Connection, name: string, timeoutMs = 5_000) =>
  waitFor(`a ${name} event`, () => eventsNamed(connection, name)[0], timeoutMs);

test('a bearer-authenticated socket receives a message posted over HTTP by someone else', async () => {
  const listener = await connect({ token: bob.session.accessToken });
  const sent = await sendMessage(api, alice.session, channelId, 'over the socket');

  const event = await waitForEvent(listener, 'message:created');
  expect(event.payload).toMatchObject({
    id: sent.id,
    channelId,
    authorId: alice.id,
    content: 'over the socket',
  });
});

test('a cookie-authenticated socket connects with the same session model', async () => {
  const web = await loginWeb(api, bob);
  const listener = await connect({ cookie: web.cookie });
  expect(listener.socket.connected).toBe(true);
  const sent = await sendMessage(api, alice.session, channelId, 'cookie listener');
  const event = await waitForEvent(listener, 'message:created');
  expect(event.payload).toMatchObject({ id: sent.id });
});

test('a socket with no credentials is refused', async () => {
  await expect(connect({})).rejects.toMatchObject({ message: 'Not signed in' });
});

test('a socket with a garbage bearer token is refused', async () => {
  await expect(connect({ token: 'hsa1.not-a-real-token.signature' })).rejects.toMatchObject({
    message: 'Access token invalid or expired',
  });
});

test('a socket whose session is revoked is told why and disconnected', async () => {
  const user = await createUser(api.ctx);
  const doomed = await loginDesktop(api, user);
  const survivor = await loginDesktop(api, user);
  const connection = await connect({ token: doomed.accessToken });

  const res = await api.http().post('/api/auth/logout-others').set(bearerAuth(survivor));
  expect(res.status).toBe(200);
  expect(res.body.revoked).toBeGreaterThanOrEqual(1);

  const ended = await waitForEvent(connection, 'session:ended');
  expect(ended.payload).toEqual({ reason: 'revoked' });
  await waitFor('the socket to be disconnected', () => !connection.socket.connected);
});

test('typing is relayed to other users, and malformed payloads are ignored', async () => {
  const typist = await connect({ token: alice.session.accessToken });
  const watcher = await connect({ token: bob.session.accessToken });

  typist.socket.emit('typing:start', {} as unknown as { channelId: string });
  typist.socket.emit('typing:start', { channelId: 'not-a-uuid' });
  typist.socket.emit('typing:start', { channelId, extra: 'field' } as unknown as {
    channelId: string;
  });
  typist.socket.emit('typing:start', { channelId });

  const relayed = await waitForEvent(watcher, 'typing');
  expect(relayed.payload).toEqual({ channelId, userId: alice.id });

  await quietFor(200);
  expect(eventsNamed(watcher, 'typing')).toHaveLength(1);
  expect(eventsNamed(typist, 'typing')).toHaveLength(0);
});

test('typing in a voice channel is relayed, because its chat is the same chat', async () => {
  const voice = await createChannel(api.ctx, { type: 'VOICE' });
  const typist = await connect({ token: alice.session.accessToken });
  const watcher = await connect({ token: bob.session.accessToken });

  typist.socket.emit('typing:start', { channelId: voice.id });

  const relayed = await waitForEvent(watcher, 'typing');
  expect(relayed.payload).toEqual({ channelId: voice.id, userId: alice.id });
});

test('typing for an archived or unknown channel is not relayed', async () => {
  const archivedText = await createChannel(api.ctx, { type: 'TEXT', archived: true });
  const archivedVoice = await createChannel(api.ctx, { type: 'VOICE', archived: true });
  const watcher = await connect({ token: bob.session.accessToken });

  for (const channelId of [archivedText.id, archivedVoice.id, randomUUID()]) {
    const typist = await connect({ token: alice.session.accessToken });
    typist.socket.emit('typing:start', { channelId });
  }
  await quietFor(300);
  expect(eventsNamed(watcher, 'typing')).toHaveLength(0);
});
