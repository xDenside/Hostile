import { randomUUID } from 'node:crypto';
import { voiceRoomName, type ServerToClientEvents, type VoiceStatusDTO } from '@hostile/shared';
import { ParticipantInfo_State, TrackSource, type ParticipantInfo } from 'livekit-server-sdk';
import type { Logger } from 'pino';
import { expect, test } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/config.js';
import type { Db } from '../../src/db.js';
import { VoiceService } from '../../src/media/voice-service.js';
import { NullEmitter, type RealtimeEmitter } from '../../src/realtime/emitter.js';
import { signWebhook, webhookBody } from '../support/livekit.js';

const LIVEKIT = {
  apiKey: 'APIunit7Qk3Vm9',
  apiSecret: 'Qz4Vb8Nm2Kc6Xy1Hf9Tr3Ws7Pd5Lg0Ja',
};

function voiceConfig(): AppConfig {
  return loadConfig({
    HOSTILE_ENV: 'development',
    PUBLIC_APP_URL: 'http://localhost:5190',
    SESSION_SECRET: 'x9f2Kq7Lm4Rz8Tv1Bn6Cw3Hy5Jd0Ps2Ae',
    LIVEKIT_API_KEY: LIVEKIT.apiKey,
    LIVEKIT_API_SECRET: LIVEKIT.apiSecret,
    LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:17999',
    LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:17999',
  });
}

const log = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function waitUntil(description: string, ready: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function fakeDb(
  userId: string,
  channelId: string,
  onUserLookup: () => Promise<void> = () => Promise.resolve(),
): Db {
  return {
    user: {
      findUnique: async () => {
        await onUserLookup();
        return { id: userId, disabledAt: null };
      },
      findMany: async (query: { where: { id: { in: string[] } } }) => {
        await onUserLookup();
        return query.where.id.in.map((id) => ({ id }));
      },
    },
    channel: {
      findUnique: async () => ({ id: channelId, type: 'VOICE', archivedAt: null }),
    },
  } as unknown as Db;
}

function participant(identity: string): ParticipantInfo {
  return {
    identity,
    kind: 0,
    state: ParticipantInfo_State.ACTIVE,
    joinedAtMs: 0,
    tracks: [],
  } as unknown as ParticipantInfo;
}

function injectRooms(
  voice: VoiceService,
  roomName: string,
  listParticipants: () => Promise<ParticipantInfo[]>,
  listRooms: () => Promise<{ name: string }[]> = async () => [{ name: roomName }],
): void {
  (voice as unknown as { roomClient: unknown }).roomClient = {
    listRooms,
    listParticipants,
    removeParticipant: async () => undefined,
  };
}

class RecordingEmitter implements RealtimeEmitter {
  readonly broadcasts: VoiceStatusDTO[] = [];
  toCommunity<E extends keyof ServerToClientEvents>(
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    if (event === 'voice:status') this.broadcasts.push(args[0] as VoiceStatusDTO);
  }
  toUser() {}
  toOwner() {}
  endSessions() {}
  isOnline() {
    return false;
  }
  onlineUserIds(): string[] {
    return [];
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const signed = (body: string) => signWebhook(LIVEKIT.apiKey, LIVEKIT.apiSecret, body);

test('a join still checking the database cannot resurrect a participant who left', async () => {
  const channelId = randomUUID();
  const identity = randomUUID();
  const roomName = voiceRoomName(channelId);
  const lookup = gate();
  let lookups = 0;
  const voice = new VoiceService(
    voiceConfig(),
    fakeDb(identity, channelId, () => {
      lookups++;
      return lookup.wait;
    }),
    log,
    () => new NullEmitter(),
  );

  const join = webhookBody('participant_joined', roomName, { identity });
  const leave = webhookBody('participant_left', roomName, { identity });
  const joining = voice.handleWebhook(join, await signed(join));
  await waitUntil('the join to reach the authorization check', () => lookups > 0);

  await voice.handleWebhook(leave, await signed(leave));
  lookup.open();
  await joining;

  expect(voice.status().rooms[channelId]).toBeUndefined();
});

test('a room snapshot read before a leave does not put the participant back', async () => {
  const channelId = randomUUID();
  const identity = randomUUID();
  const roomName = voiceRoomName(channelId);
  const listing = gate();
  let reads = 0;
  const voice = new VoiceService(
    voiceConfig(),
    fakeDb(identity, channelId),
    log,
    () => new NullEmitter(),
  );
  injectRooms(voice, roomName, async () => {
    reads++;
    await listing.wait;
    return [participant(identity)];
  });

  const pass = voice.reconcile();
  await waitUntil('the pass to be reading the room', () => reads > 0);

  const leave = webhookBody('participant_left', roomName, { identity });
  await voice.handleWebhook(leave, await signed(leave));
  listing.open();
  await pass;

  expect(voice.status().rooms[channelId]).toBeUndefined();
});

test('a database failure during a pass is not reported as an unreachable voice server', async () => {
  const channelId = randomUUID();
  const identity = randomUUID();
  const roomName = voiceRoomName(channelId);
  let databaseUp = true;
  const voice = new VoiceService(
    voiceConfig(),
    fakeDb(identity, channelId, () =>
      databaseUp ? Promise.resolve() : Promise.reject(new Error('connection terminated')),
    ),
    log,
    () => new NullEmitter(),
  );
  injectRooms(voice, roomName, async () => [participant(identity)]);

  await voice.reconcile();
  expect(voice.status().rooms[channelId]).toHaveLength(1);
  expect(voice.status().mediaReachable).toBe(true);

  databaseUp = false;
  await voice.reconcile();
  const after = voice.status();
  expect(after.mediaReachable).toBe(true);
  expect(after.rooms[channelId]).toHaveLength(1);
});

test('an unreachable voice server stops confirming the snapshot it keeps serving', async () => {
  const channelId = randomUUID();
  const identity = randomUUID();
  const roomName = voiceRoomName(channelId);
  let livekitUp = true;
  const voice = new VoiceService(
    voiceConfig(),
    fakeDb(identity, channelId),
    log,
    () => new NullEmitter(),
  );
  injectRooms(
    voice,
    roomName,
    async () => [participant(identity)],
    async () => {
      if (!livekitUp) throw new Error('connect ECONNREFUSED 127.0.0.1:17999');
      return [{ name: roomName }];
    },
  );

  await voice.reconcile();
  const confirmed = voice.status();
  expect(confirmed.roomsConfirmedAt).not.toBeNull();

  livekitUp = false;
  await sleep(2);
  await voice.reconcile();
  const stale = voice.status();
  expect(stale.rooms[channelId]).toHaveLength(1);
  expect(stale.mediaReachable).toBe(false);
  expect(stale.roomsConfirmedAt).toBe(confirmed.roomsConfirmedAt);
  expect(stale.checkedAt).not.toBe(confirmed.checkedAt);

  livekitUp = true;
  await sleep(2);
  await voice.reconcile();
  const recovered = voice.status();
  expect(recovered.mediaReachable).toBe(true);
  expect(Date.parse(recovered.roomsConfirmedAt!)).toBeGreaterThan(
    Date.parse(confirmed.roomsConfirmedAt!),
  );
});

test('only a signature-verified webhook confirms presence', async () => {
  const channelId = randomUUID();
  const identity = randomUUID();
  const roomName = voiceRoomName(channelId);
  const voice = new VoiceService(
    voiceConfig(),
    fakeDb(identity, channelId),
    log,
    () => new NullEmitter(),
  );
  const join = webhookBody('participant_joined', roomName, { identity });

  await expect(voice.handleWebhook(join, 'Bearer forged')).rejects.toThrow(
    'Invalid webhook signature.',
  );
  expect(voice.status().roomsConfirmedAt).toBeNull();

  await voice.handleWebhook(join, await signed(join));
  const status = voice.status();
  expect(status.rooms[channelId]).toHaveLength(1);
  expect(status.roomsConfirmedAt).not.toBeNull();
});

test('confirmation alone is not broadcast, but losing the voice server is', async () => {
  const channelId = randomUUID();
  const identity = randomUUID();
  const roomName = voiceRoomName(channelId);
  let livekitUp = true;
  const emitter = new RecordingEmitter();
  const voice = new VoiceService(voiceConfig(), fakeDb(identity, channelId), log, () => emitter);
  injectRooms(
    voice,
    roomName,
    async () => [participant(identity)],
    async () => {
      if (!livekitUp) throw new Error('connect ECONNREFUSED 127.0.0.1:17999');
      return [{ name: roomName }];
    },
  );

  await voice.reconcile();
  expect(emitter.broadcasts).toHaveLength(1);

  await sleep(2);
  await voice.reconcile();
  expect(emitter.broadcasts).toHaveLength(1);

  livekitUp = false;
  await voice.reconcile();
  expect(emitter.broadcasts).toHaveLength(2);
  expect(emitter.broadcasts[1]!.mediaReachable).toBe(false);
  expect(emitter.broadcasts[1]!.rooms[channelId]).toHaveLength(1);

  livekitUp = true;
  await voice.reconcile();
  expect(emitter.broadcasts).toHaveLength(3);
  expect(emitter.broadcasts[2]!.mediaReachable).toBe(true);
});

test('an unmute report re-reads the room, so the muted flag does not linger', async () => {
  const channelId = randomUUID();
  const identity = randomUUID();
  const roomName = voiceRoomName(channelId);
  let micMuted = true;
  const withMic = (): ParticipantInfo =>
    ({
      ...participant(identity),
      tracks: [{ source: TrackSource.MICROPHONE, muted: micMuted }],
    }) as unknown as ParticipantInfo;
  const emitter = new RecordingEmitter();
  const voice = new VoiceService(voiceConfig(), fakeDb(identity, channelId), log, () => emitter);
  injectRooms(voice, roomName, async () => [withMic()]);

  await voice.reconcile();
  voice.setSelfState(identity, { channelId, muted: true, deafened: false, watching: [] });
  expect(voice.status().rooms[channelId]![0]).toMatchObject({ micMuted: true, selfMuted: true });

  micMuted = false;
  voice.setSelfState(identity, { channelId, muted: false, deafened: false, watching: [] });
  await sleep(450);

  expect(voice.status().rooms[channelId]![0]).toMatchObject({ micMuted: false, selfMuted: false });
  expect(emitter.broadcasts.at(-1)!.rooms[channelId]![0]!.micMuted).toBe(false);
});

test('a watching report only names people in the same room, never the reporter', async () => {
  const channelId = randomUUID();
  const viewer = randomUUID();
  const sharer = randomUUID();
  const elsewhere = randomUUID();
  const roomName = voiceRoomName(channelId);
  const emitter = new RecordingEmitter();
  const voice = new VoiceService(voiceConfig(), fakeDb(viewer, channelId), log, () => emitter);
  injectRooms(voice, roomName, async () => [participant(viewer), participant(sharer)]);
  await voice.reconcile();

  voice.setSelfState(viewer, {
    channelId,
    muted: false,
    deafened: false,
    watching: [sharer, elsewhere, viewer, sharer],
  });
  const byUser = new Map(voice.status().rooms[channelId]!.map((p) => [p.userId, p]));
  expect(byUser.get(viewer)!.watching).toEqual([sharer]);
  expect(byUser.get(sharer)!.watching).toEqual([]);

  voice.setSelfState(viewer, {
    channelId: randomUUID(),
    muted: false,
    deafened: false,
    watching: [sharer],
  });
  expect(voice.status().rooms[channelId]!.find((p) => p.userId === viewer)!.watching).toEqual([]);
});
