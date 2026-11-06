import { randomUUID } from 'node:crypto';
import { voiceRoomName, type VoiceStatusDTO } from '@hostile/shared';
import { RoomServiceClient } from 'livekit-server-sdk';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  bearerAuth,
  createChannel,
  createUser,
  loginDesktop,
  type DesktopSession,
} from '../support/factories.js';
import {
  resetDatabase,
  startTestApi,
  VOICE_TOKEN_TTL_SEC,
  waitFor,
  type TestApi,
} from '../support/harness.js';
import { signWebhook, verifyVoiceToken, webhookBody } from '../support/livekit.js';
import { integrationConfig } from '../support/provided.js';

const livekit = integrationConfig().livekit;

let api: TestApi;
let member: { id: string; session: DesktopSession };
let owner: { id: string; session: DesktopSession };

beforeAll(async () => {
  api = await startTestApi({ livekit: true });
  await resetDatabase(api.ctx);
  const [memberUser, ownerUser] = await Promise.all([
    createUser(api.ctx),
    createUser(api.ctx, { role: 'OWNER' }),
  ]);
  const [memberSession, ownerSession] = await Promise.all([
    loginDesktop(api, memberUser),
    loginDesktop(api, ownerUser),
  ]);
  member = { id: memberUser.id, session: memberSession };
  owner = { id: ownerUser.id, session: ownerSession };
  await api.ctx.voice.reconcile();
});

afterAll(async () => {
  await api?.stop();
});

const voiceStatus = async (): Promise<VoiceStatusDTO> => {
  const res = await api.http().get('/api/voice/status').set(bearerAuth(member.session));
  expect(res.status).toBe(200);
  return res.body as VoiceStatusDTO;
};

const postWebhook = async (body: string, authorization?: string) => {
  const req = api
    .http()
    .post('/api/livekit/webhook')
    .set('Content-Type', 'application/webhook+json');
  if (authorization !== undefined) req.set('Authorization', authorization);
  return req.send(body);
};

describe('voice join tokens', () => {
  test('the token is a real LiveKit JWT carrying exactly the grants the product needs', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const before = Date.now();

    const res = await api
      .http()
      .post('/api/voice/token')
      .set(bearerAuth(member.session))
      .send({ channelId: channel.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: livekit.publicUrl,
      identity: member.id,
      roomName: voiceRoomName(channel.id),
      channelId: channel.id,
    });
    expect(res.body.url).toMatch(/^wss?:\/\//);
    expect(res.body.url).not.toBe(livekit.internalUrl);

    const claims = await verifyVoiceToken(
      livekit.apiKey,
      livekit.apiSecret,
      res.body.token as string,
    );
    expect(claims.sub).toBe(member.id);
    expect(claims.iss).toBe(livekit.apiKey);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: voiceRoomName(channel.id),
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    expect(claims.video?.roomCreate).toBeUndefined();
    expect(claims.video?.roomAdmin).toBeUndefined();

    const sources = claims.video?.canPublishSources as unknown as string[];
    expect([...sources].sort()).toEqual(['microphone', 'screen_share', 'screen_share_audio']);
    expect(sources).not.toContain('camera');

    const expiresAt = new Date(res.body.expiresAt as string).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + VOICE_TOKEN_TTL_SEC * 1000 - 2_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + VOICE_TOKEN_TTL_SEC * 1000);
    expect(claims.exp! * 1000).toBeLessThanOrEqual(Date.now() + (VOICE_TOKEN_TTL_SEC + 5) * 1000);
    expect(claims.exp! * 1000).toBeGreaterThan(Date.now());
  });

  test('tokens are refused for text channels, unknown channels and archived channels', async () => {
    const text = await createChannel(api.ctx, { type: 'TEXT' });
    const archived = await createChannel(api.ctx, { type: 'VOICE', archived: true });
    const mint = (channelId: string) =>
      api.http().post('/api/voice/token').set(bearerAuth(member.session)).send({ channelId });

    const onText = await mint(text.id);
    expect(onText.status).toBe(403);
    expect(onText.body.error.code).toBe('forbidden');

    const unknown = await mint(randomUUID());
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');

    const onArchived = await mint(archived.id);
    expect(onArchived.status).toBe(404);

    const malformed = await mint('not-a-uuid');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('validation_error');
  });

  test('a disabled account gets no token even with a live session', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const user = await createUser(api.ctx);
    const session = await loginDesktop(api, user);
    await api.ctx.db.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });

    const res = await api
      .http()
      .post('/api/voice/token')
      .set(bearerAuth(session))
      .send({ channelId: channel.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('account_disabled');
  });
});

describe('webhooks', () => {
  test('a body with no signature is rejected', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const body = webhookBody('participant_joined', voiceRoomName(channel.id), {
      identity: member.id,
    });

    const noHeader = await postWebhook(body);
    expect(noHeader.status).toBe(401);
    expect(noHeader.body.error.code).toBe('unauthenticated');

    const garbage = await postWebhook(body, 'not-a-jwt');
    expect(garbage.status).toBe(401);
  });

  test('a tampered body is rejected even though the signature itself is valid', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const signed = webhookBody('participant_joined', voiceRoomName(channel.id), {
      identity: member.id,
    });
    const swapped = webhookBody('participant_joined', voiceRoomName(channel.id), {
      identity: owner.id,
    });
    const authorization = await signWebhook(livekit.apiKey, livekit.apiSecret, signed);

    const res = await postWebhook(swapped, authorization);
    expect(res.status).toBe(401);
    expect((await voiceStatus()).rooms[channel.id]).toBeUndefined();
  });

  test('a body signed with the wrong secret is rejected', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const body = webhookBody('participant_joined', voiceRoomName(channel.id), {
      identity: member.id,
    });
    const authorization = await signWebhook(
      livekit.apiKey,
      'an-impostors-secret-long-enough-x',
      body,
    );

    const res = await postWebhook(body, authorization);
    expect(res.status).toBe(401);
  });

  test('a correctly signed join is accepted and becomes visible presence', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const room = voiceRoomName(channel.id);
    const joinedAtMs = 1_700_000_000_000;

    const join = webhookBody('participant_joined', room, {
      identity: member.id,
      joinedAtMs,
      tracks: [{ source: 'MICROPHONE', muted: false }],
    });
    const accepted = await postWebhook(
      join,
      await signWebhook(livekit.apiKey, livekit.apiSecret, join),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ ok: true });

    expect((await voiceStatus()).rooms[channel.id]).toEqual([
      {
        userId: member.id,
        identity: member.id,
        joinedAt: new Date(joinedAtMs).toISOString(),
        micMuted: false,
        screenSharing: false,
        selfMuted: false,
        selfDeafened: false,
        watching: [],
      },
    ]);

    const sharing = webhookBody('participant_joined', room, {
      identity: member.id,
      joinedAtMs,
      tracks: [{ source: 'MICROPHONE', muted: true }, { source: 'SCREEN_SHARE' }],
    });
    await postWebhook(sharing, await signWebhook(livekit.apiKey, livekit.apiSecret, sharing)).then(
      (r) => expect(r.status).toBe(200),
    );
    expect((await voiceStatus()).rooms[channel.id]![0]).toMatchObject({
      micMuted: true,
      screenSharing: true,
    });

    const leave = webhookBody('participant_left', room, { identity: member.id });
    await postWebhook(leave, await signWebhook(livekit.apiKey, livekit.apiSecret, leave)).then(
      (r) => expect(r.status).toBe(200),
    );
    expect((await voiceStatus()).rooms[channel.id]).toBeUndefined();
  });

  test('a join by an identity that is not an active account is not trusted', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const room = voiceRoomName(channel.id);
    const disabled = await createUser(api.ctx, { disabled: true });

    for (const identity of [randomUUID(), disabled.id, 'not-even-a-uuid']) {
      const body = webhookBody('participant_joined', room, { identity });
      const res = await postWebhook(
        body,
        await signWebhook(livekit.apiKey, livekit.apiSecret, body),
      );
      expect(res.status, identity).toBe(200);
      expect((await voiceStatus()).rooms[channel.id], identity).toBeUndefined();
    }
  });

  test('a join for a room that is not a voice channel is ignored', async () => {
    const text = await createChannel(api.ctx, { type: 'TEXT' });
    const bodies = [
      webhookBody('participant_joined', voiceRoomName(text.id), { identity: member.id }),
      webhookBody('participant_joined', 'someone-elses-room', { identity: member.id }),
    ];
    for (const body of bodies) {
      const res = await postWebhook(
        body,
        await signWebhook(livekit.apiKey, livekit.apiSecret, body),
      );
      expect(res.status).toBe(200);
    }
    expect((await voiceStatus()).rooms[text.id]).toBeUndefined();
  });

  test('room_finished empties the channel, so nobody is shown in a room that is gone', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const room = voiceRoomName(channel.id);

    const join = webhookBody('participant_joined', room, { identity: member.id });
    await postWebhook(join, await signWebhook(livekit.apiKey, livekit.apiSecret, join)).then((r) =>
      expect(r.status).toBe(200),
    );
    expect((await voiceStatus()).rooms[channel.id]).toHaveLength(1);

    const finished = webhookBody('room_finished', room);
    await postWebhook(
      finished,
      await signWebhook(livekit.apiKey, livekit.apiSecret, finished),
    ).then((r) => expect(r.status).toBe(200));
    expect((await voiceStatus()).rooms[channel.id]).toBeUndefined();
  });
});

describe.skipIf(!livekit.running)('with a real LiveKit server', () => {
  const rooms = () => new RoomServiceClient(livekit.internalUrl, livekit.apiKey, livekit.apiSecret);

  test('the API reaches the server and reports it healthy', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const client = rooms();
    const room = await client.createRoom({ name: voiceRoomName(channel.id), emptyTimeout: 30 });
    expect(room.name).toBe(voiceRoomName(channel.id));

    try {
      await api.ctx.voice.reconcile();
      const status = await voiceStatus();
      expect(status.mediaReachable).toBe(true);
      expect(status.checkedAt).not.toBeNull();
      expect(status.rooms[channel.id]).toBeUndefined();

      await api.ctx.voice.reconcile();
      expect((await voiceStatus()).checkedAt).not.toBe(status.checkedAt);

      const health = await api.http().get('/api/health');
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: 'ok', database: 'ok', media: 'ok' });

      const listed = await client.listRooms();
      expect(listed.map((r) => r.name)).toContain(voiceRoomName(channel.id));
    } finally {
      await client.deleteRoom(voiceRoomName(channel.id));
    }
  });

  test('removing a participant who is not in the room is handled gracefully', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const client = rooms();
    await client.createRoom({ name: voiceRoomName(channel.id), emptyTimeout: 30 });
    try {
      await expect(api.ctx.voice.removeUserEverywhere(randomUUID())).resolves.toBeUndefined();
      await expect(api.ctx.voice.reconcile()).resolves.toBeUndefined();
      expect((await voiceStatus()).mediaReachable).toBe(true);
    } finally {
      await client.deleteRoom(voiceRoomName(channel.id));
    }
  });

  test('a room whose channel does not exist is left out of the snapshot', async () => {
    const client = rooms();
    const orphan = voiceRoomName(randomUUID());
    await client.createRoom({ name: orphan, emptyTimeout: 30 });
    try {
      await api.ctx.voice.reconcile();
      const status = await voiceStatus();
      expect(Object.keys(status.rooms)).toHaveLength(0);
    } finally {
      await client.deleteRoom(orphan);
    }
  });

  test('archiving a voice channel closes its LiveKit room', async () => {
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const client = rooms();
    await client.createRoom({ name: voiceRoomName(channel.id), emptyTimeout: 300 });
    expect((await client.listRooms()).map((r) => r.name)).toContain(voiceRoomName(channel.id));

    await api
      .http()
      .delete(`/api/admin/channels/${channel.id}`)
      .set(bearerAuth(owner.session))
      .expect(204);

    await waitFor('the LiveKit room to be gone', async () => {
      const names = (await client.listRooms()).map((r) => r.name);
      return !names.includes(voiceRoomName(channel.id));
    });
  });
});

describe.skipIf(livekit.running)('without a reachable LiveKit server', () => {
  test('health reports media unreachable and the API degraded, but stays available', async () => {
    await api.ctx.voice.reconcile();
    expect((await voiceStatus()).mediaReachable).toBe(false);

    const health = await api.http().get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'degraded', database: 'ok', media: 'unreachable' });
  });
});
