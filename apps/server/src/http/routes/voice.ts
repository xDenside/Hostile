import express, { Router } from 'express';
import { voiceTokenRequestSchema } from '@hostile/shared';
import type { AppContext } from '../../context.js';
import { errors } from '../../lib/errors.js';
import { parseBody, requireAuth } from '../middleware.js';

export function voiceRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/token', requireAuth, async (req, res) => {
    const limit = ctx.limiter.consume(`voice-token:user:${req.auth!.user.id}`, 30, 60_000);
    if (!limit.ok) throw errors.rateLimited(limit.retryAfterSec);
    const body = parseBody(voiceTokenRequestSchema, req.body);
    res.json(await ctx.voice.createJoinToken(req.auth!.user, body.channelId));
  });

  router.get('/status', requireAuth, (_req, res) => {
    res.json(ctx.voice.status());
  });

  return router;
}

export function livekitWebhookRoute(ctx: AppContext): Router {
  const router = Router();
  router.post(
    '/webhook',
    express.raw({ type: ['application/webhook+json', 'application/json'], limit: '256kb' }),
    async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      await ctx.voice.handleWebhook(raw, req.get('authorization'));
      res.status(200).json({ ok: true });
    },
  );
  return router;
}
