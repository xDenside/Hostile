import { Router } from 'express';
import { BRAND, type BootstrapDTO, type HealthDTO, type PublicConfigDTO } from '@hostile/shared';
import type { AppContext } from '../../context.js';
import { ChatService } from '../../chat/service.js';
import { toSelfUser, toUserPublic } from '../../lib/mappers.js';
import { requireAuth } from '../middleware.js';

export const APP_VERSION = '0.1.0';

const HEALTH_CACHE_MS = 5_000;

type HealthProbe = Pick<HealthDTO, 'database' | 'media'>;

export function metaRoutes(ctx: AppContext): Router {
  const router = Router();
  const chat = new ChatService(ctx);

  let cached: { at: number; probe: HealthProbe } | null = null;
  let inFlight: Promise<HealthProbe> | null = null;

  const mediaHealth = async (): Promise<HealthDTO['media']> => {
    if (!ctx.voice.configured) return 'unconfigured';
    const { mediaReachable, checkedAt } = ctx.voice.status();
    const age = checkedAt ? Date.now() - Date.parse(checkedAt) : Infinity;
    if (age < 2 * ctx.config.livekit.reconcileIntervalMs)
      return mediaReachable ? 'ok' : 'unreachable';
    return ctx.voice.ping();
  };

  const probeHealth = async (): Promise<HealthProbe> => {
    let database: HealthDTO['database'] = 'ok';
    try {
      await ctx.db.$queryRaw`SELECT 1`;
    } catch {
      database = 'error';
    }
    return { database, media: await mediaHealth() };
  };

  const health = (): Promise<HealthProbe> => {
    if (cached && Date.now() - cached.at < HEALTH_CACHE_MS) return Promise.resolve(cached.probe);
    inFlight ??= probeHealth()
      .then((probe) => {
        cached = { at: Date.now(), probe };
        return probe;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  router.get('/health', async (_req, res) => {
    const { database, media } = await health();
    const body: HealthDTO = {
      status: database === 'ok' && media !== 'unreachable' ? 'ok' : 'degraded',
      database,
      media,
      version: APP_VERSION,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
    };
    res.status(database === 'ok' ? 200 : 503).json(body);
  });

  router.get('/public-config', (_req, res) => {
    const body: PublicConfigDTO = {
      appName: BRAND.displayName,
      communityName: ctx.config.communityName,
      environment: ctx.config.env,
      livekitUrl: ctx.config.livekit.configured ? ctx.config.livekit.publicUrl : null,
      apiVersion: 1,
    };
    res.json(body);
  });

  router.get('/bootstrap', requireAuth, async (req, res) => {
    const user = req.auth!.user;
    const [channels, readStates, members] = await Promise.all([
      chat.channelsForBootstrap(),
      ctx.db.readState.findMany({ where: { userId: user.id } }),
      ctx.db.user.findMany({ orderBy: { displayName: 'asc' } }),
    ]);
    const body: BootstrapDTO = {
      self: toSelfUser(user),
      community: { name: ctx.config.communityName },
      channels,
      readStates: readStates.map((r) => ({ channelId: r.channelId, lastReadSeq: r.lastReadSeq })),
      members: members.map(toUserPublic),
      onlineUserIds: ctx.realtime.onlineUserIds(),
      voice: ctx.voice.status(),
      serverTime: new Date().toISOString(),
    };
    res.json(body);
  });

  return router;
}
