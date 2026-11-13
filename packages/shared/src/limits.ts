export const LIMITS = {
  displayNameMin: 1,
  displayNameMax: 48,
  customStatusMax: 48,
  messageMax: 4000,
  replyExcerptMax: 160,
  channelNameMax: 48,
  historyPageDefault: 50,
  historyPageMax: 100,
  changesPageMax: 500,
  clientHistoryMax: 300,
  typingThrottleMs: 3000,
  typingDisplayMs: 6000,
  voiceWatchingMax: 16,
  jsonBodyBytes: 64 * 1024,
  avatarMaxBytes: 5 * 1024 * 1024,
  bannerMaxBytes: 10 * 1024 * 1024,
  profileImageMaxEdge: 4096,
  attachmentImageMaxBytes: 10 * 1024 * 1024,
  attachmentVideoMaxBytes: 30 * 1024 * 1024,
  attachmentDailyBytes: 1024 * 1024 * 1024,
  attachmentsPerMessage: 10,
  attachmentFileNameMax: 200,
  attachmentMaxEdge: 16384,
} as const;

export const AVATAR_COLORS = ['#2e2e2e', '#404040', '#525252', '#636363', '#757575'] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const PROFILE_MEDIA_KINDS = ['avatar', 'banner'] as const;
export type ProfileMediaKind = (typeof PROFILE_MEDIA_KINDS)[number];

export const PROFILE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ProfileImageType = (typeof PROFILE_IMAGE_TYPES)[number];

export const ATTACHMENT_IMAGE_TYPES = PROFILE_IMAGE_TYPES;
export const ATTACHMENT_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export type AttachmentVideoType = (typeof ATTACHMENT_VIDEO_TYPES)[number];
export type AttachmentType = ProfileImageType | AttachmentVideoType;
export type AttachmentKind = 'image' | 'video';

export const NAME_FONTS = [
  'default',
  'unbounded',
  'playfair',
  'pacifico',
  'caveat',
  'pixel',
  'mono',
  'comfortaa',
  'russo',
] as const;
export type NameFont = (typeof NAME_FONTS)[number];

export const NAME_EFFECTS = [
  'none',
  'gradient',
  'shine',
  'neon',
  'marker',
  'aurora',
  'glitch',
  'pop',
] as const;
export type NameEffect = (typeof NAME_EFFECTS)[number];

export const SCREEN_SHARE_PRESETS = {
  '720p30': {
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 2_500_000,
    label: '720p · 30 fps',
  },
  '1080p15': {
    width: 1920,
    height: 1080,
    frameRate: 15,
    maxBitrate: 3_000_000,
    label: '1080p · 15 fps (sharp text)',
  },
  '1080p30': {
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 4_500_000,
    label: '1080p · 30 fps',
  },
} as const;

export type ScreenSharePresetId = keyof typeof SCREEN_SHARE_PRESETS;
export const DEFAULT_SCREEN_SHARE_PRESET: ScreenSharePresetId = '720p30';
