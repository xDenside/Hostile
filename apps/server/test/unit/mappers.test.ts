import { describe, expect, it } from 'vitest';
import { LIMITS } from '@hostile/shared';
import {
  toAttachmentDTO,
  toChannelDTO,
  toMessageDTO,
  toSelfUser,
  toUserPublic,
  type MessageRow,
} from '../../src/lib/mappers.js';
import type { Channel, MessageAttachment, User } from '../../src/generated/prisma/client.js';

const CREATED = new Date('2026-01-02T03:04:05.678Z');

function user(over: Partial<User> = {}): User {
  return {
    id: '0192d5b0-0000-7000-8000-000000000001',
    displayName: 'Алиса',
    avatarColor: '#2e2e2e',
    bannerColor: null,
    nameFont: 'default',
    nameEffect: 'none',
    nameColor: null,
    nameColor2: null,
    customStatus: null,
    avatarMediaId: null,
    bannerMediaId: null,
    role: 'MEMBER',
    disabledAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

function channel(over: Partial<Channel> = {}): Channel {
  return {
    id: '0192d5b0-1111-7000-8000-000000000001',
    name: 'general',
    type: 'TEXT',
    position: 0,
    changeCounter: 12,
    lastMessageSeq: 9,
    archivedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

function attachment(over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: '4f1c2a9e-5555-4000-8000-000000000001',
    channelId: channel().id,
    uploaderId: user().id,
    messageId: null,
    position: 0,
    contentType: 'image/png',
    fileName: 'cat.png',
    byteSize: 1234,
    width: 23,
    height: 17,
    createdAt: CREATED,
    ...over,
  };
}

function message(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '0192d5b0-2222-7000-8000-000000000001',
    channelId: channel().id,
    authorId: user().id,
    content: 'hello',
    seq: 7,
    changeSeq: 11,
    clientNonce: '0192d5b0-3333-7000-8000-000000000001',
    createdAt: CREATED,
    editedAt: null,
    deletedAt: null,
    replyToId: null,
    forwardedFromMessageId: null,
    forwardedFromAuthorId: null,
    forwardedFromChannelId: null,
    forwardedFromChannelName: null,
    forwardedFromCreatedAt: null,
    attachments: [],
    replyTo: null,
    forwardedFromMessage: null,
    ...over,
  };
}

describe('toUserPublic', () => {
  it('maps the database role onto the API role', () => {
    expect(toUserPublic(user({ role: 'OWNER' })).role).toBe('owner');
    expect(toUserPublic(user({ role: 'MEMBER' })).role).toBe('member');
  });

  it('flags disabled users', () => {
    expect(toUserPublic(user()).disabled).toBe(false);
    expect(toUserPublic(user({ disabledAt: CREATED })).disabled).toBe(true);
  });

  it('exposes only the public fields', () => {
    expect(toUserPublic(user())).toEqual({
      id: user().id,
      displayName: 'Алиса',
      avatarColor: '#2e2e2e',
      role: 'member',
      disabled: false,
      avatarUrl: null,
      bannerUrl: null,
      bannerColor: null,
      nameFont: 'default',
      nameEffect: 'none',
      nameColor: null,
      nameColor2: null,
      customStatus: null,
    });
  });

  it('points at the current images by id, and exposes the id only as a URL', () => {
    const mapped = toUserPublic(
      user({
        avatarMediaId: '4f1c2a9e-0000-4000-8000-000000000001',
        bannerMediaId: '4f1c2a9e-0000-4000-8000-000000000002',
      }),
    );
    expect(mapped.avatarUrl).toBe('/api/media/4f1c2a9e-0000-4000-8000-000000000001');
    expect(mapped.bannerUrl).toBe('/api/media/4f1c2a9e-0000-4000-8000-000000000002');
    expect(Object.keys(mapped)).not.toContain('avatarMediaId');
    expect(Object.keys(mapped)).not.toContain('bannerMediaId');
  });

  it('passes the name style through', () => {
    expect(
      toUserPublic(
        user({
          bannerColor: '#101010',
          nameFont: 'pixel',
          nameEffect: 'neon',
          nameColor: '#ff0000',
          nameColor2: '#00ff00',
        }),
      ),
    ).toMatchObject({
      bannerColor: '#101010',
      nameFont: 'pixel',
      nameEffect: 'neon',
      nameColor: '#ff0000',
      nameColor2: '#00ff00',
    });
  });

  it('passes a custom status through', () => {
    expect(toUserPublic(user({ customStatus: 'В игре' })).customStatus).toBe('В игре');
  });

  it('falls back when the database holds a font or effect this build does not know', () => {
    const mapped = toUserPublic(user({ nameFont: 'from-the-future', nameEffect: 'also-new' }));
    expect(mapped.nameFont).toBe('default');
    expect(mapped.nameEffect).toBe('none');
  });
});

describe('toSelfUser', () => {
  it('adds the creation timestamp as ISO-8601 and nothing else', () => {
    expect(toSelfUser(user())).toEqual({
      ...toUserPublic(user()),
      createdAt: CREATED.toISOString(),
    });
  });
});

describe('toChannelDTO', () => {
  it('maps the channel type and keeps the ordering fields', () => {
    expect(toChannelDTO(channel({ type: 'VOICE', position: 3 }))).toEqual({
      id: channel().id,
      name: 'general',
      type: 'voice',
      position: 3,
      lastMessageSeq: 9,
    });
    expect(toChannelDTO(channel()).type).toBe('text');
  });

  it('does not expose the internal change counter', () => {
    expect(Object.keys(toChannelDTO(channel()))).not.toContain('changeCounter');
  });
});

describe('toMessageDTO', () => {
  it('maps a live message with its sequence numbers', () => {
    expect(toMessageDTO(message())).toEqual({
      id: message().id,
      channelId: channel().id,
      authorId: user().id,
      content: 'hello',
      seq: 7,
      changeSeq: 11,
      clientNonce: message().clientNonce,
      createdAt: CREATED.toISOString(),
      editedAt: null,
      deleted: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
    });
  });

  it('keeps attachments in the order it was given them', () => {
    const first = attachment({ id: '4f1c2a9e-5555-4000-8000-00000000000b', position: 0 });
    const second = attachment({ id: '4f1c2a9e-5555-4000-8000-00000000000a', position: 1 });
    expect(
      toMessageDTO(message({ attachments: [first, second] })).attachments.map((a) => a.id),
    ).toEqual([first.id, second.id]);
  });

  it('shows a deleted message with no attachments, whatever the caller still holds', () => {
    const dto = toMessageDTO(message({ deletedAt: CREATED, attachments: [attachment()] }));
    expect(dto.attachments).toEqual([]);
  });

  it('blanks the content of a deleted message and flags it', () => {
    const dto = toMessageDTO(message({ content: 'secret', deletedAt: CREATED }));
    expect(dto.content).toBe('');
    expect(dto.deleted).toBe(true);
    expect(dto.seq).toBe(7);
  });

  it('reports edits as an ISO timestamp', () => {
    const edited = new Date('2026-01-02T04:00:00.000Z');
    expect(toMessageDTO(message({ editedAt: edited })).editedAt).toBe(edited.toISOString());
  });
});

describe('the quote on a reply', () => {
  const original = (over: Partial<NonNullable<MessageRow['replyTo']>> = {}) => ({
    id: '0192d5b0-2222-7000-8000-00000000000a',
    seq: 3,
    changeSeq: 5,
    authorId: '0192d5b0-0000-7000-8000-00000000000a',
    content: 'the original',
    deletedAt: null,
    attachments: [],
    ...over,
  });

  it('carries who and what, and never a name', () => {
    expect(toMessageDTO(message({ replyTo: original() })).replyTo).toEqual({
      id: original().id,
      seq: 3,
      changeSeq: 5,
      authorId: original().authorId,
      excerpt: 'the original',
      attachmentCount: 0,
      attachmentKind: null,
      deleted: false,
    });
  });

  it('is cut on the server, so a long message costs a page of replies nothing', () => {
    const quote = toMessageDTO(
      message({ replyTo: original({ content: 'word '.repeat(2000) }) }),
    ).replyTo!;
    expect(Array.from(quote.excerpt).length).toBeLessThanOrEqual(LIMITS.replyExcerptMax);
    expect(quote.excerpt.endsWith('…')).toBe(true);
  });

  it('says what kind of file the first one is, and how many there are', () => {
    const quote = toMessageDTO(
      message({
        replyTo: original({
          content: '',
          attachments: [{ contentType: 'video/mp4' }, { contentType: 'image/png' }],
        }),
      }),
    ).replyTo!;
    expect(quote.attachmentCount).toBe(2);
    expect(quote.attachmentKind).toBe('video');
    expect(quote.excerpt).toBe('');
  });

  it('says nothing of a deleted original but that it was deleted, whatever the row still holds', () => {
    const quote = toMessageDTO(
      message({
        replyTo: original({
          content: 'secret',
          deletedAt: CREATED,
          attachments: [{ contentType: 'image/png' }],
        }),
      }),
    ).replyTo!;
    expect(quote).toMatchObject({
      deleted: true,
      excerpt: '',
      attachmentCount: 0,
      attachmentKind: null,
    });
  });

  it('goes with the message when the message itself is deleted', () => {
    expect(toMessageDTO(message({ deletedAt: CREATED, replyTo: original() })).replyTo).toBeNull();
  });
});

describe('the origin of a forward', () => {
  const originalId = '0192d5b0-2222-7000-8000-00000000000a';
  const forward = (over: Partial<MessageRow> = {}) =>
    message({
      forwardedFromMessageId: originalId,
      forwardedFromAuthorId: '0192d5b0-0000-7000-8000-00000000000a',
      forwardedFromChannelId: '0192d5b0-1111-7000-8000-00000000000a',
      forwardedFromChannelName: 'old-name',
      forwardedFromCreatedAt: CREATED,
      forwardedFromMessage: { seq: 4, deletedAt: null },
      ...over,
    });

  it('says where it came from, with the channel name it had then', () => {
    expect(toMessageDTO(forward()).forwardedFrom).toEqual({
      messageId: originalId,
      seq: 4,
      authorId: '0192d5b0-0000-7000-8000-00000000000a',
      channelId: '0192d5b0-1111-7000-8000-00000000000a',
      channelName: 'old-name',
      createdAt: CREATED.toISOString(),
    });
  });

  it('leaves nothing to jump to once the original is deleted or its row is gone', () => {
    for (const row of [
      forward({ forwardedFromMessage: { seq: 4, deletedAt: CREATED } }),
      forward({ forwardedFromMessageId: null, forwardedFromMessage: null }),
    ]) {
      const origin = toMessageDTO(row).forwardedFrom!;
      expect(origin.messageId).toBeNull();
      expect(origin.seq).toBeNull();
      expect(origin.channelName).toBe('old-name');
    }
  });

  it('goes with the message when the forward itself is deleted', () => {
    expect(toMessageDTO(forward({ deletedAt: CREATED })).forwardedFrom).toBeNull();
  });
});

describe('toAttachmentDTO', () => {
  it('exposes the public fields and a URL built from the id', () => {
    expect(toAttachmentDTO(attachment())).toEqual({
      id: attachment().id,
      kind: 'image',
      url: `/api/attachments/${attachment().id}`,
      contentType: 'image/png',
      fileName: 'cat.png',
      byteSize: 1234,
      width: 23,
      height: 17,
    });
  });

  it('calls every video type a video, with or without a measurement', () => {
    for (const contentType of ['video/mp4', 'video/quicktime', 'video/webm']) {
      const dto = toAttachmentDTO(attachment({ contentType, width: null, height: null }));
      expect(dto.kind, contentType).toBe('video');
      expect(dto.width, contentType).toBeNull();
    }
  });
});
