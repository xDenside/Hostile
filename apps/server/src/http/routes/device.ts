import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import {
  bindDevice,
  DeviceChallenges,
  deviceToken,
  isDeviceKey,
  signatureHolds,
} from '../../auth/device.js';
import { sha256Hex } from '../../auth/crypto.js';
import { errors } from '../../lib/errors.js';
import { parseBody } from '../middleware.js';
import { sessionCookie } from './join.js';

const SIGN_INS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

const signInSchema = z.strictObject({
  deviceKey: z.string().max(300),
  challenge: z.string().max(200),
  signature: z.string().max(200),
});

const claimSchema = z.strictObject({
  token: z.string().min(1).max(200),
  deviceKey: z.string().max(300),
});

export function deviceRoutes(ctx: AppContext): Router {
  const router = Router();
  const challenges = new DeviceChallenges(ctx.config.sessionSecret);
  const secret = ctx.config.sessionSecret;

  const limited: RequestHandler = (req, _res, next) => {
    if (ctx.config.gatewayToken && !req.fromGateway)
      return next(errors.forbidden('This takes the room code.'));
    const limit = ctx.limiter.consume(
      `device:${req.ip ?? 'unknown'}`,
      SIGN_INS_PER_MINUTE,
      MINUTE_MS,
    );
    if (!limit.ok) return next(errors.rateLimited(limit.retryAfterSec));
    next();
  };

  router.post('/challenge', limited, (_req, res) => {
    res.json({ challenge: challenges.issue() });
  });

  router.post('/sign-in', limited, async (req, res) => {
    const body = parseBody(signInSchema, req.body);
    if (!isDeviceKey(body.deviceKey) || !challenges.consume(body.challenge))
      throw errors.sessionExpired();
    if (!signatureHolds(body.deviceKey, body.challenge, body.signature))
      throw errors.sessionExpired();
    const session = await ctx.db.session.findUnique({
      where: { deviceKey: body.deviceKey },
      include: { user: true },
    });
    if (!session || session.revokedAt) throw errors.sessionExpired();
    if (session.user.disabledAt) throw errors.accountDisabled();
    const token = deviceToken(secret, session.id);
    if (session.tokenHash !== sha256Hex(token)) throw errors.sessionExpired();
    res.append('Set-Cookie', sessionCookie(ctx, token));
    res.json({ ok: true });
  });

  router.post('/claim', limited, async (req, res) => {
    const body = parseBody(claimSchema, req.body);
    if (!isDeviceKey(body.deviceKey)) throw errors.sessionExpired();
    const session = await ctx.sessions.findByToken(body.token);
    if (!session) throw errors.sessionExpired();
    if (session.user.disabledAt) throw errors.accountDisabled();
    const fresh = await ctx.sessions.create(session.user, session.client, req.get('user-agent'));
    const token = await bindDevice(ctx.db, secret, fresh.session.id, body.deviceKey);
    if (ctx.config.isProduction) await ctx.sessions.revoke(session.id, 'revoked');
    res.append('Set-Cookie', sessionCookie(ctx, token));
    res.json({ ok: true });
  });

  return router;
}
