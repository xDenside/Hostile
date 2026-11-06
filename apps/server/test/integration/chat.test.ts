import { randomUUID } from 'node:crypto';
import { LIMITS } from '@hostile/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { MessageDTO } from '@hostile/shared';
import {
  bearerAuth,
  createChannel,
  createUser,
  loginDesktop,
  sendMessage,
  type DesktopSession,
} from '../support/factories.js';
import { resetDatabase, startTestApi, type TestApi } from '../support/harness.js';

let api: TestApi;
let owner: { id: string; session: DesktopSession };
let author: { id: string; session: DesktopSession };
let other: { id: string; session: DesktopSession };

beforeAll(async () => {
  api = await startTestApi({ livekit: true });
  await resetDatabase(api.ctx);
  const [ownerUser, authorUser, otherUser] = await Promise.all([
    createUser(api.ctx, { role: 'OWNER' }),
    createUser(api.ctx),
    createUser(api.ctx),
  ]);
  const [ownerSession, authorSession, otherSession] = await Promise.all([
    loginDesktop(api, ownerUser),
    loginDesktop(api, authorUser),
    loginDesktop(api, otherUser),
  ]);
  owner = { id: ownerUser.id, session: ownerSession };
  author = { id: authorUser.id, session: authorSession };
  other = { id: otherUser.id, session: otherSession };
});

afterAll(async () => {
  await api?.stop();
});

const textChannel = () => createChannel(api.ctx, { type: 'TEXT' });

const history = (channelId: string, session: DesktopSession, query = '') =>
  api.http().get(`/api/channels/${channelId}/messages${query}`).set(bearerAuth(session));

const changes = (channelId: string, since: number, session: DesktopSession) =>
  api.http().get(`/api/channels/${channelId}/changes?since=${since}`).set(bearerAuth(session));

describe('message ownership', () => {
  test('only the author may edit, and the owner may delete anyone', async () => {
    const channel = await textChannel();
    const message = await sendMessage(api, author.session, channel.id, 'original text');

    const byStranger = await api
      .http()
      .patch(`/api/messages/${message.id}`)
      .set(bearerAuth(other.session))
      .send({ content: 'hijacked' });
    expect(byStranger.status).toBe(403);
    expect(byStranger.body.error.code).toBe('forbidden');

    const byOwner = await api
      .http()
      .patch(`/api/messages/${message.id}`)
      .set(bearerAuth(owner.session))
      .send({ content: 'owner rewrite' });
    expect(byOwner.status).toBe(403);

    const byAuthor = await api
      .http()
      .patch(`/api/messages/${message.id}`)
      .set(bearerAuth(author.session))
      .send({ content: 'edited text' });
    expect(byAuthor.status).toBe(200);
    expect(byAuthor.body.message.content).toBe('edited text');
    expect(byAuthor.body.message.editedAt).not.toBeNull();

    const deleteByStranger = await api
      .http()
      .delete(`/api/messages/${message.id}`)
      .set(bearerAuth(other.session));
    expect(deleteByStranger.status).toBe(403);

    const deleteByOwner = await api
      .http()
      .delete(`/api/messages/${message.id}`)
      .set(bearerAuth(owner.session));
    expect(deleteByOwner.status).toBe(200);
    expect(deleteByOwner.body.message.deleted).toBe(true);
    expect(deleteByOwner.body.message.content).toBe('');

    const row = await api.ctx.db.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.content).toBe('');
    expect(row.deletedAt).not.toBeNull();

    const again = await api
      .http()
      .delete(`/api/messages/${message.id}`)
      .set(bearerAuth(owner.session));
    expect(again.status).toBe(404);
  });

  test('an author may delete their own message', async () => {
    const channel = await textChannel();
    const message = await sendMessage(api, author.session, channel.id, 'mine to remove');
    const res = await api
      .http()
      .delete(`/api/messages/${message.id}`)
      .set(bearerAuth(author.session));
    expect(res.status).toBe(200);
    expect(res.body.message.deleted).toBe(true);
  });
});

describe('sending', () => {
  test('resending the same clientNonce returns the original message and stores one row', async () => {
    const channel = await textChannel();
    const clientNonce = randomUUID();
    const body = { content: 'sent once', clientNonce };

    const first = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(bearerAuth(author.session))
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);

    const retry = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(bearerAuth(author.session))
      .send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.message.id).toBe(first.body.message.id);
    expect(retry.body.message.seq).toBe(first.body.message.seq);

    expect(await api.ctx.db.message.count({ where: { channelId: channel.id } })).toBe(1);
    const channelRow = await api.ctx.db.channel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(channelRow.changeCounter).toBe(1);
  });

  test('concurrent sends get strictly increasing, gap-free seq and changeSeq', async () => {
    const channel = await textChannel();
    const count = 6;
    const senders = [author.session, other.session, owner.session];

    const responses = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        api
          .http()
          .post(`/api/channels/${channel.id}/messages`)
          .set(bearerAuth(senders[i % senders.length]!))
          .send({ content: `concurrent ${i}`, clientNonce: randomUUID() }),
      ),
    );
    for (const res of responses) expect(res.status).toBe(201);

    const messages = (responses.map((r) => r.body.message) as MessageDTO[]).sort(
      (a, b) => a.seq - b.seq,
    );
    expect(messages.map((m) => m.seq)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(messages.map((m) => m.changeSeq)).toEqual(messages.map((m) => m.seq));

    const channelRow = await api.ctx.db.channel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(channelRow.changeCounter).toBe(count);
    expect(channelRow.lastMessageSeq).toBe(count);
  });

  test('an over-long message is rejected', async () => {
    const channel = await textChannel();
    const res = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(bearerAuth(author.session))
      .send({ content: 'x'.repeat(LIMITS.messageMax + 1), clientNonce: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(await api.ctx.db.message.count({ where: { channelId: channel.id } })).toBe(0);
  });

  test('a body over the JSON limit is rejected before it is parsed', async () => {
    const channel = await textChannel();
    const res = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(bearerAuth(author.session))
      .send({ content: 'x'.repeat(LIMITS.jsonBodyBytes * 2), clientNonce: randomUUID() });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  test('an empty or whitespace-only message is rejected', async () => {
    const channel = await textChannel();
    const res = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(bearerAuth(author.session))
      .send({ content: '   \n  ', clientNonce: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('history pagination', () => {
  test('before + limit walks the whole history in order and reports hasOlder', async () => {
    const channel = await textChannel();
    const total = 25;
    const pageSize = 10;
    for (let i = 1; i <= total; i++)
      await sendMessage(api, author.session, channel.id, `message ${i}`);

    const pages: MessageDTO[][] = [];
    let before: number | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const query = `?limit=${pageSize}${before === undefined ? '' : `&before=${before}`}`;
      const res = await history(channel.id, author.session, query);
      expect(res.status).toBe(200);
      const page = res.body.messages as MessageDTO[];
      pages.push(page);
      expect(page.map((m) => m.seq)).toEqual([...page.map((m) => m.seq)].sort((a, b) => a - b));
      expect(res.body.syncSeq).toBe(total);
      if (!res.body.hasOlder) break;
      expect(page).toHaveLength(pageSize);
      before = page[0]!.seq;
    }

    expect(pages.map((p) => p.length)).toEqual([pageSize, pageSize, total - 2 * pageSize]);
    const walked = pages
      .flat()
      .map((m) => m.seq)
      .sort((a, b) => a - b);
    expect(walked).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  test('the page limit is bounded', async () => {
    const channel = await textChannel();
    expect(
      (await history(channel.id, author.session, `?limit=${LIMITS.historyPageMax}`)).status,
    ).toBe(200);
    const tooLarge = await history(
      channel.id,
      author.session,
      `?limit=${LIMITS.historyPageMax + 1}`,
    );
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error.code).toBe('validation_error');
    expect((await history(channel.id, author.session, '?limit=0')).status).toBe(400);
  });

  test('an empty channel returns an empty page', async () => {
    const channel = await textChannel();
    const res = await history(channel.id, author.session);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ messages: [], hasOlder: false, syncSeq: 0 });
  });

  test('deleted messages are left out of history but stay in the change feed', async () => {
    const channel = await textChannel();
    const keep = await sendMessage(api, author.session, channel.id, 'stays');
    const gone = await sendMessage(api, author.session, channel.id, 'removed');
    await api.http().delete(`/api/messages/${gone.id}`).set(bearerAuth(author.session)).expect(200);

    const page = await history(channel.id, author.session);
    expect((page.body.messages as MessageDTO[]).map((m) => m.id)).toEqual([keep.id]);

    const feed = await changes(channel.id, 2, author.session);
    expect((feed.body.changes as MessageDTO[]).map((m) => m.id)).toEqual([gone.id]);
  });
});

describe('reconnect reconciliation', () => {
  test('changes since a sync point returns exactly what changed, tombstones included', async () => {
    const channel = await textChannel();
    const first = await sendMessage(api, author.session, channel.id, 'first');
    const second = await sendMessage(api, author.session, channel.id, 'second');
    await sendMessage(api, author.session, channel.id, 'third');

    const atReconnect = (await history(channel.id, author.session)).body.syncSeq as number;
    expect(atReconnect).toBe(3);

    await api
      .http()
      .patch(`/api/messages/${first.id}`)
      .set(bearerAuth(author.session))
      .send({ content: 'first, edited' })
      .expect(200);
    await api
      .http()
      .delete(`/api/messages/${second.id}`)
      .set(bearerAuth(author.session))
      .expect(200);

    const res = await changes(channel.id, atReconnect, author.session);
    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(false);
    expect(res.body.syncSeq).toBe(5);

    const changed = res.body.changes as MessageDTO[];
    expect(changed.map((m) => m.changeSeq)).toEqual([4, 5]);
    expect(changed[0]).toMatchObject({ id: first.id, content: 'first, edited', deleted: false });
    expect(changed[0]!.editedAt).not.toBeNull();
    expect(changed[1]).toMatchObject({ id: second.id, content: '', deleted: true });

    const followUp = await changes(channel.id, res.body.syncSeq as number, author.session);
    expect(followUp.body.changes).toEqual([]);
    expect(followUp.body.reset).toBe(false);
  });

  test('a client that is ahead of the server is told to reset', async () => {
    const channel = await textChannel();
    await sendMessage(api, author.session, channel.id, 'only message');
    const res = await changes(channel.id, 99, author.session);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changes: [], syncSeq: 1, reset: true });
  });

  test('a since far in the past with too many changes returns reset', async () => {
    const channel = await textChannel();
    const count = LIMITS.changesPageMax + 1;
    await api.ctx.db.$executeRaw`
      INSERT INTO "messages" ("id", "channelId", "authorId", "content", "seq", "changeSeq", "clientNonce", "createdAt")
      SELECT gen_random_uuid(), ${channel.id}::uuid, ${author.id}::uuid, 'bulk ' || g, g, g, gen_random_uuid(), now()
      FROM generate_series(1, ${count}::int) AS g`;
    await api.ctx.db.channel.update({
      where: { id: channel.id },
      data: { changeCounter: count, lastMessageSeq: count },
    });

    const everything = await changes(channel.id, 0, author.session);
    expect(everything.body).toMatchObject({ changes: [], syncSeq: count, reset: true });

    const atTheCap = await changes(channel.id, 1, author.session);
    expect(atTheCap.body.reset).toBe(false);
    expect(atTheCap.body.changes).toHaveLength(LIMITS.changesPageMax);
  });
});

describe('read state', () => {
  test('marking read never moves backwards and is clamped to the newest message', async () => {
    const channel = await textChannel();
    for (let i = 1; i <= 3; i++) await sendMessage(api, author.session, channel.id, `message ${i}`);
    const markRead = (seq: number) =>
      api
        .http()
        .post(`/api/channels/${channel.id}/read`)
        .set(bearerAuth(other.session))
        .send({ seq });

    expect((await markRead(2)).body).toEqual({ channelId: channel.id, lastReadSeq: 2 });
    expect((await markRead(1)).body.lastReadSeq).toBe(2);
    expect((await markRead(9999)).body.lastReadSeq).toBe(3);

    const stored = await api.ctx.db.readState.findUniqueOrThrow({
      where: { userId_channelId: { userId: other.id, channelId: channel.id } },
    });
    expect(stored.lastReadSeq).toBe(3);

    const bootstrap = await api.http().get('/api/bootstrap').set(bearerAuth(other.session));
    expect(bootstrap.body.readStates).toEqual(
      expect.arrayContaining([{ channelId: channel.id, lastReadSeq: 3 }]),
    );
  });

  test('a reader can clear a channel whose newest message was deleted', async () => {
    const channel = await textChannel();
    for (let i = 1; i <= 2; i++) await sendMessage(api, author.session, channel.id, `message ${i}`);
    const newest = await sendMessage(api, author.session, channel.id, 'posted, then deleted');
    await api.http().delete(`/api/messages/${newest.id}`).set(bearerAuth(author.session));
    const markRead = (seq: number) =>
      api
        .http()
        .post(`/api/channels/${channel.id}/read`)
        .set(bearerAuth(other.session))
        .send({ seq });

    expect((await markRead(1)).body.lastReadSeq).toBe(1);
    expect((await markRead(2)).body.lastReadSeq).toBe(3);

    const bootstrap = await api.http().get('/api/bootstrap').set(bearerAuth(other.session));
    const listed = bootstrap.body.channels.find((c: { id: string }) => c.id === channel.id);
    expect(listed.lastMessageSeq).toBe(3);
    expect(bootstrap.body.readStates).toEqual(
      expect.arrayContaining([{ channelId: channel.id, lastReadSeq: 3 }]),
    );
  });

  test('sending marks the channel read up to the sent message', async () => {
    const channel = await textChannel();
    const sent = await sendMessage(api, author.session, channel.id, 'implicitly read');
    const stored = await api.ctx.db.readState.findUniqueOrThrow({
      where: { userId_channelId: { userId: author.id, channelId: channel.id } },
    });
    expect(stored.lastReadSeq).toBe(sent.seq);
  });
});

describe('archived channels', () => {
  test('an archived text channel accepts no new messages and serves no history', async () => {
    const channel = await textChannel();
    await sendMessage(api, author.session, channel.id, 'before archiving');

    const archived = await api
      .http()
      .delete(`/api/admin/channels/${channel.id}`)
      .set(bearerAuth(owner.session));
    expect(archived.status).toBe(204);

    const send = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(bearerAuth(author.session))
      .send({ content: 'too late', clientNonce: randomUUID() });
    expect(send.status).toBe(404);
    expect(send.body.error.code).toBe('not_found');

    expect((await history(channel.id, author.session)).status).toBe(404);
    expect((await changes(channel.id, 0, author.session)).status).toBe(404);
    expect(await api.ctx.db.message.count({ where: { channelId: channel.id } })).toBe(1);
  });

  test('an archived voice channel mints no join token', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    await api
      .http()
      .delete(`/api/admin/channels/${channel.id}`)
      .set(bearerAuth(owner.session))
      .expect(204);

    const res = await api
      .http()
      .post('/api/voice/token')
      .set(bearerAuth(author.session))
      .send({ channelId: channel.id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  test('a text channel mints no join token, while a voice channel takes messages', async () => {
    const text = await textChannel();
    const voice = await createChannel(api.ctx, { type: 'VOICE' });

    const token = await api
      .http()
      .post('/api/voice/token')
      .set(bearerAuth(author.session))
      .send({ channelId: text.id });
    expect(token.status).toBe(403);
    expect(token.body.error.code).toBe('forbidden');

    const send = await api
      .http()
      .post(`/api/channels/${voice.id}/messages`)
      .set(bearerAuth(author.session))
      .send({ content: 'right channel type', clientNonce: randomUUID() });
    expect(send.status).toBe(201);
  });
});

describe('chat in a voice channel', () => {
  const voiceChannel = () => createChannel(api.ctx, { type: 'VOICE' });

  const markRead = (channelId: string, seq: number, session: DesktopSession) =>
    api.http().post(`/api/channels/${channelId}/read`).set(bearerAuth(session)).send({ seq });

  test('send, edit, delete, history, changes and read state work as in a text channel', async () => {
    const channel = await voiceChannel();
    const first = await sendMessage(api, author.session, channel.id, 'anyone hear me?');
    const second = await sendMessage(api, other.session, channel.id, 'loud and clear');
    expect([first.seq, second.seq]).toEqual([1, 2]);

    const page = await history(channel.id, author.session);
    expect(page.status).toBe(200);
    expect(page.body.messages.map((m: MessageDTO) => m.content)).toEqual([
      'anyone hear me?',
      'loud and clear',
    ]);
    expect(page.body.syncSeq).toBe(2);

    const edit = await api
      .http()
      .patch(`/api/messages/${first.id}`)
      .set(bearerAuth(author.session))
      .send({ content: 'can anyone hear me?' });
    expect(edit.status).toBe(200);
    expect(edit.body.message.changeSeq).toBe(3);

    const removed = await api
      .http()
      .delete(`/api/messages/${second.id}`)
      .set(bearerAuth(other.session));
    expect(removed.status).toBe(200);

    const resync = await changes(channel.id, 2, author.session);
    expect(resync.status).toBe(200);
    expect(resync.body.reset).toBe(false);
    expect(resync.body.syncSeq).toBe(4);
    expect(
      resync.body.changes.map((m: MessageDTO) => [m.id, m.content, m.deleted, m.changeSeq]),
    ).toEqual([
      [first.id, 'can anyone hear me?', false, 3],
      [second.id, '', true, 4],
    ]);

    const read = await markRead(channel.id, first.seq, other.session);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ channelId: channel.id, lastReadSeq: 2 });
  });

  test('unread state reaches the bootstrap the same way as for a text channel', async () => {
    const channel = await voiceChannel();
    const sent = await sendMessage(api, author.session, channel.id, 'unread for the others');

    const bootstrap = (session: DesktopSession) =>
      api.http().get('/api/bootstrap').set(bearerAuth(session)).expect(200);
    const listed = (await bootstrap(other.session)).body.channels.find(
      (c: { id: string }) => c.id === channel.id,
    );
    expect(listed).toMatchObject({ type: 'voice', lastMessageSeq: sent.seq });

    const readBy = async (session: DesktopSession) =>
      (await bootstrap(session)).body.readStates.find(
        (r: { channelId: string }) => r.channelId === channel.id,
      );
    expect(await readBy(author.session)).toEqual({ channelId: channel.id, lastReadSeq: sent.seq });
    expect(await readBy(other.session)).toBeUndefined();

    await markRead(channel.id, sent.seq, other.session).expect(200);
    expect(await readBy(other.session)).toEqual({ channelId: channel.id, lastReadSeq: sent.seq });
  });

  test('archiving retires its messages exactly as for a text channel', async () => {
    const channel = await voiceChannel();
    const message = await sendMessage(api, author.session, channel.id, 'last words');
    await api
      .http()
      .delete(`/api/admin/channels/${channel.id}`)
      .set(bearerAuth(owner.session))
      .expect(204);

    const send = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(bearerAuth(author.session))
      .send({ content: 'too late', clientNonce: randomUUID() });
    expect(send.status).toBe(404);
    expect((await history(channel.id, author.session)).status).toBe(404);
    expect((await changes(channel.id, 0, author.session)).status).toBe(404);
    expect((await markRead(channel.id, 1, author.session)).status).toBe(404);

    const edit = await api
      .http()
      .patch(`/api/messages/${message.id}`)
      .set(bearerAuth(author.session))
      .send({ content: 'rewriting history' });
    expect(edit.status).toBe(404);
    const remove = await api
      .http()
      .delete(`/api/messages/${message.id}`)
      .set(bearerAuth(author.session));
    expect(remove.status).toBe(404);

    const kept = await api.ctx.db.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(kept.content).toBe('last words');
  });
});
