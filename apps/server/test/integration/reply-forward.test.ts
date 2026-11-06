import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AttachmentDTO,
  ClientToServerEvents,
  MessageDTO,
  ServerToClientEvents,
} from '@hostile/shared';
import { LIMITS } from '@hostile/shared';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { link } from 'node:fs/promises';
import {
  bearerAuth,
  createChannel,
  createUser,
  loginDesktop,
  sendMessage,
  type DesktopSession,
} from '../support/factories.js';
import { resetDatabase, startTestApi, waitFor, type TestApi } from '../support/harness.js';
import { REAL_IMAGES } from '../support/images.js';
import { REAL_LOCATED } from '../support/located-files.js';
import { hasGpsPointer, orientationIn } from '../support/location-builders.js';
import { REAL_VIDEOS } from '../support/videos.js';

let api: TestApi;
let alice: { id: string; session: DesktopSession };
let bob: { id: string; session: DesktopSession };
let owner: { id: string; session: DesktopSession };

const PNG = REAL_IMAGES.png.bytes;
const MP4 = REAL_VIDEOS.mp4.bytes;

beforeAll(async () => {
  api = await startTestApi();
  await resetDatabase(api.ctx);
  const [aliceUser, bobUser, ownerUser] = await Promise.all([
    createUser(api.ctx),
    createUser(api.ctx),
    createUser(api.ctx, { role: 'OWNER' }),
  ]);
  const [aliceSession, bobSession, ownerSession] = await Promise.all([
    loginDesktop(api, aliceUser),
    loginDesktop(api, bobUser),
    loginDesktop(api, ownerUser),
  ]);
  alice = { id: aliceUser.id, session: aliceSession };
  bob = { id: bobUser.id, session: bobSession };
  owner = { id: ownerUser.id, session: ownerSession };
});

afterEach(() => {
  vi.restoreAllMocks();
  api.ctx.attachments.linkFile = link;
});

afterAll(async () => {
  await api?.stop();
});

const newChannel = () => createChannel(api.ctx, { type: 'TEXT' });

const say = (session: DesktopSession, channelId: string, content: string) =>
  sendMessage(api, session, channelId, content) as unknown as Promise<MessageDTO>;

const reply = (
  session: DesktopSession,
  channelId: string,
  replyToId: string,
  body: { content?: string; attachmentIds?: string[]; clientNonce?: string } = {},
) =>
  api
    .http()
    .post(`/api/channels/${channelId}/messages`)
    .set(bearerAuth(session))
    .send({ content: 'an answer', clientNonce: randomUUID(), replyToId, ...body });

const forward = (
  session: DesktopSession,
  messageId: string,
  channelId: string,
  clientNonce: string = randomUUID(),
) =>
  api
    .http()
    .post(`/api/messages/${messageId}/forward`)
    .set(bearerAuth(session))
    .send({ channelId, clientNonce });

const edit = (session: DesktopSession, messageId: string, content: string) =>
  api.http().patch(`/api/messages/${messageId}`).set(bearerAuth(session)).send({ content });

const remove = (session: DesktopSession, messageId: string) =>
  api.http().delete(`/api/messages/${messageId}`).set(bearerAuth(session));

const markRead = (session: DesktopSession, channelId: string, seq: number) =>
  api.http().post(`/api/channels/${channelId}/read`).set(bearerAuth(session)).send({ seq });

const history = async (channelId: string, session: DesktopSession = alice.session) =>
  (await api.http().get(`/api/channels/${channelId}/messages`).set(bearerAuth(session))).body as {
    messages: MessageDTO[];
    syncSeq: number;
  };

const changes = async (channelId: string, since: number) =>
  (
    await api
      .http()
      .get(`/api/channels/${channelId}/changes?since=${since}`)
      .set(bearerAuth(alice.session))
  ).body as { changes: MessageDTO[]; syncSeq: number };

async function upload(
  channelId: string,
  bytes: Buffer = PNG,
  session: DesktopSession = alice.session,
  name = 'photo.png',
): Promise<AttachmentDTO> {
  const res = await fetch(
    `${api.baseUrl}/api/channels/${channelId}/attachments?name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: bearerAuth(session), body: bytes },
  );
  if (res.status !== 201) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { attachment: AttachmentDTO }).attachment;
}

async function withFiles(
  channelId: string,
  files: { bytes?: Buffer; name?: string }[] = [{}],
  content = 'with files',
): Promise<MessageDTO> {
  const attachments = [];
  for (const file of files)
    attachments.push(await upload(channelId, file.bytes, alice.session, file.name));
  const res = await api
    .http()
    .post(`/api/channels/${channelId}/messages`)
    .set(bearerAuth(alice.session))
    .send({ content, clientNonce: randomUUID(), attachmentIds: attachments.map((a) => a.id) });
  expect(res.status).toBe(201);
  return res.body.message as MessageDTO;
}

const hasFile = (id: string) => existsSync(join(api.uploadsDir, id));
const filesOnDisk = () => readdirSync(api.uploadsDir);
const fetchFile = (path: string) => fetch(`${api.baseUrl}${path}`);
const issuePath = (body: { error: { issues?: { path: string }[] } }) =>
  body.error.issues?.[0]?.path;

const open: Socket[] = [];

async function listen(session: DesktopSession) {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(api.baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    auth: { token: session.accessToken },
  });
  open.push(socket);
  const created: MessageDTO[] = [];
  const updated: MessageDTO[] = [];
  const reads: { channelId: string; lastReadSeq: number }[] = [];
  socket.on('message:created', (message) => created.push(message));
  socket.on('message:updated', (message) => updated.push(message));
  socket.on('read:updated', (read) => reads.push(read));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return { created, updated, reads };
}

afterAll(() => {
  for (const socket of open) socket.disconnect();
});

describe('replying', () => {
  test('a reply carries a quote of the original, and an ordinary message carries none', async () => {
    const channel = await newChannel();
    const original = await say(alice.session, channel.id, 'what time?');
    const res = await reply(bob.session, channel.id, original.id, { content: 'nine' });
    expect(res.status).toBe(201);
    const message = res.body.message as MessageDTO;
    expect(message.content).toBe('nine');
    expect(message.replyTo).toEqual({
      id: original.id,
      seq: original.seq,
      changeSeq: original.changeSeq,
      authorId: alice.id,
      excerpt: 'what time?',
      attachmentCount: 0,
      attachmentKind: null,
      deleted: false,
    });
    expect(original.replyTo).toBeNull();
    expect(original.forwardedFrom).toBeNull();
  });

  test('a target in another channel, or one that does not exist, is refused and stores nothing', async () => {
    const [here, there] = await Promise.all([newChannel(), newChannel()]);
    const elsewhere = await say(alice.session, there.id, 'over there');
    for (const replyToId of [elsewhere.id, randomUUID()]) {
      const res = await reply(bob.session, here.id, replyToId);
      expect(res.status, replyToId).toBe(400);
      expect(issuePath(res.body)).toBe('replyToId');
      expect(res.body.error.issues[0].message).toBe(
        'The message you are replying to is not in this channel.',
      );
    }
    expect(await api.ctx.db.message.count({ where: { channelId: here.id } })).toBe(0);
    const fresh = await api.ctx.db.channel.findUniqueOrThrow({ where: { id: here.id } });
    expect(fresh.changeCounter).toBe(0);
  });

  test('a target that is not an id is refused by the schema', async () => {
    const channel = await newChannel();
    const res = await reply(bob.session, channel.id, 'not-an-id');
    expect(res.status).toBe(400);
    expect(issuePath(res.body)).toBe('replyToId');
  });

  test('a soft-deleted target is accepted, and the quote says so', async () => {
    const channel = await newChannel();
    const original = await say(alice.session, channel.id, 'soon gone');
    expect((await remove(alice.session, original.id)).status).toBe(200);
    const res = await reply(bob.session, channel.id, original.id);
    expect(res.status).toBe(201);
    expect(res.body.message.replyTo).toMatchObject({
      id: original.id,
      deleted: true,
      excerpt: '',
      attachmentCount: 0,
    });
  });

  test('the quote is cut on the server', async () => {
    const channel = await newChannel();
    const original = await say(alice.session, channel.id, 'long '.repeat(500));
    const res = await reply(bob.session, channel.id, original.id);
    const { excerpt } = res.body.message.replyTo;
    expect(Array.from(excerpt as string).length).toBeLessThanOrEqual(LIMITS.replyExcerptMax);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  test('a reply to a message with only a picture counts the picture', async () => {
    const channel = await newChannel();
    const original = await withFiles(channel.id, [{}, {}], '');
    const res = await reply(bob.session, channel.id, original.id);
    expect(res.body.message.replyTo).toMatchObject({
      excerpt: '',
      attachmentCount: 2,
      attachmentKind: 'image',
    });
  });

  test('a reply can have files of its own, or nothing else', async () => {
    const channel = await newChannel();
    const original = await say(alice.session, channel.id, 'send me one');
    const file = await upload(channel.id, PNG, bob.session);
    const res = await reply(bob.session, channel.id, original.id, {
      content: '',
      attachmentIds: [file.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.message.replyTo.id).toBe(original.id);
    expect(res.body.message.attachments.map((a: AttachmentDTO) => a.id)).toEqual([file.id]);
  });

  test('a retry with the same nonce returns the same reply', async () => {
    const channel = await newChannel();
    const original = await say(alice.session, channel.id, 'once');
    const clientNonce = randomUUID();
    const first = await reply(bob.session, channel.id, original.id, { clientNonce });
    const second = await reply(bob.session, channel.id, original.id, { clientNonce });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.message.id).toBe(first.body.message.id);
    expect(second.body.message.replyTo.id).toBe(original.id);
  });

  test('the quote is on every path a message reaches a client by', async () => {
    const channel = await newChannel();
    const events = await listen(bob.session);
    const original = await say(alice.session, channel.id, 'on every path');
    const before = (await history(channel.id)).syncSeq;
    const res = await reply(alice.session, channel.id, original.id);
    const sent = res.body.message as MessageDTO;
    const expected = expect.objectContaining({ id: original.id, excerpt: 'on every path' });

    expect(sent.replyTo).toEqual(expected);
    const page = await history(channel.id, bob.session);
    expect(page.messages.find((m) => m.id === sent.id)?.replyTo).toEqual(expected);
    const feed = await changes(channel.id, before);
    expect(feed.changes.find((m) => m.id === sent.id)?.replyTo).toEqual(expected);
    const live = await waitFor('the event', () => events.created.find((m) => m.id === sent.id));
    expect(live?.replyTo).toEqual(expected);

    const edited = await edit(alice.session, sent.id, 'changed my mind');
    expect(edited.body.message.replyTo).toEqual(expected);
    const liveEdit = await waitFor('the edit event', () =>
      events.updated.find((m) => m.id === sent.id),
    );
    expect(liveEdit?.replyTo).toEqual(expected);
  });

  test('the quote reads fresh after the original is edited, and after it is deleted', async () => {
    const channel = await newChannel();
    const original = await say(alice.session, channel.id, 'first words');
    const answer = (await reply(bob.session, channel.id, original.id)).body.message as MessageDTO;
    const quoteOf = async () =>
      (await history(channel.id)).messages.find((m) => m.id === answer.id)?.replyTo;

    expect(await quoteOf()).toMatchObject({ excerpt: 'first words', deleted: false });

    const edited = (await edit(alice.session, original.id, 'second words')).body
      .message as MessageDTO;
    const afterEdit = await quoteOf();
    expect(afterEdit).toMatchObject({ excerpt: 'second words', deleted: false });
    expect(afterEdit?.changeSeq).toBe(edited.changeSeq);

    await remove(alice.session, original.id);
    expect(await quoteOf()).toMatchObject({ excerpt: '', deleted: true, attachmentCount: 0 });
  });

  test('deleting a reply erases what it said about the original', async () => {
    const channel = await newChannel();
    const original = await say(alice.session, channel.id, 'stays');
    const answer = (await reply(bob.session, channel.id, original.id)).body.message as MessageDTO;
    const res = await remove(bob.session, answer.id);
    expect(res.body.message.replyTo).toBeNull();
    const row = await api.ctx.db.message.findUniqueOrThrow({ where: { id: answer.id } });
    expect(row.replyToId).toBeNull();
    expect(await api.ctx.db.message.findUnique({ where: { id: original.id } })).not.toBeNull();
  });

  test('removing the original outright leaves the reply standing, with no quote', async () => {
    const channel = await newChannel();
    const original = await say(alice.session, channel.id, 'really gone');
    const answer = (await reply(bob.session, channel.id, original.id)).body.message as MessageDTO;
    await api.ctx.db.message.delete({ where: { id: original.id } });
    const row = (await history(channel.id)).messages.find((m) => m.id === answer.id);
    expect(row?.content).toBe('an answer');
    expect(row?.replyTo).toBeNull();
  });

  test('deleting a channel full of replies works, the self-relations notwithstanding', async () => {
    const channel = await newChannel();
    const first = await say(alice.session, channel.id, 'first');
    const second = (await reply(bob.session, channel.id, first.id)).body.message as MessageDTO;
    await reply(alice.session, channel.id, second.id);
    await api.ctx.db.channel.delete({ where: { id: channel.id } });
    expect(await api.ctx.db.message.count({ where: { channelId: channel.id } })).toBe(0);
  });

  test('both of the columns a channel delete has to look through are indexed', async () => {
    const rows = await api.ctx.db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'messages'`;
    const defs = rows.map((r) => r.indexdef).join('\n');
    expect(defs).toContain('("replyToId")');
    expect(defs).toContain('("forwardedFromMessageId")');
  });
});

describe('forwarding', () => {
  test('a forward is a copy in the other channel, showing where it came from', async () => {
    const [from, to] = await Promise.all([newChannel(), newChannel()]);
    const original = await say(alice.session, from.id, '**worth** sharing');
    const res = await forward(bob.session, original.id, to.id);
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    const message = res.body.message as MessageDTO;
    expect(message.channelId).toBe(to.id);
    expect(message.id).not.toBe(original.id);
    expect(message.authorId).toBe(bob.id);
    expect(message.content).toBe('**worth** sharing');
    expect(message.forwardedFrom).toEqual({
      messageId: original.id,
      seq: original.seq,
      authorId: alice.id,
      channelId: from.id,
      channelName: from.name,
      createdAt: original.createdAt,
    });
    const source = (await history(from.id)).messages[0]!;
    expect(source.content).toBe('**worth** sharing');
    expect(source.forwardedFrom).toBeNull();
  });

  test('it is on every path a message reaches a client by', async () => {
    const [from, to] = await Promise.all([newChannel(), newChannel()]);
    const events = await listen(bob.session);
    const original = await say(alice.session, from.id, 'on every path');
    const res = await forward(alice.session, original.id, to.id);
    const sent = res.body.message as MessageDTO;
    const expected = expect.objectContaining({ messageId: original.id, channelName: from.name });
    expect(sent.forwardedFrom).toEqual(expected);
    expect((await history(to.id, bob.session)).messages[0]?.forwardedFrom).toEqual(expected);
    expect((await changes(to.id, 0)).changes[0]?.forwardedFrom).toEqual(expected);
    const live = await waitFor('the event', () => events.created.find((m) => m.id === sent.id));
    expect(live?.forwardedFrom).toEqual(expected);
  });

  describe("the forwarder's read state in the target", () => {
    const readSeq = async (userId: string, channelId: string) =>
      (
        await api.ctx.db.readState.findUnique({
          where: { userId_channelId: { userId, channelId } },
        })
      )?.lastReadSeq;

    async function settled(events: { reads: { channelId: string }[] }) {
      const marker = await newChannel();
      const seen = await say(alice.session, marker.id, 'a marker');
      expect((await markRead(bob.session, marker.id, seen.seq)).status).toBe(200);
      await waitFor('the marker', () => events.reads.find((r) => r.channelId === marker.id));
    }

    test('stays where it was with messages from others unseen there, and nothing is announced', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const events = await listen(bob.session);
      const original = await say(alice.session, from.id, 'pass this on');
      const seen = await say(alice.session, to.id, 'seen');
      expect((await markRead(bob.session, to.id, seen.seq)).status).toBe(200);
      await say(alice.session, to.id, 'thirty of these, say');

      const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      expect(await readSeq(bob.id, to.id)).toBe(seen.seq);
      await settled(events);
      expect(events.reads.filter((r) => r.channelId === to.id)).toEqual([
        { channelId: to.id, lastReadSeq: seen.seq },
      ]);

      const words = await say(bob.session, to.id, 'and something of my own');
      expect(await readSeq(bob.id, to.id)).toBe(words.seq);
      expect(words.seq).toBeGreaterThan(sent.seq);
    });

    test('is not created for a channel they have never opened, with others in it', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'pass this on');
      await say(alice.session, to.id, 'before they ever looked');
      const res = await forward(bob.session, original.id, to.id);
      expect(res.status).toBe(201);
      expect(await readSeq(bob.id, to.id)).toBeUndefined();
    });

    test('moves past what is only their own, or deleted', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const events = await listen(bob.session);
      const original = await say(alice.session, from.id, 'pass this on');
      const seen = await say(alice.session, to.id, 'seen');
      expect((await markRead(bob.session, to.id, seen.seq)).status).toBe(200);
      const gone = await say(alice.session, to.id, 'deleted before anyone read it');
      await remove(alice.session, gone.id);
      await say(bob.session, to.id, 'mine');
      await api.ctx.db.readState.update({
        where: { userId_channelId: { userId: bob.id, channelId: to.id } },
        data: { lastReadSeq: seen.seq },
      });

      const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      expect(await readSeq(bob.id, to.id)).toBe(sent.seq);
      await waitFor('the read event', () =>
        events.reads.find((r) => r.channelId === to.id && r.lastReadSeq === sent.seq),
      );
    });
  });

  test("it advances the forwarder's read state in the target and tells their other windows", async () => {
    const [from, to] = await Promise.all([newChannel(), newChannel()]);
    const events = await listen(bob.session);
    const original = await say(alice.session, from.id, 'read this');
    const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
    const state = await api.ctx.db.readState.findUniqueOrThrow({
      where: { userId_channelId: { userId: bob.id, channelId: to.id } },
    });
    expect(state.lastReadSeq).toBe(sent.seq);
    await waitFor('the read event', () =>
      events.reads.find((r) => r.channelId === to.id && r.lastReadSeq === sent.seq),
    );
    const others = await api.ctx.db.readState.count({
      where: { channelId: to.id, userId: alice.id },
    });
    expect(others).toBe(0);
  });

  test('a forward of a forward keeps the first origin, and the channel name it had then', async () => {
    const [a, b, c] = await Promise.all([newChannel(), newChannel(), newChannel()]);
    const original = await say(alice.session, a.id, 'through a chain');
    const first = (await forward(bob.session, original.id, b.id)).body.message as MessageDTO;
    await api.ctx.db.channel.update({ where: { id: a.id }, data: { name: 'renamed' } });
    const second = (await forward(owner.session, first.id, c.id)).body.message as MessageDTO;
    expect(second.authorId).toBe(owner.id);
    expect(second.forwardedFrom).toEqual(first.forwardedFrom);
    expect(second.forwardedFrom).toMatchObject({
      messageId: original.id,
      authorId: alice.id,
      channelId: a.id,
      channelName: a.name,
    });
    const third = (await forward(bob.session, original.id, c.id)).body.message as MessageDTO;
    expect(third.forwardedFrom?.channelName).toBe('renamed');
  });

  test('a forward carries no quote: what it answered is in another channel', async () => {
    const [from, to] = await Promise.all([newChannel(), newChannel()]);
    const original = await say(alice.session, from.id, 'a question');
    const answer = (await reply(bob.session, from.id, original.id)).body.message as MessageDTO;
    const sent = (await forward(alice.session, answer.id, to.id)).body.message as MessageDTO;
    expect(sent.replyTo).toBeNull();
    expect(sent.content).toBe(answer.content);
  });

  test('a message in a voice channel forwards, and a forward can go to one', async () => {
    const [text, voice] = await Promise.all([
      newChannel(),
      createChannel(api.ctx, { type: 'VOICE' }),
    ]);
    const original = await say(alice.session, text.id, 'to the call');
    const there = await forward(alice.session, original.id, voice.id);
    expect(there.status).toBe(201);
    const back = await forward(bob.session, there.body.message.id, text.id);
    expect(back.status).toBe(201);
    expect(back.body.message.forwardedFrom.messageId).toBe(original.id);
  });

  describe('refusals', () => {
    test('an unknown or deleted source is a 404', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'gone');
      await remove(alice.session, original.id);
      for (const id of [original.id, randomUUID()]) {
        const res = await forward(bob.session, id, to.id);
        expect(res.status, id).toBe(404);
        expect(res.body.error.message).toBe('Message not found.');
      }
      expect(await api.ctx.db.message.count({ where: { channelId: to.id } })).toBe(0);
    });

    test('an archived source channel or target channel is a 404, and an unknown target', async () => {
      const [archivedFrom, open_, archivedTo] = await Promise.all([
        newChannel(),
        newChannel(),
        createChannel(api.ctx, { type: 'TEXT', archived: true }),
      ]);
      const stranded = await say(alice.session, archivedFrom.id, 'stranded');
      await api.ctx.db.channel.update({
        where: { id: archivedFrom.id },
        data: { archivedAt: new Date() },
      });
      const fromArchived = await forward(bob.session, stranded.id, open_.id);
      expect(fromArchived.status).toBe(404);
      expect(fromArchived.body.error.message).toBe('Channel not found.');

      const live = await say(alice.session, open_.id, 'live');
      for (const target of [archivedTo.id, randomUUID()]) {
        const res = await forward(bob.session, live.id, target);
        expect(res.status, target).toBe(404);
        expect(res.body.error.message).toBe('Channel not found.');
      }
      expect(await api.ctx.db.message.count({ where: { channelId: open_.id } })).toBe(1);
    });

    test('the channel it is already in is refused', async () => {
      const channel = await newChannel();
      const original = await say(alice.session, channel.id, 'here already');
      const res = await forward(bob.session, original.id, channel.id);
      expect(res.status).toBe(400);
      expect(issuePath(res.body)).toBe('channelId');
      expect(await api.ctx.db.message.count({ where: { channelId: channel.id } })).toBe(1);
    });

    test('a body with anything else in it is refused, and a bad id', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'as it stands');
      const res = await api
        .http()
        .post(`/api/messages/${original.id}/forward`)
        .set(bearerAuth(alice.session))
        .send({ channelId: to.id, clientNonce: randomUUID(), content: 'something else' });
      expect(res.status).toBe(400);
      expect((await forward(alice.session, 'nope', to.id)).status).toBe(400);
    });

    test('it needs a session', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'mine');
      const res = await api
        .http()
        .post(`/api/messages/${original.id}/forward`)
        .send({ channelId: to.id, clientNonce: randomUUID() });
      expect(res.status).toBe(401);
    });
  });

  describe('idempotency', () => {
    test('a retry with the same nonce returns the same forward and copies nothing', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      const nonce = randomUUID();
      const first = await forward(bob.session, original.id, to.id, nonce);
      const on = filesOnDisk().length;
      const second = await forward(bob.session, original.id, to.id, nonce);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.duplicate).toBe(true);
      expect(second.body.message.id).toBe(first.body.message.id);
      expect(second.body.message.attachments).toEqual(first.body.message.attachments);
      expect(filesOnDisk()).toHaveLength(on);
      expect(await api.ctx.db.message.count({ where: { channelId: to.id } })).toBe(1);
    });

    test('a retry gets its forward even if the original has gone since', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'going');
      const nonce = randomUUID();
      const first = await forward(bob.session, original.id, to.id, nonce);
      await remove(alice.session, original.id);
      const second = await forward(bob.session, original.id, to.id, nonce);
      expect(second.status).toBe(200);
      expect(second.body.message.id).toBe(first.body.message.id);
    });

    test('two at once with one nonce make one forward, and the loser leaves no files', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      const before = filesOnDisk().length;
      let linked = 0;
      let bothLinked: () => void = () => {};
      const met = new Promise<void>((resolve) => (bothLinked = resolve));
      api.ctx.attachments.linkFile = async (source, dest) => {
        await link(source, dest);
        if (++linked === 2) bothLinked();
        await met;
      };
      const nonce = randomUUID();
      const [a, b] = await Promise.all([
        forward(bob.session, original.id, to.id, nonce),
        forward(bob.session, original.id, to.id, nonce),
      ]);
      expect(linked).toBe(2);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect([a.body.duplicate, b.body.duplicate].sort()).toEqual([false, true]);
      expect(a.body.message.id).toBe(b.body.message.id);
      expect(await api.ctx.db.message.count({ where: { channelId: to.id } })).toBe(1);
      expect(filesOnDisk()).toHaveLength(before + 1);
      const kept = (a.status === 201 ? a : b).body.message as MessageDTO;
      expect(hasFile(kept.attachments[0]!.id)).toBe(true);
      expect((await fetchFile(kept.attachments[0]!.url)).status).toBe(200);
    });

    test('the same nonce for another channel is refused rather than quietly answered', async () => {
      const [from, to, other] = await Promise.all([newChannel(), newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'one place');
      const nonce = randomUUID();
      await forward(bob.session, original.id, to.id, nonce);
      const res = await forward(bob.session, original.id, other.id, nonce);
      expect(res.status).toBe(409);
    });

    test('a nonce is one space with sends: neither ever makes a second message under it', async () => {
      const [from, to, other] = await Promise.all([newChannel(), newChannel(), newChannel()]);
      const original = await withFiles(from.id, [{}], 'from here');
      const on = filesOnDisk().length;
      const sendWith = (channelId: string, clientNonce: string) =>
        api
          .http()
          .post(`/api/channels/${channelId}/messages`)
          .set(bearerAuth(bob.session))
          .send({ content: 'plain again', clientNonce });

      const sendNonce = randomUUID();
      const plain = await sendMessage(api, bob.session, to.id, 'plain', sendNonce);
      const answered = await forward(bob.session, original.id, to.id, sendNonce);
      expect(answered.status).toBe(200);
      expect(answered.body.duplicate).toBe(true);
      expect(answered.body.message).toMatchObject({
        id: plain.id,
        content: 'plain',
        forwardedFrom: null,
        attachments: [],
      });
      expect(filesOnDisk()).toHaveLength(on);
      expect(await api.ctx.db.message.count({ where: { channelId: to.id } })).toBe(1);

      const forwardNonce = randomUUID();
      const sent = (await forward(bob.session, original.id, to.id, forwardNonce)).body
        .message as MessageDTO;
      expect(sent.forwardedFrom).not.toBeNull();
      const resent = await sendWith(to.id, forwardNonce);
      expect(resent.status).toBe(200);
      expect(resent.body.duplicate).toBe(true);
      expect(resent.body.message.id).toBe(sent.id);
      expect(resent.body.message.content).toBe('from here');
      expect(await api.ctx.db.message.count({ where: { channelId: to.id } })).toBe(2);

      expect((await forward(bob.session, original.id, other.id, sendNonce)).status).toBe(409);
      expect((await sendWith(other.id, forwardNonce)).status).toBe(409);
      expect(await api.ctx.db.message.count({ where: { channelId: other.id } })).toBe(0);
    });
  });

  describe('what can be done with one afterwards', () => {
    test('nobody can edit it, its forwarder included', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'as it stands');
      const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      const res = await edit(bob.session, sent.id, 'tampered');
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('A forwarded message cannot be edited.');
      expect((await edit(owner.session, sent.id, 'tampered')).status).toBe(403);
      expect((await edit(alice.session, sent.id, 'tampered')).status).toBe(403);
      expect((await history(to.id)).messages[0]?.content).toBe('as it stands');
    });

    test('its forwarder or the owner can delete it, and nobody else', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'deletable');
      const byForwarder = (await forward(bob.session, original.id, to.id)).body
        .message as MessageDTO;
      expect((await remove(alice.session, byForwarder.id)).status).toBe(403);
      expect((await remove(bob.session, byForwarder.id)).status).toBe(200);
      const byOwner = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      const gone = await remove(owner.session, byOwner.id);
      expect(gone.status).toBe(200);
      expect(gone.body.message.forwardedFrom).toBeNull();
      const row = await api.ctx.db.message.findUniqueOrThrow({ where: { id: byOwner.id } });
      expect(row.forwardedFromAuthorId).toBeNull();
      expect(row.forwardedFromChannelName).toBeNull();
    });

    test('deleting the original leaves the forward with nothing to jump to', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'outlived');
      await forward(bob.session, original.id, to.id);
      await remove(alice.session, original.id);
      const shown = (await history(to.id)).messages[0]!;
      expect(shown.content).toBe('outlived');
      expect(shown.forwardedFrom).toMatchObject({
        messageId: null,
        seq: null,
        authorId: alice.id,
        channelName: from.name,
      });
    });

    test('removing the original outright leaves the forward standing', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await say(alice.session, from.id, 'really gone');
      await forward(bob.session, original.id, to.id);
      await api.ctx.db.channel.delete({ where: { id: from.id } });
      const shown = (await history(to.id)).messages[0]!;
      expect(shown.content).toBe('really gone');
      expect(shown.forwardedFrom?.messageId).toBeNull();
      expect(shown.forwardedFrom?.channelName).toBe(from.name);
    });
  });

  describe('its files', () => {
    test('are new ids and new names for the same bytes, in the same order', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id, [
        { bytes: PNG, name: 'first.png' },
        { bytes: MP4, name: 'second.mp4' },
      ]);
      const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      expect(sent.attachments.map((a) => a.fileName)).toEqual(['first.png', 'second.mp4']);
      expect(sent.attachments.map((a) => a.kind)).toEqual(['image', 'video']);
      expect(sent.attachments.map((a) => a.contentType)).toEqual(['image/png', 'video/mp4']);
      expect(sent.attachments.map((a) => a.width)).toEqual(
        original.attachments.map((a) => a.width),
      );
      for (const [i, copy] of sent.attachments.entries()) {
        const source = original.attachments[i]!;
        expect(copy.id).not.toBe(source.id);
        expect(copy.url).not.toBe(source.url);
        expect(copy.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
        const [a, b] = await Promise.all([fetchFile(copy.url), fetchFile(source.url)]);
        expect(a.status).toBe(200);
        expect(Buffer.from(await a.arrayBuffer()).equals(Buffer.from(await b.arrayBuffer()))).toBe(
          true,
        );
      }
      const rows = await api.ctx.db.messageAttachment.findMany({
        where: { messageId: sent.id },
        orderBy: { position: 'asc' },
      });
      expect(rows.map((r) => r.position)).toEqual([0, 1]);
      expect(rows.every((r) => r.uploaderId === bob.id && r.channelId === to.id)).toBe(true);
    });

    test('are hard links, so forwarding a large file costs no disk', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      const sourcePath = join(api.uploadsDir, original.attachments[0]!.id);
      const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      const copyPath = join(api.uploadsDir, sent.attachments[0]!.id);
      expect(statSync(sourcePath).ino).toBe(statSync(copyPath).ino);
      expect(statSync(sourcePath).nlink).toBe(2);
    });

    test('a forward of a photo links to a file that has already lost its location', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id, [
        { bytes: REAL_LOCATED.pillowJpeg.bytes, name: 'photo.jpg' },
      ]);
      const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      const copy = sent.attachments[0]!;
      const sourcePath = join(api.uploadsDir, original.attachments[0]!.id);
      const copyPath = join(api.uploadsDir, copy.id);
      expect(statSync(sourcePath).ino).toBe(statSync(copyPath).ino);
      const bytes = readFileSync(copyPath);
      expect(bytes.equals(REAL_LOCATED.pillowJpeg.bytes)).toBe(false);
      expect(bytes.length).toBe(REAL_LOCATED.pillowJpeg.bytes.length);
      expect(hasGpsPointer(bytes)).toBe(false);
      expect(bytes.includes(Buffer.from('Paris'))).toBe(false);
      expect(orientationIn(bytes)).toBe(6);
      expect([copy.width, copy.height]).toEqual([32, 64]);
    });

    test('deleting the original leaves the forward its file', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      const source = original.attachments[0]!;
      const copy = sent.attachments[0]!;

      expect((await remove(alice.session, original.id)).status).toBe(200);
      await waitFor('the original file to go', () => !hasFile(source.id));
      expect((await fetchFile(source.url)).status).toBe(404);
      const served = await fetchFile(copy.url);
      expect(served.status).toBe(200);
      expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    });

    test('deleting the forward leaves the original its file', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      const source = original.attachments[0]!;
      const copy = sent.attachments[0]!;

      expect((await remove(bob.session, sent.id)).status).toBe(200);
      await waitFor('the copy to go', () => !hasFile(copy.id));
      expect((await fetchFile(copy.url)).status).toBe(404);
      const served = await fetchFile(source.url);
      expect(served.status).toBe(200);
      expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    });

    test('a chain of forwards all stand on their own', async () => {
      const [a, b, c] = await Promise.all([newChannel(), newChannel(), newChannel()]);
      const original = await withFiles(a.id);
      const one = (await forward(bob.session, original.id, b.id)).body.message as MessageDTO;
      const two = (await forward(alice.session, one.id, c.id)).body.message as MessageDTO;
      await remove(alice.session, original.id);
      await remove(bob.session, one.id);
      await waitFor('both to go', () => !hasFile(one.attachments[0]!.id));
      const served = await fetchFile(two.attachments[0]!.url);
      expect(served.status).toBe(200);
      expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    });

    test('a source file gone at that moment fails cleanly with a not-found, leaving nothing', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id, [{}, {}]);
      await api.ctx.attachments.removeFiles([original.attachments[1]!.id]);
      const before = filesOnDisk().length;
      const res = await forward(bob.session, original.id, to.id);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Attachment not found.');
      expect(filesOnDisk()).toHaveLength(before);
      expect(await api.ctx.db.message.count({ where: { channelId: to.id } })).toBe(0);
      expect(await api.ctx.db.messageAttachment.count({ where: { channelId: to.id } })).toBe(0);
    });

    test('a failed transaction leaves no links behind and no row', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id, [{}, {}]);
      const before = filesOnDisk().length;
      api.ctx.attachments.linkFile = async (source, dest) => {
        await link(source, dest);
        await api.ctx.db.channel.update({
          where: { id: to.id },
          data: { archivedAt: new Date() },
        });
      };
      const res = await forward(bob.session, original.id, to.id);
      expect(res.status).toBe(404);
      expect(filesOnDisk()).toHaveLength(before);
      expect(await api.ctx.db.messageAttachment.count({ where: { channelId: to.id } })).toBe(0);
      expect(await api.ctx.db.message.count({ where: { channelId: to.id } })).toBe(0);
      expect((await fetchFile(original.attachments[0]!.url)).status).toBe(200);
    });

    test('the original deleted while the files are being made fails the same way', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      api.ctx.attachments.linkFile = async (source, dest) => {
        await link(source, dest);
        await remove(alice.session, original.id);
      };
      const before = filesOnDisk().length;
      const res = await forward(bob.session, original.id, to.id);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Message not found.');
      await waitFor('the files to go', () => filesOnDisk().length === before - 1);
    });

    for (const code of ['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']) {
      test(`falls back to a real copy on ${code}, with no temp file left`, async () => {
        const [from, to] = await Promise.all([newChannel(), newChannel()]);
        const original = await withFiles(from.id);
        api.ctx.attachments.linkFile = async () => {
          throw Object.assign(new Error(code), { code, syscall: 'link' });
        };
        const res = await forward(bob.session, original.id, to.id);
        expect(res.status).toBe(201);
        const copy = (res.body.message as MessageDTO).attachments[0]!;
        const sourcePath = join(api.uploadsDir, original.attachments[0]!.id);
        const copyPath = join(api.uploadsDir, copy.id);
        expect(statSync(copyPath).ino).not.toBe(statSync(sourcePath).ino);
        expect(readFileSync(copyPath).equals(PNG)).toBe(true);
        expect(filesOnDisk().filter((name) => name.endsWith('.part'))).toEqual([]);
        await remove(alice.session, original.id);
        expect((await fetchFile(copy.url)).status).toBe(200);
      });
    }

    test('a real copy respects the disk reserve, as an upload does', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      api.ctx.attachments.linkFile = async () => {
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV', syscall: 'link' });
      };
      vi.spyOn(api.ctx.attachments, 'freeBytes').mockResolvedValue(0);
      const before = filesOnDisk().length;
      const res = await forward(bob.session, original.id, to.id);
      expect(res.status).toBe(507);
      expect(filesOnDisk()).toHaveLength(before);
      expect(await api.ctx.db.message.count({ where: { channelId: to.id } })).toBe(0);
    });

    test('a link needs no room, so a forward still works on a nearly full disk', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      vi.spyOn(api.ctx.attachments, 'freeBytes').mockResolvedValue(0);
      expect((await forward(bob.session, original.id, to.id)).status).toBe(201);
    });

    test('any other failure to link is a plain unavailable, and is not mistaken for a missing file', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      api.ctx.attachments.linkFile = async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES', syscall: 'link' });
      };
      const res = await forward(bob.session, original.id, to.id);
      expect(res.status).toBe(503);
      expect(await api.ctx.db.message.count({ where: { channelId: to.id } })).toBe(0);
    });

    test('an old upload swept nearby takes nothing of a forward with it', async () => {
      const [from, to] = await Promise.all([newChannel(), newChannel()]);
      const original = await withFiles(from.id);
      const sent = (await forward(bob.session, original.id, to.id)).body.message as MessageDTO;
      const [left, right] = await Promise.all([upload(from.id), upload(to.id)]);
      const swept = await api.ctx.attachments.sweep(Date.now() + 10 * 24 * 60 * 60 * 1000);
      expect(swept).toBeGreaterThanOrEqual(2);
      for (const old of [left, right]) {
        expect(hasFile(old.id)).toBe(false);
        expect(await api.ctx.db.messageAttachment.count({ where: { id: old.id } })).toBe(0);
      }
      for (const kept of [sent.attachments[0]!, original.attachments[0]!]) {
        expect(hasFile(kept.id)).toBe(true);
        expect(await api.ctx.db.messageAttachment.count({ where: { id: kept.id } })).toBe(1);
        const served = await fetchFile(kept.url);
        expect(served.status).toBe(200);
        expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
      }
    });
  });
});
