import { createHash, timingSafeEqual } from 'node:crypto';
import { AVATAR_COLORS } from '@hostile/shared';
import type { AppContext } from '../context.js';
import type { ClientKind } from '../generated/prisma/client.js';
import { errors } from '../lib/errors.js';
import { signAccessToken } from './access-token.js';

const FIFTEEN_MIN = 15 * 60 * 1000;

export function defaultAvatarColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

function limited(result: { ok: true } | { ok: false; retryAfterSec: number }) {
  if (!result.ok) throw errors.rateLimited(result.retryAfterSec);
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export class AuthService {
  constructor(private readonly ctx: AppContext) {}

  accessTokenFor(session: { id: string; userId: string }) {
    return signAccessToken(
      this.ctx.config.sessionSecret,
      { sid: session.id, uid: session.userId },
      this.ctx.config.accessTokenTtlSec,
    );
  }

  async refresh(refreshToken: string, ip: string) {
    limited(this.ctx.limiter.consume(`refresh:ip:${ip}`, 120, FIFTEEN_MIN));
    const session = await this.ctx.sessions.findByToken(refreshToken);
    if (!session || session.client !== 'DESKTOP') throw errors.sessionExpired();
    if (session.user.disabledAt) throw errors.accountDisabled();
    return { session, user: session.user, ...this.accessTokenFor(session) };
  }

  async ownerSession(secret: string, client: ClientKind, userAgent?: string) {
    const expected = this.ctx.config.ownerSecret;
    if (!expected || !timingSafeEqual(digest(secret), digest(expected)))
      throw errors.forbidden('That is not the secret of this room.');
    const owner = await this.ctx.db.user.findFirst({ where: { role: 'OWNER' } });
    if (!owner) throw errors.notFound('Owner');
    const { session, token } = await this.ctx.sessions.create(owner, client, userAgent);
    this.ctx.log.info({ sessionId: session.id, client }, 'owner session');
    return { user: owner, session, token };
  }
}
