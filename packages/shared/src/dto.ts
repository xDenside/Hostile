import type { AttachmentKind, NameEffect, NameFont } from './limits.js';

export type Role = 'owner' | 'member';
export type ChannelType = 'text' | 'voice';

export interface UserPublic {
  id: string;
  displayName: string;
  avatarColor: string;
  role: Role;
  disabled: boolean;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bannerColor: string | null;
  nameFont: NameFont;
  nameEffect: NameEffect;
  nameColor: string | null;
  nameColor2: string | null;
  customStatus: string | null;
}

export interface SelfUser extends UserPublic {
  createdAt: string;
}

export interface ChannelDTO {
  id: string;
  name: string;
  type: ChannelType;
  position: number;
  lastMessageSeq: number;
}

export interface ArchivedChannelDTO extends ChannelDTO {
  archivedAt: string;
}

export interface ReadStateDTO {
  channelId: string;
  lastReadSeq: number;
}

export interface AttachmentDTO {
  id: string;
  kind: AttachmentKind;
  url: string;
  contentType: string;
  fileName: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}

export interface MessageQuoteDTO {
  id: string;
  seq: number;
  changeSeq: number;
  authorId: string;
  excerpt: string;
  attachmentCount: number;
  attachmentKind: AttachmentKind | null;
  deleted: boolean;
}

export interface MessageOriginDTO {
  messageId: string | null;
  seq: number | null;
  authorId: string;
  channelId: string;
  channelName: string;
  createdAt: string;
}

export interface MessageDTO {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  seq: number;
  changeSeq: number;
  clientNonce: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  attachments: AttachmentDTO[];
  replyTo: MessageQuoteDTO | null;
  forwardedFrom: MessageOriginDTO | null;
}

export interface MessagePageDTO {
  messages: MessageDTO[];
  hasOlder: boolean;
  syncSeq: number;
}

export interface ChangesDTO {
  changes: MessageDTO[];
  syncSeq: number;
  reset: boolean;
}

export interface SendMessageResponse {
  message: MessageDTO;
  duplicate: boolean;
}

export interface VoiceParticipantDTO {
  userId: string;
  identity: string;
  joinedAt: string | null;
  micMuted: boolean | null;
  screenSharing: boolean;
  selfMuted: boolean;
  selfDeafened: boolean;
  watching: string[];
}

export type VoiceRoomsSnapshot = Record<string, VoiceParticipantDTO[]>;

export interface VoiceStatusDTO {
  rooms: VoiceRoomsSnapshot;
  mediaReachable: boolean;
  checkedAt: string | null;
  roomsConfirmedAt: string | null;
}

export interface VoiceTokenDTO {
  url: string;
  token: string;
  identity: string;
  roomName: string;
  channelId: string;
  expiresAt: string;
}

export interface CommunityDTO {
  name: string;
}

export interface BootstrapDTO {
  self: SelfUser;
  community: CommunityDTO;
  channels: ChannelDTO[];
  readStates: ReadStateDTO[];
  members: UserPublic[];
  onlineUserIds: string[];
  voice: VoiceStatusDTO;
  serverTime: string;
}

export interface PublicConfigDTO {
  appName: string;
  communityName: string;
  environment: 'development' | 'test' | 'production';
  livekitUrl: string | null;
  apiVersion: 1;
}

export interface WebAuthResponse {
  user: SelfUser;
  csrfToken: string;
}

export interface DesktopAuthResponse {
  user: SelfUser;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
}

export interface AccessTokenResponse {
  user: SelfUser;
  accessToken: string;
  accessTokenExpiresAt: string;
}

export interface SessionResponse {
  user: SelfUser;
  csrfToken: string | null;
}

export interface JoinRequestDTO {
  id: string;
  nickname: string;
  pictureUrl: string | null;
  askedAt: string;
}

export type JoinStatus =
  | { status: 'waiting' }
  | { status: 'turned-away' }
  | { status: 'unknown' }
  | { status: 'admitted'; user: SelfUser; csrfToken: string };

export type JoinAskResponse = { ticket: string } | Extract<JoinStatus, { status: 'admitted' }>;

export interface AdminUserDTO extends UserPublic {
  createdAt: string;
  activeSessions: number;
}

export interface SessionInfoDTO {
  id: string;
  client: 'web' | 'desktop';
  createdAt: string;
  lastUsedAt: string;
  userAgent: string | null;
  current: boolean;
}

export interface HealthDTO {
  status: 'ok' | 'degraded';
  database: 'ok' | 'error';
  media: 'ok' | 'unreachable' | 'unconfigured';
  version: string;
  uptimeSec: number;
}
