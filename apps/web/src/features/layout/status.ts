import type { VoiceParticipantDTO, VoiceStatusDTO } from '@hostile/shared';

export type MicIndicator = 'muted' | 'no-microphone' | null;

export function micIndicator(p: VoiceParticipantDTO): MicIndicator {
  if (p.selfMuted || p.micMuted === true) return 'muted';
  return p.micMuted === null ? 'no-microphone' : null;
}

export type VoiceServerNotice = 'unreachable' | 'unconfirmed' | null;

export function voiceServerNotice(
  ready: boolean,
  voice: Pick<VoiceStatusDTO, 'mediaReachable' | 'checkedAt'>,
): VoiceServerNotice {
  if (!ready || voice.mediaReachable) return null;
  return voice.checkedAt ? 'unreachable' : 'unconfirmed';
}

export const VOICE_NOTICE_WORDS: Record<'unreachable' | 'unconfirmed', string> = {
  unreachable: 'Calls are not working just now. They come back by themselves when they can.',
  unconfirmed: 'Calls may not be set up on this server.',
};

const RECONCILE_INTERVAL_MS = 15_000;
export const PRESENCE_CONFIRM_TOLERANCE_MS = 3 * RECONCILE_INTERVAL_MS;

export type PresenceDoubt = 'unreachable' | 'stale' | null;

export function presenceDoubt(
  ready: boolean,
  voice: Pick<VoiceStatusDTO, 'mediaReachable' | 'checkedAt' | 'roomsConfirmedAt'>,
): PresenceDoubt {
  if (!ready) return null;
  if (!voice.mediaReachable) return voice.checkedAt ? 'unreachable' : null;
  const confirmedAt = voice.roomsConfirmedAt ? Date.parse(voice.roomsConfirmedAt) : NaN;
  if (!Number.isFinite(confirmedAt)) return 'stale';
  const attemptedAt = voice.checkedAt ? Date.parse(voice.checkedAt) : NaN;
  if (!Number.isFinite(attemptedAt)) return null;
  return attemptedAt - confirmedAt > PRESENCE_CONFIRM_TOLERANCE_MS ? 'stale' : null;
}

export const PRESENCE_DOUBT_LABEL: Record<'unreachable' | 'stale', string> = {
  unreachable: 'Last seen here — the voice server is unreachable, so this may be out of date',
  stale:
    'Last seen here — the voice server has not confirmed this recently, so it may be out of date',
};

export function presenceSentence(names: string[], doubt: PresenceDoubt): string {
  if (!names.length)
    return doubt ? 'Nobody was here when the voice server last answered.' : 'Nobody is here yet.';
  const who = names.join(', ');
  if (doubt) return `${who} ${names.length === 1 ? 'was' : 'were'} last seen in this channel.`;
  return `${who} ${names.length === 1 ? 'is' : 'are'} in this channel.`;
}

interface LocalRemote {
  hasMic: boolean;
  micMuted: boolean;
  screenShare: boolean;
}

export function ownRoomParticipants(
  snapshot: VoiceParticipantDTO[],
  doubt: PresenceDoubt,
  self: { userId: string; muted: boolean; deafened: boolean },
  remotes: Record<string, LocalRemote>,
): VoiceParticipantDTO[] {
  if (!doubt) return snapshot;
  const known = new Map(snapshot.map((p) => [p.userId, p]));
  const fromRoom = (userId: string): VoiceParticipantDTO => {
    const remote = remotes[userId];
    return {
      userId,
      identity: userId,
      joinedAt: null,
      micMuted: remote ? (remote.hasMic ? remote.micMuted : null) : self.muted,
      screenSharing: remote?.screenShare ?? false,
      selfMuted: remote ? false : self.muted,
      selfDeafened: remote ? false : self.deafened,
      watching: [],
    };
  };
  return [self.userId, ...Object.keys(remotes)].map((id) => known.get(id) ?? fromRoom(id));
}

export function withLiveMic(
  p: VoiceParticipantDTO,
  self: { userId: string; muted: boolean; deafened: boolean; micPublished: boolean },
  remotes: Record<string, LocalRemote>,
): VoiceParticipantDTO {
  if (p.userId === self.userId) {
    return {
      ...p,
      micMuted: self.micPublished ? self.muted : null,
      selfMuted: self.muted,
      selfDeafened: self.deafened,
    };
  }
  const remote = remotes[p.userId];
  if (!remote) return p;
  const micMuted = remote.hasMic ? remote.micMuted : null;
  return { ...p, micMuted, selfMuted: micMuted === false ? false : p.selfMuted };
}
