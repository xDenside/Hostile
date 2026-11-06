import {
  LIMITS,
  type ChangesDTO,
  type MessagePageDTO,
  type SendMessageResponse,
} from '@hostile/shared';
import type { AppContext } from '../context.js';
import { isUniqueViolation, type Tx } from '../db.js';
import type { Channel, User } from '../generated/prisma/client.js';
import { errors } from '../lib/errors.js';
import { MESSAGE_INCLUDE, toChannelDTO, toMessageDTO, type MessageRow } from '../lib/mappers.js';

export class ChatService {
  constructor(private readonly ctx: AppContext) {}

  async openChannelOrThrow(channelId: string): Promise<Channel> {
    const channel = await this.ctx.db.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.archivedAt) throw errors.notFound('Channel');
    return channel;
  }

  private async nextChangeSeq(tx: Tx, channelId: string, isCreate: boolean): Promise<number> {
    const rows = isCreate
      ? await tx.$queryRaw<{ changeCounter: number }[]>`
          UPDATE "channels"
          SET "changeCounter" = "changeCounter" + 1, "lastMessageSeq" = "changeCounter" + 1, "updatedAt" = now()
          WHERE "id" = ${channelId}::uuid AND "archivedAt" IS NULL
          RETURNING "changeCounter"`
      : await tx.$queryRaw<{ changeCounter: number }[]>`
          UPDATE "channels"
          SET "changeCounter" = "changeCounter" + 1, "updatedAt" = now()
          WHERE "id" = ${channelId}::uuid AND "archivedAt" IS NULL
          RETURNING "changeCounter"`;
    const row = rows[0];
    if (!row) throw errors.notFound('Channel');
    return Number(row.changeCounter);
  }

  async history(
    channelId: string,
    before: number | undefined,
    limit: number,
  ): Promise<MessagePageDTO> {
    await this.openChannelOrThrow(channelId);
    return this.ctx.db.$transaction(
      async (tx) => {
        const channel = await tx.channel.findUniqueOrThrow({ where: { id: channelId } });
        const rows = await tx.message.findMany({
          where: { channelId, deletedAt: null, ...(before ? { seq: { lt: before } } : {}) },
          orderBy: { seq: 'desc' },
          take: limit + 1,
          include: MESSAGE_INCLUDE,
        });
        const hasOlder = rows.length > limit;
        const page = rows.slice(0, limit).reverse();
        return { messages: page.map(toMessageDTO), hasOlder, syncSeq: channel.changeCounter };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async changes(channelId: string, since: number): Promise<ChangesDTO> {
    await this.openChannelOrThrow(channelId);
    return this.ctx.db.$transaction(
      async (tx) => {
        const channel = await tx.channel.findUniqueOrThrow({ where: { id: channelId } });
        if (since > channel.changeCounter) {
          return { changes: [], syncSeq: channel.changeCounter, reset: true };
        }
        const rows = await tx.message.findMany({
          where: { channelId, changeSeq: { gt: since } },
          orderBy: { changeSeq: 'asc' },
          take: LIMITS.changesPageMax + 1,
          include: MESSAGE_INCLUDE,
        });
        if (rows.length > LIMITS.changesPageMax) {
          return { changes: [], syncSeq: channel.changeCounter, reset: true };
        }
        return { changes: rows.map(toMessageDTO), syncSeq: channel.changeCounter, reset: false };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private consumeSendLimit(user: User): void {
    const limit = this.ctx.limiter.consume(`send:user:${user.id}`, 30, 10_000);
    if (!limit.ok) throw errors.rateLimited(limit.retryAfterSec);
  }

  private findByNonce(authorId: string, clientNonce: string) {
    return this.ctx.db.message.findUnique({
      where: { authorId_clientNonce: { authorId, clientNonce } },
      include: MESSAGE_INCLUDE,
    });
  }

  private async hasUnseenBelow(tx: Tx, userId: string, channelId: string, seq: number) {
    const state = await tx.readState.findUnique({
      where: { userId_channelId: { userId, channelId } },
      select: { lastReadSeq: true },
    });
    const unseen = await tx.message.findFirst({
      where: {
        channelId,
        deletedAt: null,
        authorId: { not: userId },
        seq: { gt: state?.lastReadSeq ?? 0, lt: seq },
      },
      select: { id: true },
    });
    return !!unseen;
  }

  private async advanceReadState(tx: Tx, userId: string, channelId: string, seq: number) {
    await tx.$executeRaw`
      INSERT INTO "read_states" ("userId", "channelId", "lastReadSeq", "updatedAt")
      VALUES (${userId}::uuid, ${channelId}::uuid, ${seq}, now())
      ON CONFLICT ("userId", "channelId")
      DO UPDATE SET "lastReadSeq" = GREATEST("read_states"."lastReadSeq", EXCLUDED."lastReadSeq"), "updatedAt" = now()`;
  }

  private announceCreated(
    author: User,
    message: MessageRow,
    readUpToIt = true,
  ): SendMessageResponse {
    const dto = toMessageDTO(message);
    this.ctx.realtime.toCommunity('message:created', dto);
    if (readUpToIt) {
      this.ctx.realtime.toUser(author.id, 'read:updated', {
        channelId: message.channelId,
        lastReadSeq: message.seq,
      });
    }
    return { message: dto, duplicate: false };
  }

  async send(
    author: User,
    channelId: string,
    content: string,
    clientNonce: string,
    attachmentIds: string[] = [],
    replyToId?: string,
  ): Promise<SendMessageResponse> {
    this.consumeSendLimit(author);
    await this.openChannelOrThrow(channelId);

    const existing = await this.findByNonce(author.id, clientNonce);
    if (existing) return this.duplicateResult(existing, channelId);

    let message: MessageRow;
    try {
      message = await this.ctx.db.$transaction(async (tx) => {
        const seq = await this.nextChangeSeq(tx, channelId, true);
        if (replyToId) {
          const target = await tx.message.findFirst({
            where: { id: replyToId, channelId },
            select: { id: true },
          });
          if (!target) throw errors.replyTargetInvalid();
        }
        const created = await tx.message.create({
          data: {
            channelId,
            authorId: author.id,
            content,
            seq,
            changeSeq: seq,
            clientNonce,
            replyToId: replyToId ?? null,
          },
        });
        await this.claimAttachments(tx, attachmentIds, {
          messageId: created.id,
          uploaderId: author.id,
          channelId,
        });
        await this.advanceReadState(tx, author.id, channelId, seq);
        return tx.message.findUniqueOrThrow({
          where: { id: created.id },
          include: MESSAGE_INCLUDE,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const winner = await this.findByNonce(author.id, clientNonce);
        if (winner) return this.duplicateResult(winner, channelId);
      }
      throw err;
    }

    return this.announceCreated(author, message);
  }

  async forward(
    actor: User,
    messageId: string,
    channelId: string,
    clientNonce: string,
  ): Promise<SendMessageResponse> {
    this.consumeSendLimit(actor);
    await this.openChannelOrThrow(channelId);

    const existing = await this.findByNonce(actor.id, clientNonce);
    if (existing) return this.duplicateResult(existing, channelId);

    const source = await this.ctx.db.message.findUnique({
      where: { id: messageId },
      include: {
        attachments: { orderBy: { position: 'asc' } },
        channel: { select: { name: true, archivedAt: true } },
      },
    });
    if (!source || source.deletedAt) throw errors.notFound('Message');
    if (source.channel.archivedAt) throw errors.notFound('Channel');
    if (source.channelId === channelId) throw errors.forwardSameChannel();

    const origin = source.forwardedFromAuthorId
      ? {
          forwardedFromMessageId: source.forwardedFromMessageId,
          forwardedFromAuthorId: source.forwardedFromAuthorId,
          forwardedFromChannelId: source.forwardedFromChannelId,
          forwardedFromChannelName: source.forwardedFromChannelName,
          forwardedFromCreatedAt: source.forwardedFromCreatedAt,
        }
      : {
          forwardedFromMessageId: source.id,
          forwardedFromAuthorId: source.authorId,
          forwardedFromChannelId: source.channelId,
          forwardedFromChannelName: source.channel.name,
          forwardedFromCreatedAt: source.createdAt,
        };

    const fileIds = await this.ctx.attachments.duplicateFiles(source.attachments);
    let forwarded: { message: MessageRow; readUpToIt: boolean };
    try {
      forwarded = await this.ctx.db.$transaction(async (tx) => {
        const seq = await this.nextChangeSeq(tx, channelId, true);
        const live = await tx.message.findFirst({
          where: { id: source.id, deletedAt: null },
          select: { id: true },
        });
        if (!live) throw errors.notFound('Message');
        const created = await tx.message.create({
          data: {
            channelId,
            authorId: actor.id,
            content: source.content,
            seq,
            changeSeq: seq,
            clientNonce,
            ...origin,
          },
        });
        await tx.messageAttachment.createMany({
          data: source.attachments.map((file, index) => ({
            id: fileIds[index]!,
            channelId,
            uploaderId: actor.id,
            messageId: created.id,
            position: file.position,
            contentType: file.contentType,
            fileName: file.fileName,
            byteSize: file.byteSize,
            width: file.width,
            height: file.height,
          })),
        });
        const readUpToIt = !(await this.hasUnseenBelow(tx, actor.id, channelId, seq));
        if (readUpToIt) await this.advanceReadState(tx, actor.id, channelId, seq);
        return {
          message: await tx.message.findUniqueOrThrow({
            where: { id: created.id },
            include: MESSAGE_INCLUDE,
          }),
          readUpToIt,
        };
      });
    } catch (err) {
      await this.ctx.attachments.removeFiles(fileIds);
      if (isUniqueViolation(err)) {
        const winner = await this.findByNonce(actor.id, clientNonce);
        if (winner) return this.duplicateResult(winner, channelId);
      }
      throw err;
    }

    return this.announceCreated(actor, forwarded.message, forwarded.readUpToIt);
  }

  private async claimAttachments(
    tx: Tx,
    ids: string[],
    claim: { messageId: string; uploaderId: string; channelId: string },
  ): Promise<void> {
    if (ids.length === 0) return;
    const taken = await tx.$executeRaw`
      UPDATE "message_attachments" AS a
      SET "messageId" = ${claim.messageId}::uuid, "position" = listed.ordinal - 1
      FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS listed(id, ordinal)
      WHERE a."id" = listed.id
        AND a."uploaderId" = ${claim.uploaderId}::uuid
        AND a."channelId" = ${claim.channelId}::uuid
        AND a."messageId" IS NULL`;
    if (taken !== ids.length) throw errors.attachmentsNotClaimable();
  }

  private duplicateResult(existing: MessageRow, channelId: string): SendMessageResponse {
    if (existing.channelId !== channelId)
      throw errors.conflict('This message id was already used in another channel.');
    return { message: toMessageDTO(existing), duplicate: true };
  }

  async edit(actor: User, messageId: string, content: string) {
    const message = await this.ctx.db.message.findUnique({
      where: { id: messageId },
      include: MESSAGE_INCLUDE,
    });
    if (!message || message.deletedAt) throw errors.notFound('Message');
    if (message.authorId !== actor.id)
      throw errors.forbidden('You can only edit your own messages.');
    if (message.forwardedFromAuthorId)
      throw errors.forbidden('A forwarded message cannot be edited.');
    if (!content && message.attachments.length === 0) throw errors.emptyMessage();
    if (message.content === content) return toMessageDTO(message);
    const updated = await this.ctx.db.$transaction(async (tx) => {
      const changeSeq = await this.nextChangeSeq(tx, message.channelId, false);
      const rows = await tx.message.updateMany({
        where: { id: messageId, deletedAt: null },
        data: { content, editedAt: new Date(), changeSeq },
      });
      if (rows.count !== 1) throw errors.notFound('Message');
      return tx.message.findUniqueOrThrow({
        where: { id: messageId },
        include: MESSAGE_INCLUDE,
      });
    });
    const dto = toMessageDTO(updated);
    this.ctx.realtime.toCommunity('message:updated', dto);
    return dto;
  }

  async remove(actor: User, messageId: string) {
    const message = await this.ctx.db.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt) throw errors.notFound('Message');
    if (message.authorId !== actor.id && actor.role !== 'OWNER') {
      throw errors.forbidden('You can only delete your own messages.');
    }
    const { updated, attachmentIds } = await this.ctx.db.$transaction(async (tx) => {
      const changeSeq = await this.nextChangeSeq(tx, message.channelId, false);
      const rows = await tx.message.updateMany({
        where: { id: messageId, deletedAt: null },
        data: {
          content: '',
          deletedAt: new Date(),
          changeSeq,
          replyToId: null,
          forwardedFromMessageId: null,
          forwardedFromAuthorId: null,
          forwardedFromChannelId: null,
          forwardedFromChannelName: null,
          forwardedFromCreatedAt: null,
        },
      });
      if (rows.count !== 1) throw errors.notFound('Message');
      const attachments = await tx.messageAttachment.findMany({
        where: { messageId },
        select: { id: true },
      });
      await tx.messageAttachment.deleteMany({ where: { messageId } });
      return {
        updated: await tx.message.findUniqueOrThrow({
          where: { id: messageId },
          include: MESSAGE_INCLUDE,
        }),
        attachmentIds: attachments.map((a) => a.id),
      };
    });
    await this.ctx.attachments.removeFiles(attachmentIds);
    const dto = toMessageDTO(updated);
    this.ctx.realtime.toCommunity('message:updated', dto);
    return dto;
  }

  async markRead(user: User, channelId: string, seq: number) {
    const channel = await this.openChannelOrThrow(channelId);
    let clamped = Math.min(seq, channel.lastMessageSeq);
    if (clamped < channel.lastMessageSeq) {
      const unseen = await this.ctx.db.message.findFirst({
        where: { channelId, deletedAt: null, seq: { gt: clamped } },
        select: { id: true },
      });
      if (!unseen) clamped = channel.lastMessageSeq;
    }
    const rows = await this.ctx.db.$queryRaw<{ lastReadSeq: number }[]>`
      INSERT INTO "read_states" ("userId", "channelId", "lastReadSeq", "updatedAt")
      VALUES (${user.id}::uuid, ${channelId}::uuid, ${clamped}, now())
      ON CONFLICT ("userId", "channelId")
      DO UPDATE SET "lastReadSeq" = GREATEST("read_states"."lastReadSeq", EXCLUDED."lastReadSeq"), "updatedAt" = now()
      RETURNING "lastReadSeq"`;
    const lastReadSeq = Number(rows[0]?.lastReadSeq ?? clamped);
    this.ctx.realtime.toUser(user.id, 'read:updated', { channelId, lastReadSeq });
    return { channelId, lastReadSeq };
  }

  async channelsForBootstrap() {
    const channels = await this.ctx.db.channel.findMany({
      where: { archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return channels.map(toChannelDTO);
  }
}
