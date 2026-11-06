import type {
  AdminUserDTO,
  ArchivedChannelDTO,
  ChannelDTO,
  CreateChannelRequest,
  UpdateChannelRequest,
} from '@hostile/shared';
import type { AppContext } from '../context.js';
import type { Channel, User } from '../generated/prisma/client.js';
import { errors } from '../lib/errors.js';
import { toChannelDTO, toUserPublic } from '../lib/mappers.js';

export async function endPerson(ctx: AppContext, target: User) {
  const user = await ctx.db.user.update({
    where: { id: target.id },
    data: { disabledAt: target.disabledAt ?? new Date() },
  });
  await ctx.sessions.revokeAllForUser(target.id, 'disabled');
  ctx.sessions.events.emit('userDisabled', { userId: target.id });
  await ctx.voice.removeUserEverywhere(target.id);
  ctx.log.info({ userId: target.id }, 'person removed');
  ctx.realtime.toCommunity('member:upserted', toUserPublic(user));
  return toUserPublic(user);
}

export class AdminService {
  constructor(private readonly ctx: AppContext) {}

  async listUsers(): Promise<AdminUserDTO[]> {
    const [users, sessions] = await Promise.all([
      this.ctx.db.user.findMany({ where: { disabledAt: null }, orderBy: { createdAt: 'asc' } }),
      this.ctx.db.session.groupBy({
        by: ['userId'],
        where: { revokedAt: null },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(sessions.map((s) => [s.userId, s._count._all]));
    return users.map((u) => ({
      ...toUserPublic(u),
      createdAt: u.createdAt.toISOString(),
      activeSessions: counts.get(u.id) ?? 0,
    }));
  }

  async remove(owner: User, userId: string) {
    if (userId === owner.id) throw errors.forbidden('You cannot remove yourself.');
    const target = await this.ctx.db.user.findUnique({ where: { id: userId } });
    if (!target) throw errors.notFound('User');
    if (target.role === 'OWNER') throw errors.forbidden('The owner cannot be removed.');
    return endPerson(this.ctx, target);
  }

  async createChannel(input: CreateChannelRequest) {
    const max = await this.ctx.db.channel.aggregate({
      _max: { position: true },
      where: { archivedAt: null },
    });
    const channel = await this.ctx.db.channel.create({
      data: {
        name: input.name.trim(),
        type: input.type === 'voice' ? 'VOICE' : 'TEXT',
        position: (max._max.position ?? -1) + 1,
      },
    });
    const dto = toChannelDTO(channel);
    this.ctx.realtime.toCommunity('channel:upserted', dto);
    return dto;
  }

  async updateChannel(channelId: string, input: UpdateChannelRequest) {
    const existing = await this.ctx.db.channel.findUnique({ where: { id: channelId } });
    if (!existing || existing.archivedAt) throw errors.notFound('Channel');
    const channel = await this.ctx.db.channel.update({
      where: { id: channelId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
      },
    });
    const dto = toChannelDTO(channel);
    this.ctx.realtime.toCommunity('channel:upserted', dto);
    return dto;
  }

  async reorderChannels(channelIds: string[]): Promise<ChannelDTO[]> {
    const updated = await this.ctx.db.$transaction(async (tx) => {
      const current = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "channels" WHERE "archivedAt" IS NULL ORDER BY "id" FOR UPDATE`;
      const currentIds = new Set(current.map((c) => c.id));
      if (channelIds.length !== currentIds.size || channelIds.some((id) => !currentIds.has(id)))
        throw errors.conflict(
          'The channel list is out of date. It must list every channel exactly once; reload and try again.',
        );
      const rows: Channel[] = [];
      for (const [position, id] of channelIds.entries())
        rows.push(await tx.channel.update({ where: { id }, data: { position } }));
      return rows;
    });
    const dtos = updated.map(toChannelDTO);
    for (const dto of dtos) this.ctx.realtime.toCommunity('channel:upserted', dto);
    return dtos;
  }

  async archiveChannel(channelId: string) {
    const existing = await this.ctx.db.channel.findUnique({ where: { id: channelId } });
    if (!existing || existing.archivedAt) throw errors.notFound('Channel');
    await this.ctx.db.channel.update({
      where: { id: channelId },
      data: { archivedAt: new Date() },
    });
    if (existing.type === 'VOICE') await this.ctx.voice.closeChannelRoom(channelId);
    this.ctx.realtime.toCommunity('channel:removed', { id: channelId });
  }

  async listArchivedChannels(): Promise<ArchivedChannelDTO[]> {
    const channels = await this.ctx.db.channel.findMany({
      where: { archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
    });
    return channels.map((c) => ({ ...toChannelDTO(c), archivedAt: c.archivedAt!.toISOString() }));
  }

  async restoreChannel(channelId: string) {
    const existing = await this.ctx.db.channel.findUnique({ where: { id: channelId } });
    if (!existing?.archivedAt) throw errors.notFound('Channel');
    const max = await this.ctx.db.channel.aggregate({
      _max: { position: true },
      where: { archivedAt: null },
    });
    const channel = await this.ctx.db.channel.update({
      where: { id: channelId },
      data: { archivedAt: null, position: (max._max.position ?? -1) + 1 },
    });
    const dto = toChannelDTO(channel);
    this.ctx.realtime.toCommunity('channel:upserted', dto);
    return dto;
  }
}
