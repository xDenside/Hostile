import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { parseCookie } from 'cookie';
import type { ZodType } from 'zod';
import type { AppContext } from '../context.js';
import { csrfTokenFor, verifyAccessToken } from '../auth/access-token.js';
import { safeEqual } from '../auth/crypto.js';
import type { SessionWithUser } from '../auth/sessions.js';
import { errors, HttpError } from '../lib/errors.js';

export interface AuthInfo {
  session: SessionWithUser;
  user: SessionWithUser['user'];
  via: 'cookie' | 'bearer';
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthInfo;
      authFailure?: 'expired' | 'invalid' | 'disabled';
    }
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function readSessionCookie(
  ctx: AppContext,
  cookieHeader: string | undefined,
): string | null {
  if (!cookieHeader) return null;
  const cookies = parseCookie(cookieHeader);
  return cookies[ctx.config.cookie.name] ?? null;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1]! : null;
}

export function authenticate(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const bearer = bearerToken(req.headers.authorization);
    if (bearer) {
      const result = verifyAccessToken(ctx.config.sessionSecret, bearer);
      if (!result.ok) {
        req.authFailure = result.reason === 'expired' ? 'expired' : 'invalid';
        return next();
      }
      const session = await ctx.sessions.findById(result.claims.sid);
      if (!session || session.userId !== result.claims.uid) {
        req.authFailure = 'expired';
        return next();
      }
      if (session.user.disabledAt) {
        req.authFailure = 'disabled';
        return next();
      }
      req.auth = { session, user: session.user, via: 'bearer' };
      return next();
    }
    const cookieToken = readSessionCookie(ctx, req.headers.cookie);
    if (cookieToken) {
      const session = await ctx.sessions.findByToken(cookieToken);
      if (!session) {
        req.authFailure = 'expired';
        return next();
      }
      if (session.user.disabledAt) {
        req.authFailure = 'disabled';
        return next();
      }
      req.auth = { session, user: session.user, via: 'cookie' };
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (req.auth) return next();
  if (req.authFailure === 'disabled') return next(errors.accountDisabled());
  if (req.authFailure === 'expired') return next(errors.sessionExpired());
  next(errors.unauthenticated());
};

export const requireOwner: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(errors.unauthenticated());
  if (req.auth.user.role !== 'OWNER') return next(errors.forbidden('Only the owner can do that.'));
  next();
};

const CSRF_EXEMPT_PATHS = new Set(['/auth/owner', '/join']);
const CSRF_EXEMPT_PREFIX = '/join/';

export function csrfProtection(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    if (!UNSAFE_METHODS.has(req.method) || req.auth?.via !== 'cookie') return next();
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    if (CSRF_EXEMPT_PATHS.has(path) || path.startsWith(CSRF_EXEMPT_PREFIX)) return next();
    const presented = req.get('x-csrf-token') ?? '';
    const expected = csrfTokenFor(ctx.config.sessionSecret, req.auth.session.id);
    if (!presented || !safeEqual(presented, expected)) return next(errors.csrf());
    next();
  };
}

export function isAllowedOrigin(ctx: AppContext, origin: string): boolean {
  return ctx.config.allowedOrigins.includes(origin);
}

export function originGuard(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (!origin || !UNSAFE_METHODS.has(req.method)) return next();
    if (!isAllowedOrigin(ctx, origin)) return next(errors.origin());
    next();
  };
}

export function cors(ctx: AppContext): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && isAllowedOrigin(ctx, origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-CSRF-Token');
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
      }
    } else if (req.method === 'OPTIONS' && origin) {
      res.status(403).end();
      return;
    }
    next();
  };
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw errors.validation(result.error);
  return result.data;
}

export function parseQuery<T>(schema: ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query ?? {});
  if (!result.success) throw errors.validation(result.error);
  return result.data;
}

export function errorHandler(ctx: AppContext) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (err.status === 429 && err.extra.retryAfterSec)
        res.setHeader('Retry-After', String(err.extra.retryAfterSec));
      res.status(err.status).json(err.toBody());
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') {
      res
        .status(413)
        .json({ error: { code: 'payload_too_large', message: 'Request body is too large.' } });
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res
        .status(400)
        .json({ error: { code: 'validation_error', message: 'Malformed JSON body.' } });
      return;
    }
    if (typeof e?.type === 'string' && e.status && e.status >= 400 && e.status < 500) {
      res.status(e.status).json({
        error: { code: 'validation_error', message: 'The request body could not be read.' },
      });
      return;
    }
    ctx.log.error({ err, method: req.method, path: req.path }, 'unhandled request error');
    res
      .status(500)
      .json({ error: { code: 'internal_error', message: 'Something went wrong on the server.' } });
  };
}
