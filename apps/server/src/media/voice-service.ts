import {
  AccessToken,
  ParticipantInfo_State,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
  type ParticipantInfo,
  type WebhookEvent,
} from 'livekit-server-sdk';
import {
  channelIdFromRoomName,
  voiceRoomName,
  type VoiceParticipantDTO,
  type VoiceSelfStatePayload,
  type VoiceStatusDTO,
  type VoiceTokenDTO,
} from '@hostile/shared';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { Channel, User } from '../generated/prisma/client.js';
import { errors } from '../lib/errors.js';
import type { RealtimeEmitter } from '../realtime/emitter.js';

interface ParticipantState {
  identity: string;
  userId: string;
  joinedAt: string | null;
  micMuted: boolean | null;
  screenSharing: boolean;
}

export class VoiceService {
  private readonly rooms = new Map<string, Map<string, ParticipantState>>();
  private readonly selfStates = new Map<
    string,
    Omit<VoiceSelfStatePayload, 'channelId'> & { channelId: string | null }
  >();
  private readonly roomRefreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly removals = new Map<string, number>();
  private readonly changes = new Map<string, number>();
  private readonly roomClient: RoomServiceClient | null;
  private readonly webhookReceiver: WebhookReceiver | null;
  private readonly seenWebhookIds = new Set<string>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;
  private mediaReachable = false;
  private checkedAt: string | null = null;
  private roomsConfirmedAt: string | null = null;
  private lastBroadcast = '';

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly log: Logger,
    private readonly realtime: () => RealtimeEmitter,
  ) {
    const lk = config.livekit;
    this.roomClient = lk.configured
      ? new RoomServiceClient(lk.internalUrl, lk.apiKey, lk.apiSecret, { requestTimeout: 5 })
      : null;
    this.webhookReceiver = lk.configured ? new WebhookReceiver(lk.apiKey, lk.apiSecret) : null;
  }

  get configured(): boolean {
    return this.config.livekit.configured;
  }

  start(): void {
    if (!this.roomClient) {
      this.log.warn('LiveKit is not configured (LIVEKIT_* variables); voice is disabled');
      return;
    }
    void this.reconcile();
    this.reconcileTimer = setInterval(
      () => void this.reconcile(),
      this.config.livekit.reconcileIntervalMs,
    );
    this.reconcileTimer.unref();
  }

  stop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const t of this.roomRefreshTimers.values()) clearTimeout(t);
    this.roomRefreshTimers.clear();
  }

  async createJoinToken(user: User, channelId: string): Promise<VoiceTokenDTO> {
    if (!this.configured) throw errors.mediaUnavailable('Voice is not configured on this server.');
    if (user.disabledAt) throw errors.accountDisabled();
    const channel = await this.db.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.archivedAt) throw errors.notFound('Channel');
    if (channel.type !== 'VOICE') throw errors.forbidden('That is not a voice channel.');

    const roomName = voiceRoomName(channel.id);
    const ttl = this.config.livekit.tokenTtlSec;
    const at = new AccessToken(this.config.livekit.apiKey, this.config.livekit.apiSecret, {
      identity: user.id,
      name: user.displayName,
      ttl,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: [
        TrackSource.MICROPHONE,
        TrackSource.SCREEN_SHARE,
        TrackSource.SCREEN_SHARE_AUDIO,
      ],
    });
    const token = await at.toJwt();
    return {
      url: this.config.livekit.publicUrl,
      token,
      identity: user.id,
      roomName,
      channelId: channel.id,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async handleWebhook(rawBody: string, authorization: string | undefined): Promise<void> {
    if (!this.webhookReceiver)
      throw errors.mediaUnavailable('Voice is not configured on this server.');
    let event: WebhookEvent;
    try {
      event = await this.webhookReceiver.receive(rawBody, authorization);
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message },
        'rejected LiveKit webhook with invalid signature',
      );
      throw errors.unauthenticated('Invalid webhook signature.');
    }
    if (event.id) {
      if (this.seenWebhookIds.has(event.id)) return;
      this.seenWebhookIds.add(event.id);
      if (this.seenWebhookIds.size > 2000) this.seenWebhookIds.clear();
    }
    const roomName = event.room?.name ?? '';
    const channelId = channelIdFromRoomName(roomName);
    if (!channelId) return;
    this.mediaReachable = true;

    switch (event.event) {
      case 'participant_joined': {
        const p = event.participant;
        if (!p) break;
        const removalsBefore = this.removalCount(channelId);
        if ((await this.enforceAccess(roomName, p.identity)) !== 'allowed') break;
        if (this.removalCount(channelId) !== removalsBefore) break;
        this.upsertParticipant(channelId, p);
        this.confirmRooms();
        this.broadcastIfChanged();
        break;
      }
      case 'participant_left':
      case 'participant_connection_aborted': {
        const identity = event.participant?.identity;
        if (identity) {
          this.rooms.get(channelId)?.delete(identity);
          this.recordRemoval(channelId);
          this.confirmRooms();
          this.broadcastIfChanged();
        }
        break;
      }
      case 'room_finished':
        this.rooms.delete(channelId);
        this.recordRemoval(channelId);
        this.confirmRooms();
        this.broadcastIfChanged();
        break;
      case 'track_published':
      case 'track_unpublished':
        this.scheduleRoomRefresh(roomName);
        break;
      default:
        break;
    }
  }

  reconcile(): Promise<void> {
    this.reconciling ??= this.doReconcile().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    if (!this.roomClient) return;
    try {
      const changesAtStart = new Map([...this.rooms.keys()].map((c) => [c, this.changeCount(c)]));
      const rooms = await this.roomClient.listRooms();
      const seen = new Set<string>();
      for (const room of rooms) {
        const channelId = channelIdFromRoomName(room.name);
        if (!channelId) continue;
        seen.add(channelId);
        await this.refreshRoom(room.name);
      }
      for (const channelId of [...this.rooms.keys()]) {
        if (seen.has(channelId)) continue;
        if (changesAtStart.get(channelId) !== this.changeCount(channelId)) continue;
        this.rooms.delete(channelId);
        this.recordRemoval(channelId);
      }
      this.mediaReachable = true;
      this.confirmRooms();
    } catch (err) {
      if (this.mediaReachable)
        this.log.warn({ err: (err as Error).message }, 'LiveKit unreachable during reconciliation');
      this.mediaReachable = false;
    }
    this.checkedAt = new Date().toISOString();
    this.broadcastIfChanged();
  }

  private scheduleRoomRefresh(roomName: string): void {
    const existing = this.roomRefreshTimers.get(roomName);
    if (existing) clearTimeout(existing);
    this.roomRefreshTimers.set(
      roomName,
      setTimeout(() => {
        this.roomRefreshTimers.delete(roomName);
        this.refreshRoom(roomName)
          .then(() => this.broadcastIfChanged())
          .catch((err) =>
            this.log.warn({ err: (err as Error).message, roomName }, 'room refresh failed'),
          );
      }, 300),
    );
  }

  private async refreshRoom(roomName: string): Promise<void> {
    if (!this.roomClient) return;
    const channelId = channelIdFromRoomName(roomName);
    if (!channelId) return;
    const changesBefore = this.changeCount(channelId);
    const participants = await this.roomClient.listParticipants(roomName);
    const next = new Map<string, ParticipantState>();
    for (const p of participants) {
      if (p.kind !== 0) continue;
      if (p.state === ParticipantInfo_State.DISCONNECTED) continue;
      const access = await this.enforceAccess(roomName, p.identity);
      if (access === 'unknown') return;
      if (access === 'denied') continue;
      next.set(p.identity, this.toState(p));
    }
    if (this.changeCount(channelId) !== changesBefore) return;
    if (next.size) this.rooms.set(channelId, next);
    else this.rooms.delete(channelId);
    this.recordChange(channelId);
  }

  private async enforceAccess(
    roomName: string,
    identity: string,
  ): Promise<'allowed' | 'denied' | 'unknown'> {
    const channelId = channelIdFromRoomName(roomName);
    let user: User | null;
    let channel: Channel | null;
    try {
      [user, channel] = await Promise.all([
        /^[0-9a-f-]{36}$/i.test(identity)
          ? this.db.user.findUnique({ where: { id: identity } })
          : null,
        channelId ? this.db.channel.findUnique({ where: { id: channelId } }) : null,
      ]);
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message, roomName, identity },
        'could not check voice participant authorization: the database did not answer',
      );
      return 'unknown';
    }
    const allowed =
      !!user && !user.disabledAt && !!channel && !channel.archivedAt && channel.type === 'VOICE';
    if (!allowed) {
      this.log.warn({ roomName, identity }, 'removing unauthorized participant from LiveKit room');
      await this.roomClient?.removeParticipant(roomName, identity).catch(() => undefined);
      return 'denied';
    }
    return 'allowed';
  }

  private upsertParticipant(channelId: string, p: ParticipantInfo): void {
    let room = this.rooms.get(channelId);
    if (!room) {
      room = new Map();
      this.rooms.set(channelId, room);
    }
    room.set(p.identity, this.toState(p));
    this.recordChange(channelId);
  }

  private removalCount(channelId: string): number {
    return this.removals.get(channelId) ?? 0;
  }

  private changeCount(channelId: string): number {
    return this.changes.get(channelId) ?? 0;
  }

  private recordRemoval(channelId: string): void {
    this.removals.set(channelId, this.removalCount(channelId) + 1);
    this.recordChange(channelId);
  }

  private recordChange(channelId: string): void {
    this.changes.set(channelId, this.changeCount(channelId) + 1);
  }

  private confirmRooms(): void {
    this.roomsConfirmedAt = new Date().toISOString();
  }

  private toState(p: ParticipantInfo): ParticipantState {
    const mic = p.tracks.find((t) => t.source === TrackSource.MICROPHONE);
    return {
      identity: p.identity,
      userId: p.identity,
      joinedAt: p.joinedAtMs ? new Date(Number(p.joinedAtMs)).toISOString() : null,
      micMuted: mic ? mic.muted : null,
      screenSharing: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
    };
  }

  async removeUserEverywhere(userId: string): Promise<void> {
    if (!this.roomClient) return;
    try {
      const rooms = await this.roomClient.listRooms();
      for (const room of rooms) {
        if (!channelIdFromRoomName(room.name)) continue;
        await this.roomClient.removeParticipant(room.name, userId).catch(() => undefined);
      }
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message, userId },
        'could not reach LiveKit to remove user; reconciliation will retry',
      );
    }
    for (const [channelId, room] of this.rooms) {
      if (room.delete(userId)) this.recordRemoval(channelId);
    }
    this.selfStates.delete(userId);
    this.broadcastIfChanged();
  }

  async closeChannelRoom(channelId: string): Promise<void> {
    await this.roomClient?.deleteRoom(voiceRoomName(channelId)).catch(() => undefined);
    this.rooms.delete(channelId);
    this.recordRemoval(channelId);
    this.broadcastIfChanged();
  }

  setSelfState(userId: string, state: VoiceSelfStatePayload): void {
    this.selfStates.set(userId, state);
    this.broadcastIfChanged();
    if (state.channelId && this.rooms.has(state.channelId)) {
      this.scheduleRoomRefresh(voiceRoomName(state.channelId));
    }
  }

  clearSelfState(userId: string): void {
    if (this.selfStates.delete(userId)) this.broadcastIfChanged();
  }

  status(): VoiceStatusDTO {
    const rooms: Record<string, VoiceParticipantDTO[]> = {};
    for (const [channelId, participants] of this.rooms) {
      const list = [...participants.values()].map((p) => {
        const self = this.selfStates.get(p.userId);
        const selfApplies = self?.channelId === channelId;
        return {
          userId: p.userId,
          identity: p.identity,
          joinedAt: p.joinedAt,
          micMuted: p.micMuted,
          screenSharing: p.screenSharing,
          selfMuted: selfApplies ? self.muted : false,
          selfDeafened: selfApplies ? self.deafened : false,
          watching: selfApplies
            ? [...new Set(self.watching)].filter((id) => id !== p.userId && participants.has(id))
            : [],
        } satisfies VoiceParticipantDTO;
      });
      list.sort(
        (a, b) =>
          (a.joinedAt ?? '').localeCompare(b.joinedAt ?? '') || a.userId.localeCompare(b.userId),
      );
      if (list.length) rooms[channelId] = list;
    }
    return {
      rooms,
      mediaReachable: this.mediaReachable,
      checkedAt: this.checkedAt,
      roomsConfirmedAt: this.roomsConfirmedAt,
    };
  }

  private broadcastIfChanged(): void {
    const status = this.status();
    const key = JSON.stringify({ r: status.rooms, m: status.mediaReachable });
    if (key === this.lastBroadcast) return;
    this.lastBroadcast = key;
    this.realtime().toCommunity('voice:status', status);
  }

  async ping(): Promise<'ok' | 'unreachable' | 'unconfigured'> {
    if (!this.roomClient) return 'unconfigured';
    try {
      await this.roomClient.listRooms([]);
      return 'ok';
    } catch {
      return 'unreachable';
    }
  }
}
