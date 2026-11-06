import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { stringifySetCookie } from 'cookie';
import {
  idSchema,
  ownerSessionRequestSchema,
  profileMediaKindSchema,
  refreshRequestSchema,
  updateProfileRequestSchema,
  type AccessTokenResponse,
  type DesktopAuthResponse,
  type SessionResponse,
  type WebAuthResponse,
} from '@hostile/shared';
import type { AppContext } from '../../context.js';
import { csrfTokenFor } from '../../auth/access-token.js';
import { endPerson } from '../../admin/service.js';
import { AuthService } from '../../auth/service.js';
import type { Session, User } from '../../generated/prisma/client.js';
import { errors } from '../../lib/errors.js';
import { toSelfUser, toSessionInfoDTO, toUserPublic } from '../../lib/mappers.js';
import {
  clearProfileImage,
  imageTooLarge,
  PROFILE_MEDIA_MAX_BYTES,
  setProfileImage,
} from '../../media/profile-media.js';
import { parseBody, parseQuery, readSessionCookie, requireAuth } from '../middleware.js';
import { sessionCookie } from './join.js';

const IMAGE_UPLOADS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

const imageBodyParser = (limit: number) => express.raw({ limit, type: () => true, inflate: false });
const IMAGE_BODY_PARSERS = {
  avatar: imageBodyParser(PROFILE_MEDIA_MAX_BYTES.avatar),
  banner: imageBodyParser(PROFILE_MEDIA_MAX_BYTES.banner),
};

export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = new AuthService(ctx);

  const clearSessionCookie = (res: Response) => {
    res.append(
      'Set-Cookie',
      stringifySetCookie({
        name: ctx.config.cookie.name,
        value: '',
        httpOnly: true,
        secure: ctx.config.cookie.secure,
        sameSite: 'lax',
        path: '/',
        expires: new Date(0),
      }),
    );
  };

  const respondWithSession = (
    res: Response,
    user: User,
    session: Session,
    token: string,
    status = 200,
  ) => {
    if (session.client === 'DESKTOP') {
      const access = auth.accessTokenFor(session);
      const body: DesktopAuthResponse = {
        user: toSelfUser(user),
        refreshToken: token,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
      };
      res.status(status).json(body);
      return;
    }
    res.append('Set-Cookie', sessionCookie(ctx, token));
    const body: WebAuthResponse = {
      user: toSelfUser(user),
      csrfToken: csrfTokenFor(ctx.config.sessionSecret, session.id),
    };
    res.status(status).json(body);
  };

  const ua = (req: Request) => req.get('user-agent') ?? undefined;

  const respondWithProfile = (res: Response, user: User) => {
    ctx.realtime.toCommunity('member:upserted', toUserPublic(user));
    res.json({ user: toSelfUser(user) });
  };

  router.post('/owner', async (req, res) => {
    if (req.fromGateway) throw errors.forbidden('That is not the secret of this room.');
    const body = parseBody(ownerSessionRequestSchema, req.body);
    const { user, session, token } = await auth.ownerSession(
      body.secret,
      body.client === 'desktop' ? 'DESKTOP' : 'WEB',
      ua(req),
    );
    respondWithSession(res, user, session, token);
  });

  router.post('/refresh', async (req, res) => {
    const body = parseBody(refreshRequestSchema, req.body);
    const result = await auth.refresh(body.refreshToken, req.ip ?? 'unknown');
    const response: AccessTokenResponse = {
      user: toSelfUser(result.user),
      accessToken: result.token,
      accessTokenExpiresAt: result.expiresAt.toISOString(),
    };
    res.json(response);
  });

  router.get('/session', requireAuth, (req, res) => {
    const { user, session, via } = req.auth!;
    const body: SessionResponse = {
      user: toSelfUser(user),
      csrfToken: via === 'cookie' ? csrfTokenFor(ctx.config.sessionSecret, session.id) : null,
    };
    res.json(body);
  });

  router.post('/logout', async (req, res) => {
    if (req.auth) {
      await ctx.sessions.revoke(req.auth.session.id, 'logout');
    } else if (typeof req.body?.refreshToken === 'string') {
      const session = await ctx.sessions.findByToken(req.body.refreshToken);
      if (session) await ctx.sessions.revoke(session.id, 'logout');
    } else {
      const cookieToken = readSessionCookie(ctx, req.headers.cookie);
      const session = cookieToken ? await ctx.sessions.findByToken(cookieToken) : null;
      if (session) await ctx.sessions.revoke(session.id, 'logout');
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.post('/logout-others', requireAuth, async (req, res) => {
    const ids = await ctx.sessions.revokeAllForUser(
      req.auth!.user.id,
      'revoked',
      req.auth!.session.id,
    );
    res.json({ revoked: ids.length });
  });

  router.get('/sessions', requireAuth, async (req, res) => {
    const sessions = await ctx.sessions.listForUser(req.auth!.user.id);
    res.json({ sessions: sessions.map((s) => toSessionInfoDTO(s, req.auth!.session.id)) });
  });

  router.delete('/sessions/:id', requireAuth, async (req, res) => {
    const id = parseQuery(idSchema, req.params.id);
    if (id === req.auth!.session.id) throw errors.conflict('This is the device you are using.');
    const sessions = await ctx.sessions.listForUser(req.auth!.user.id);
    if (!sessions.some((s) => s.id === id)) throw errors.notFound('Session');
    await ctx.sessions.revoke(id, 'revoked');
    res.status(204).end();
  });

  router.post('/leave', requireAuth, async (req, res) => {
    if (req.auth!.user.role === 'OWNER') throw errors.forbidden('The owner stops hosting instead.');
    await endPerson(ctx, req.auth!.user);
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.patch('/profile', requireAuth, async (req, res) => {
    const body = parseBody(updateProfileRequestSchema, req.body);
    const user = await ctx.db.user.update({ where: { id: req.auth!.user.id }, data: body });
    respondWithProfile(res, user);
  });

  const readImageBody: RequestHandler = (req, res, next) => {
    const kind = parseQuery(profileMediaKindSchema, req.params.kind);
    const limit = ctx.limiter.consume(
      `profile-media:user:${req.auth!.user.id}`,
      IMAGE_UPLOADS_PER_HOUR,
      HOUR_MS,
    );
    if (!limit.ok) throw errors.rateLimited(limit.retryAfterSec);
    IMAGE_BODY_PARSERS[kind](req, res, (err?: unknown) => {
      const tooLarge = (err as { type?: string } | undefined)?.type === 'entity.too.large';
      next(tooLarge ? imageTooLarge(kind) : err);
    });
  };

  router.put('/profile/media/:kind', requireAuth, readImageBody, async (req, res) => {
    const kind = parseQuery(profileMediaKindSchema, req.params.kind);
    respondWithProfile(
      res,
      await setProfileImage(ctx.db, ctx.log, req.auth!.user.id, kind, req.body),
    );
  });

  router.delete('/profile/media/:kind', requireAuth, async (req, res) => {
    const kind = parseQuery(profileMediaKindSchema, req.params.kind);
    respondWithProfile(res, await clearProfileImage(ctx.db, req.auth!.user.id, kind));
  });

  return router;
}
