import { EventEmitter } from 'node:events';
import type { SessionEndReason } from '@hostile/shared';
import type { Db } from '../db.js';
import type { ClientKind, Session, User } from '../generated/prisma/client.js';
import { randomToken, sha256Hex } from './crypto.js';

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type SessionWithUser = Session & { user: User };

export interface SessionEvents {
  revoked: [{ sessionIds: string[]; reason: SessionEndReason }];
  userDisabled: [{ userId: string }];
}

export class SessionService {
  readonly events = new EventEmitter<SessionEvents>();

  constructor(private readonly db: Db) {}

  async create(user: Pick<User, 'id'>, client: ClientKind, userAgent: string | undefined) {
    const token = randomToken(32);
    const session = await this.db.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(token),
        client,
        userAgent: userAgent?.slice(0, 256) ?? null,
      },
    });
    return { session, token };
  }

  async findByToken(token: string): Promise<SessionWithUser | null> {
    if (!token || token.length > 200) return null;
    const session = await this.db.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    return this.checkAndTouch(session);
  }

  async findById(sessionId: string): Promise<SessionWithUser | null> {
    const session = await this.db.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });
    return this.checkAndTouch(session);
  }

  private async checkAndTouch(session: SessionWithUser | null): Promise<SessionWithUser | null> {
    if (!session || session.revokedAt) return null;
    const now = Date.now();
    if (now - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.session.update({
        where: { id: session.id },
        data: { lastUsedAt: new Date(now) },
      });
      session.lastUsedAt = new Date(now);
    }
    return session;
  }

  async revoke(sessionId: string, reason: SessionEndReason): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    this.events.emit('revoked', { sessionIds: [sessionId], reason });
  }

  async revokeAllForUser(
    userId: string,
    reason: SessionEndReason,
    exceptSessionId?: string,
  ): Promise<string[]> {
    const active = await this.db.session.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      select: { id: true },
    });
    const ids = active.map((s) => s.id);
    if (ids.length) {
      await this.db.session.updateMany({
        where: { id: { in: ids }, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      });
      this.events.emit('revoked', { sessionIds: ids, reason });
    }
    return ids;
  }

  async stillValid(sessionIds: string[]): Promise<Set<string>> {
    if (!sessionIds.length) return new Set();
    const rows = await this.db.session.findMany({
      where: {
        id: { in: sessionIds },
        revokedAt: null,
        user: { disabledAt: null },
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  async listForUser(userId: string) {
    return this.db.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastUsedAt: 'desc' },
    });
  }
}
