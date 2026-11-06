import { randomUUID } from 'node:crypto';
import type { ChannelDTO, ClientToServerEvents, ServerToClientEvents } from '@hostile/shared';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  bearerAuth,
  createChannel,
  createUser,
  loginDesktop,
  loginWeb,
  webAuth,
  type DesktopSession,
  type WebSession,
} from '../support/factories.js';
import { resetDatabase, startTestApi, waitFor, type TestApi } from '../support/harness.js';

let api: TestApi;
let owner: DesktopSession;
let ownerBrowser: WebSession;
let member: DesktopSession;
const openSockets: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];

beforeAll(async () => {
  api = await startTestApi();
  await resetDatabase(api.ctx);
  const [ownerUser, memberUser] = await Promise.all([
    createUser(api.ctx, { role: 'OWNER' }),
    createUser(api.ctx),
  ]);
  owner = await loginDesktop(api, ownerUser);
  ownerBrowser = await loginWeb(api, ownerUser);
  member = await loginDesktop(api, memberUser);
});

beforeEach(async () => {
  await api.ctx.db.channel.deleteMany({});
});

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.disconnect();
});

afterAll(async () => {
  await api?.stop();
});

const reorder = (session: DesktopSession, channelIds: unknown) =>
  api.http().put('/api/admin/channels/order').set(bearerAuth(session)).send({ channelIds });

async function storedOrder(): Promise<{ id: string; position: number }[]> {
  const rows = await api.ctx.db.channel.findMany({
    where: { archivedAt: null },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
  });
  return rows.map((c) => ({ id: c.id, position: c.position }));
}

const threeChannels = () =>
  Promise.all([
    createChannel(api.ctx, { name: 'alpha', type: 'TEXT', position: 0 }),
    createChannel(api.ctx, { name: 'bravo', type: 'TEXT', position: 1 }),
    createChannel(api.ctx, { name: 'cello', type: 'VOICE', position: 2 }),
  ]);

test('the owner reorders channels and positions become 0..n-1 in that order', async () => {
  const [alpha, bravo, cello] = await threeChannels();
  const wanted = [cello.id, alpha.id, bravo.id];

  const res = await reorder(owner, wanted);
  expect(res.status).toBe(200);
  expect((res.body.channels as ChannelDTO[]).map((c) => [c.id, c.position])).toEqual([
    [cello.id, 0],
    [alpha.id, 1],
    [bravo.id, 2],
  ]);
  expect(await storedOrder()).toEqual([
    { id: cello.id, position: 0 },
    { id: alpha.id, position: 1 },
    { id: bravo.id, position: 2 },
  ]);

  const again = await reorder(owner, wanted);
  expect(again.status).toBe(200);
  expect((await storedOrder()).map((c) => c.id)).toEqual(wanted);
});

test('equal positions left by an older update are healed', async () => {
  const [tied1, tied2, tied3] = await Promise.all([
    createChannel(api.ctx, { name: 'alpha', type: 'TEXT', position: 4 }),
    createChannel(api.ctx, { name: 'bravo', type: 'TEXT', position: 4 }),
    createChannel(api.ctx, { name: 'cello', type: 'TEXT', position: 4 }),
  ]);

  const res = await reorder(owner, [tied3.id, tied2.id, tied1.id]);
  expect(res.status).toBe(200);
  expect(await storedOrder()).toEqual([
    { id: tied3.id, position: 0 },
    { id: tied2.id, position: 1 },
    { id: tied1.id, position: 2 },
  ]);
});

test('a member cannot reorder channels', async () => {
  const [alpha, bravo, cello] = await threeChannels();
  const before = await storedOrder();

  const res = await reorder(member, [cello.id, bravo.id, alpha.id]);
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('forbidden');
  expect(await storedOrder()).toEqual(before);
});

test('a list that does not cover exactly the live channels is rejected and changes nothing', async () => {
  const [alpha, bravo, cello] = await threeChannels();
  const archived = await createChannel(api.ctx, {
    name: 'dormant',
    type: 'TEXT',
    position: 3,
    archived: true,
  });
  const before = await storedOrder();

  const cases: { what: string; channelIds: unknown; status: number; code: string }[] = [
    { what: 'incomplete', channelIds: [cello.id, alpha.id], status: 409, code: 'conflict' },
    {
      what: 'an unknown id',
      channelIds: [cello.id, alpha.id, randomUUID()],
      status: 409,
      code: 'conflict',
    },
    {
      what: 'an archived channel',
      channelIds: [cello.id, alpha.id, bravo.id, archived.id],
      status: 409,
      code: 'conflict',
    },
    {
      what: 'a duplicate',
      channelIds: [cello.id, alpha.id, alpha.id],
      status: 400,
      code: 'validation_error',
    },
    { what: 'empty', channelIds: [], status: 400, code: 'validation_error' },
    { what: 'not a list', channelIds: cello.id, status: 400, code: 'validation_error' },
  ];

  for (const { what, channelIds, status, code } of cases) {
    const res = await reorder(owner, channelIds);
    expect(res.status, `${what}: ${res.text}`).toBe(status);
    expect(res.body.error.code, what).toBe(code);
    expect(await storedOrder(), what).toEqual(before);
  }
});

test('a browser reorder still needs its CSRF token', async () => {
  const [alpha, bravo, cello] = await threeChannels();
  const before = await storedOrder();
  const wanted = [bravo.id, cello.id, alpha.id];

  const without = await api
    .http()
    .put('/api/admin/channels/order')
    .set('Cookie', ownerBrowser.cookie)
    .send({ channelIds: wanted });
  expect(without.status).toBe(403);
  expect(without.body.error.code).toBe('csrf_failed');
  expect(await storedOrder()).toEqual(before);

  const withToken = await api
    .http()
    .put('/api/admin/channels/order')
    .set(webAuth(ownerBrowser))
    .send({ channelIds: wanted });
  expect(withToken.status).toBe(200);
  expect((await storedOrder()).map((c) => c.id)).toEqual(wanted);
});

test('every client is told about the new order over the socket', async () => {
  const [alpha, bravo, cello] = await threeChannels();
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(api.baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    auth: { token: member.accessToken },
  });
  openSockets.push(socket);
  const upserts: ChannelDTO[] = [];
  socket.on('channel:upserted', (channel) => upserts.push(channel));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  expect((await reorder(owner, [bravo.id, cello.id, alpha.id])).status).toBe(200);

  await waitFor('channel:upserted for every channel', () => upserts.length === 3);
  expect(upserts.map((c) => [c.id, c.position])).toEqual([
    [bravo.id, 0],
    [cello.id, 1],
    [alpha.id, 2],
  ]);
});

test('reorders that arrive together are serialized instead of deadlocking', async () => {
  const [alpha, bravo, cello] = await threeChannels();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      reorder(owner, i % 2 ? [alpha.id, bravo.id, cello.id] : [cello.id, bravo.id, alpha.id]),
    ),
  );
  expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
  expect((await storedOrder()).map((c) => c.position)).toEqual([0, 1, 2]);
});

describe('archived channels', () => {
  const archive = (id: string) =>
    api.http().delete(`/api/admin/channels/${id}`).set(bearerAuth(owner));
  const archivedList = (session: DesktopSession) =>
    api.http().get('/api/admin/channels/archived').set(bearerAuth(session));
  const restore = (session: DesktopSession, id: string) =>
    api.http().post(`/api/admin/channels/${id}/restore`).set(bearerAuth(session)).send({});

  test('restoring brings a channel back last, and the order covers it again', async () => {
    const [alpha, bravo, cello] = await threeChannels();
    expect((await archive(alpha.id)).status).toBe(204);

    const list = await archivedList(owner);
    expect(list.status).toBe(200);
    expect(list.body.channels.map((c: { id: string }) => c.id)).toEqual([alpha.id]);
    expect(typeof list.body.channels[0].archivedAt).toBe('string');
    expect((await storedOrder()).map((c) => c.id)).toEqual([bravo.id, cello.id]);

    const res = await restore(owner, alpha.id);
    expect(res.status).toBe(200);
    expect(res.body.channel.id).toBe(alpha.id);
    expect((await storedOrder()).map((c) => c.id)).toEqual([bravo.id, cello.id, alpha.id]);
    expect((await archivedList(owner)).body.channels).toEqual([]);

    expect((await reorder(owner, [alpha.id, bravo.id, cello.id])).status).toBe(200);
  });

  test('every client is told it is back', async () => {
    const [alpha] = await threeChannels();
    await archive(alpha.id);
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(api.baseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      auth: { token: member.accessToken },
    });
    openSockets.push(socket);
    const upserts: ChannelDTO[] = [];
    socket.on('channel:upserted', (channel) => upserts.push(channel));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    await restore(owner, alpha.id);
    await waitFor('channel:upserted', () => upserts.some((c) => c.id === alpha.id));
  });

  test('only the owner can see or restore them', async () => {
    const [alpha] = await threeChannels();
    await archive(alpha.id);
    expect((await archivedList(member)).status).toBe(403);
    expect((await restore(member, alpha.id)).status).toBe(403);
    expect((await archivedList(owner)).body.channels).toHaveLength(1);
  });

  test('a channel that is live, or that never was, cannot be restored', async () => {
    const [alpha] = await threeChannels();
    expect((await restore(owner, alpha.id)).status).toBe(404);
    expect((await restore(owner, randomUUID())).status).toBe(404);
    expect((await storedOrder()).find((c) => c.id === alpha.id)?.position).toBe(0);
  });
});
