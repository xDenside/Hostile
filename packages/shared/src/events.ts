import type { ChannelDTO, JoinRequestDTO, MessageDTO, UserPublic, VoiceStatusDTO } from './dto.js';
import type { VoiceSelfStatePayload } from './schemas.js';

export type SessionEndReason = 'logout' | 'revoked' | 'expired' | 'disabled';

export interface ServerToClientEvents {
  'message:created': (message: MessageDTO) => void;
  'message:updated': (message: MessageDTO) => void;
  'channel:upserted': (channel: ChannelDTO) => void;
  'channel:removed': (payload: { id: string }) => void;
  'member:upserted': (member: UserPublic) => void;
  'join:requests': (payload: { requests: JoinRequestDTO[] }) => void;
  'presence:changed': (payload: { userId: string; online: boolean }) => void;
  typing: (payload: { channelId: string; userId: string }) => void;
  'voice:status': (status: VoiceStatusDTO) => void;
  'read:updated': (payload: { channelId: string; lastReadSeq: number }) => void;
  'session:ended': (payload: { reason: SessionEndReason }) => void;
}

export interface ClientToServerEvents {
  'typing:start': (payload: { channelId: string }) => void;
  'voice:self-state': (payload: VoiceSelfStatePayload) => void;
}

export const SOCKET_ROOMS = {
  owner: 'owner',
  community: 'community',
  user: (userId: string) => `user:${userId}`,
  session: (sessionId: string) => `session:${sessionId}`,
} as const;
