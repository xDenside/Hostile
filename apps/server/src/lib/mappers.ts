import {
  messageExcerpt,
  NAME_EFFECTS,
  NAME_FONTS,
  type AttachmentDTO,
  type AttachmentKind,
  type ChannelDTO,
  type MessageDTO,
  type MessageOriginDTO,
  type MessageQuoteDTO,
  type NameEffect,
  type NameFont,
  type SelfUser,
  type SessionInfoDTO,
  type UserPublic,
} from '@hostile/shared';
import type {
  Channel,
  Message,
  MessageAttachment,
  Session,
  User,
} from '../generated/prisma/client.js';

const mediaUrl = (mediaId: string | null) => (mediaId ? `/api/media/${mediaId}` : null);

const nameFont = (value: string): NameFont =>
  NAME_FONTS.find((font) => font === value) ?? 'default';
const nameEffect = (value: string): NameEffect =>
  NAME_EFFECTS.find((effect) => effect === value) ?? 'none';

export function toUserPublic(u: User): UserPublic {
  return {
    id: u.id,
    displayName: u.displayName,
    avatarColor: u.avatarColor,
    role: u.role === 'OWNER' ? 'owner' : 'member',
    disabled: u.disabledAt !== null,
    avatarUrl: mediaUrl(u.avatarMediaId),
    bannerUrl: mediaUrl(u.bannerMediaId),
    bannerColor: u.bannerColor,
    nameFont: nameFont(u.nameFont),
    nameEffect: nameEffect(u.nameEffect),
    nameColor: u.nameColor,
    nameColor2: u.nameColor2,
    customStatus: u.customStatus,
  };
}

export function toSelfUser(u: User): SelfUser {
  return { ...toUserPublic(u), createdAt: u.createdAt.toISOString() };
}

export function toChannelDTO(c: Channel): ChannelDTO {
  return {
    id: c.id,
    name: c.name,
    type: c.type === 'VOICE' ? 'voice' : 'text',
    position: c.position,
    lastMessageSeq: c.lastMessageSeq,
  };
}

export const attachmentKind = (contentType: string): AttachmentKind =>
  contentType.startsWith('video/') ? 'video' : 'image';

export function toSessionInfoDTO(s: Session, currentSessionId: string): SessionInfoDTO {
  return {
    id: s.id,
    client: s.client === 'DESKTOP' ? 'desktop' : 'web',
    createdAt: s.createdAt.toISOString(),
    lastUsedAt: s.lastUsedAt.toISOString(),
    userAgent: s.userAgent,
    current: s.id === currentSessionId,
  };
}

export function toAttachmentDTO(a: MessageAttachment): AttachmentDTO {
  return {
    id: a.id,
    kind: attachmentKind(a.contentType),
    url: `/api/attachments/${a.id}`,
    contentType: a.contentType,
    fileName: a.fileName,
    byteSize: a.byteSize,
    width: a.width,
    height: a.height,
  };
}

export const MESSAGE_INCLUDE = {
  attachments: { orderBy: { position: 'asc' } },
  replyTo: {
    select: {
      id: true,
      seq: true,
      changeSeq: true,
      authorId: true,
      content: true,
      deletedAt: true,
      attachments: { orderBy: { position: 'asc' }, select: { contentType: true } },
    },
  },
  forwardedFromMessage: { select: { seq: true, deletedAt: true } },
} as const;

export type MessageRow = Message & {
  attachments: MessageAttachment[];
  replyTo:
    | (Pick<Message, 'id' | 'seq' | 'changeSeq' | 'authorId' | 'content' | 'deletedAt'> & {
        attachments: Pick<MessageAttachment, 'contentType'>[];
      })
    | null;
  forwardedFromMessage: Pick<Message, 'seq' | 'deletedAt'> | null;
};

function toQuoteDTO(quoted: NonNullable<MessageRow['replyTo']>): MessageQuoteDTO {
  const deleted = quoted.deletedAt !== null;
  const first = quoted.attachments[0];
  return {
    id: quoted.id,
    seq: quoted.seq,
    changeSeq: quoted.changeSeq,
    authorId: quoted.authorId,
    excerpt: deleted ? '' : messageExcerpt(quoted.content),
    attachmentCount: deleted ? 0 : quoted.attachments.length,
    attachmentKind: deleted || !first ? null : attachmentKind(first.contentType),
    deleted,
  };
}

function toOriginDTO(m: MessageRow): MessageOriginDTO | null {
  if (
    !m.forwardedFromAuthorId ||
    !m.forwardedFromChannelId ||
    m.forwardedFromChannelName === null ||
    !m.forwardedFromCreatedAt
  )
    return null;
  const original = m.forwardedFromMessage;
  const reachable = m.forwardedFromMessageId && original && !original.deletedAt;
  return {
    messageId: reachable ? m.forwardedFromMessageId : null,
    seq: reachable ? original.seq : null,
    authorId: m.forwardedFromAuthorId,
    channelId: m.forwardedFromChannelId,
    channelName: m.forwardedFromChannelName,
    createdAt: m.forwardedFromCreatedAt.toISOString(),
  };
}

export function toMessageDTO(m: MessageRow): MessageDTO {
  const deleted = m.deletedAt !== null;
  return {
    id: m.id,
    channelId: m.channelId,
    authorId: m.authorId,
    content: m.deletedAt ? '' : m.content,
    seq: m.seq,
    changeSeq: m.changeSeq,
    clientNonce: m.clientNonce,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt?.toISOString() ?? null,
    deleted: m.deletedAt !== null,
    attachments: m.deletedAt ? [] : m.attachments.map(toAttachmentDTO),
    replyTo: !deleted && m.replyTo ? toQuoteDTO(m.replyTo) : null,
    forwardedFrom: deleted ? null : toOriginDTO(m),
  };
}
