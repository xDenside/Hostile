import { randomUUID } from 'node:crypto';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { stringifySetCookie } from 'cookie';
import { joinAskSchema, type JoinAskResponse, type JoinStatus } from '@hostile/shared';
import { csrfTokenFor } from '../../auth/access-token.js';
import { bindDevice, isDeviceKey } from '../../auth/device.js';
import { defaultAvatarColor } from '../../auth/service.js';
import type { AppContext } from '../../context.js';
import type { Session, User } from '../../generated/prisma/client.js';
import { errors } from '../../lib/errors.js';
import { toSelfUser, toUserPublic } from '../../lib/mappers.js';
import {
  checkProfileImage,
  imageTooLarge,
  PROFILE_MEDIA_MAX_BYTES,
  setProfileImage,
} from '../../media/profile-media.js';
import { parseBody } from '../middleware.js';

const PICTURES_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
const readPicture = express.raw({
  limit: PROFILE_MEDIA_MAX_BYTES.avatar,
  type: () => true,
  inflate: false,
});

export const COOKIE_NEVER_ENDS = new Date('9999-12-31T23:59:59Z');

export function sessionCookie(ctx: AppContext, token: string): string {
  return stringifySetCookie({
    name: ctx.config.cookie.name,
    value: token,
    httpOnly: true,
    secure: ctx.config.cookie.secure,
    sameSite: 'lax',
    path: '/',
    expires: COOKIE_NEVER_ENDS,
  });
}

const vouchedFor =
  (ctx: AppContext): RequestHandler =>
  (req, _res, next) => {
    if (ctx.config.gatewayToken && !req.fromGateway)
      return next(errors.forbidden('Asking to join takes the room code.'));
    next();
  };

export async function letIn(ctx: AppContext, requestId: string) {
  const { nickname, picture, userAgent, deviceKey } = ctx.joinRequests.claim(requestId);
  const id = randomUUID();
  let user = await ctx.db.user.create({
    data: { id, displayName: nickname, avatarColor: defaultAvatarColor(id), role: 'MEMBER' },
  });
  if (picture) user = await setProfileImage(ctx.db, ctx.log, id, 'avatar', picture.bytes);
  const created = await ctx.sessions.create(user, 'WEB', userAgent);
  const { session } = created;
  const token = deviceKey
    ? await bindDevice(ctx.db, ctx.config.sessionSecret, session.id, deviceKey)
    : created.token;
  ctx.joinRequests.admitted(requestId, { token, sessionId: session.id, userId: id });
  ctx.log.info({ userId: id }, 'let in');
  ctx.realtime.toCommunity('member:upserted', toUserPublic(user));
  return { user, session, token };
}

export function joinRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(vouchedFor(ctx));

  const admittedBody = (
    user: User,
    session: Session,
  ): Extract<JoinStatus, { status: 'admitted' }> => ({
    status: 'admitted',
    user: toSelfUser(user),
    csrfToken: csrfTokenFor(ctx.config.sessionSecret, session.id),
  });

  const respondAdmitted = (res: Response, token: string, user: User, session: Session) => {
    res.append('Set-Cookie', sessionCookie(ctx, token));
    res.json(admittedBody(user, session));
  };

  router.post('/', async (req: Request, res) => {
    const body = parseBody(joinAskSchema, req.body);
    if (req.auth) return res.json(admittedBody(req.auth.user, req.auth.session));
    const address = req.ip ?? 'unknown';
    const userAgent = req.get('user-agent');
    const asked = ctx.joinRequests.ask({
      nickname: body.nickname,
      address,
      picture: body.picture === true && !ctx.config.joinAutoAdmit,
      ...(body.deviceKey && isDeviceKey(body.deviceKey) ? { deviceKey: body.deviceKey } : {}),
      ...(userAgent ? { userAgent } : {}),
    });
    if (ctx.config.joinAutoAdmit) {
      const { user, session, token } = await letIn(ctx, asked.id);
      ctx.joinRequests.cancel(asked.ticket);
      res.append('Set-Cookie', sessionCookie(ctx, token));
      return res.json(admittedBody(user, session) satisfies JoinAskResponse);
    }
    const answer: JoinAskResponse = { ticket: asked.ticket };
    res.status(201).json(answer);
  });

  router.put('/:ticket/picture', (req, res, next) => {
    const ticket = String(req.params.ticket);
    if (!ctx.joinRequests.expectsPicture(ticket)) throw errors.notFound('Request');
    const limit = ctx.limiter.consume(
      `join-picture:${req.ip ?? 'unknown'}`,
      PICTURES_PER_HOUR,
      HOUR_MS,
    );
    if (!limit.ok) throw errors.rateLimited(limit.retryAfterSec);
    readPicture(req, res, (err?: unknown) => {
      if ((err as { type?: string } | undefined)?.type === 'entity.too.large')
        return next(imageTooLarge('avatar'));
      if (err) return next(err);
      try {
        const image = checkProfileImage(req.body);
        ctx.joinRequests.setPicture(ticket, {
          bytes: req.body as Buffer,
          contentType: image.type,
        });
        res.status(204).end();
      } catch (problem) {
        ctx.joinRequests.cancel(ticket);
        next(problem);
      }
    });
  });

  router.get('/:ticket', async (req, res) => {
    const answer = ctx.joinRequests.look(String(req.params.ticket));
    if (!answer) return res.json({ status: 'unknown' } satisfies JoinStatus);
    if (answer.kind === 'waiting') return res.json({ status: 'waiting' } satisfies JoinStatus);
    if (answer.kind === 'turned-away')
      return res.json({ status: 'turned-away' } satisfies JoinStatus);
    const session = await ctx.db.session.findUnique({
      where: { id: answer.sessionId },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.user.disabledAt)
      return res.json({ status: 'unknown' } satisfies JoinStatus);
    respondAdmitted(res, answer.token, session.user, session);
  });

  router.delete('/:ticket', (req, res) => {
    ctx.joinRequests.cancel(String(req.params.ticket));
    res.status(204).end();
  });

  return router;
}

export function joinPictureRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/:key', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const picture = ctx.joinRequests.picture(String(req.params.key));
    if (!picture) throw errors.notFound('Image');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Type', picture.contentType);
    res.send(picture.bytes);
  });
  return router;
}
