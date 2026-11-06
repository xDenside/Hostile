import { create } from 'zustand';
import type { ChannelDTO, UserPublic, VoiceParticipantDTO, VoiceStatusDTO } from '@hostile/shared';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

interface CommunityState {
  ready: boolean;
  communityName: string;
  channels: ChannelDTO[];
  members: Record<string, UserPublic>;
  readStates: Record<string, number>;
  online: Record<string, true>;
  voice: VoiceStatusDTO;
  connection: ConnectionState;
  connectionError: string | null;
}

export const emptyVoiceStatus: VoiceStatusDTO = {
  rooms: {},
  mediaReachable: false,
  checkedAt: null,
  roomsConfirmedAt: null,
};

export const NO_PARTICIPANTS: VoiceParticipantDTO[] = [];

export const useCommunity = create<CommunityState>(() => ({
  ready: false,
  communityName: '',
  channels: [],
  members: {},
  readStates: {},
  online: {},
  voice: emptyVoiceStatus,
  connection: 'connecting',
  connectionError: null,
}));

export function resetCommunity() {
  useCommunity.setState({
    ready: false,
    communityName: '',
    channels: [],
    members: {},
    readStates: {},
    online: {},
    voice: emptyVoiceStatus,
    connection: 'connecting',
    connectionError: null,
  });
}

export function sortChannels(list: ChannelDTO[]): ChannelDTO[] {
  return [...list].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export function isUnread(channel: ChannelDTO, readStates: Record<string, number>): boolean {
  return channel.lastMessageSeq > (readStates[channel.id] ?? 0);
}
