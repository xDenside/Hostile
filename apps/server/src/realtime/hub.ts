import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  SOCKET_ROOMS,
  typingPayloadSchema,
  voiceSelfStatePayloadSchema,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SessionEndReason,
  type VoiceSelfStatePayload,
} from '@hostile/shared';
import type { AppContext } from '../context.js';
import { LatestWinsThrottle } from '../lib/latest-wins-throttle.js';
import { verifyAccessToken } from '../auth/access-token.js';
import { isAllowedOrigin, readSessionCookie } from '../http/middleware.js';
import type { RealtimeEmitter } from './emitter.js';

interface SocketData {
  userId: string;
  sessionId: string;
  via: 'cookie' | 'bearer';
  role: 'OWNER' | 'MEMBER';
  lastTypingAt: number;
}

type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

const SWEEP_INTERVAL_MS = 60_000;

const SELF_STATE_LIMIT = 40;
const SELF_STATE_WINDOW_MS = 10_000;

export class RealtimeHub implements RealtimeEmitter {
  readonly io: Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >;
  private readonly socketsByUser = new Map<string, Set<string>>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly selfStateThrottle: LatestWinsThrottle<VoiceSelfStatePayload>;

  constructor(
    private readonly ctx: AppContext,
    httpServer: HttpServer,
  ) {
    this.selfStateThrottle = new LatestWinsThrottle(
      ctx.limiter,
      'voice-self:user',
      SELF_STATE_LIMIT,
      SELF_STATE_WINDOW_MS,
      (userId, state) => ctx.voice.setSelfState(userId, state),
    );
    this.io = new Server(httpServer, {
      path: '/socket.io',
      serveClient: false,
      maxHttpBufferSize: 16 * 1024,
      pingInterval: 20_000,
      pingTimeout: 20_000,
      cors: {
        origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(ctx, origin)),
        credentials: false,
      },
    });
    this.io.use((socket, next) => {
      this.authenticate(socket as AppSocket)
        .then(() => next())
        .catch((err: Error & { data?: unknown }) => {
          if (err.data) return next(err);
          ctx.log.warn({ err: err.message }, 'could not check a socket handshake');
          next(
            Object.assign(new Error('The server is busy. Trying again.'), {
              data: { code: 'unavailable' },
            }),
          );
        });
    });
    this.io.on('connection', (socket) => this.onConnection(socket as AppSocket));

    ctx.sessions.events.on('revoked', ({ sessionIds, reason }) =>
      this.endSessions(sessionIds, reason),
    );
    this.sweeper = setInterval(() => void this.sweepExpiredSessions(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  private async authenticate(socket: AppSocket): Promise<void> {
    const origin = socket.handshake.headers.origin;
    const fail = (code: string, message: string) =>
      Object.assign(new Error(message), { data: { code } });
    if (origin && !isAllowedOrigin(this.ctx, origin))
      throw fail('origin_not_allowed', 'Origin not allowed');

    const token =
      typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : null;
    if (token) {
      const result = verifyAccessToken(this.ctx.config.sessionSecret, token);
      if (!result.ok) throw fail('session_expired', 'Access token invalid or expired');
      const session = await this.ctx.sessions.findById(result.claims.sid);
      if (!session || session.userId !== result.claims.uid)
        throw fail('session_expired', 'Session ended');
      if (session.user.disabledAt) throw fail('account_disabled', 'Account disabled');
      socket.data = {
        userId: session.userId,
        sessionId: session.id,
        via: 'bearer',
        role: session.user.role,
        lastTypingAt: 0,
      };
      return;
    }
    const cookieToken = readSessionCookie(this.ctx, socket.handshake.headers.cookie);
    if (!cookieToken) throw fail('unauthenticated', 'Not signed in');
    const session = await this.ctx.sessions.findByToken(cookieToken);
    if (!session) throw fail('session_expired', 'Session ended');
    if (session.user.disabledAt) throw fail('account_disabled', 'Account disabled');
    socket.data = {
      userId: session.userId,
      sessionId: session.id,
      via: 'cookie',
      role: session.user.role,
      lastTypingAt: 0,
    };
  }

  private onConnection(socket: AppSocket): void {
    const { userId, sessionId } = socket.data;
    void socket.join([
      SOCKET_ROOMS.community,
      SOCKET_ROOMS.user(userId),
      SOCKET_ROOMS.session(sessionId),
      ...(socket.data.role === 'OWNER' ? [SOCKET_ROOMS.owner] : []),
    ]);

    let set = this.socketsByUser.get(userId);
    const cameOnline = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.socketsByUser.set(userId, set);
    }
    set.add(socket.id);
    if (cameOnline) this.toCommunity('presence:changed', { userId, online: true });
    socket.emit('voice:status', this.ctx.voice.status());

    socket.on('typing:start', (payload) => {
      const parsed = typingPayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const now = Date.now();
      if (now - socket.data.lastTypingAt < 1500) return;
      socket.data.lastTypingAt = now;
      void this.ctx.db.channel
        .findUnique({
          where: { id: parsed.data.channelId },
          select: { archivedAt: true },
        })
        .then((channel) => {
          if (channel && !channel.archivedAt) {
            socket
              .to(SOCKET_ROOMS.community)
              .emit('typing', { channelId: parsed.data.channelId, userId });
          }
        })
        .catch(() => undefined);
    });

    socket.on('voice:self-state', (payload) => {
      const parsed = voiceSelfStatePayloadSchema.safeParse(payload);
      if (!parsed.success) return;
      this.selfStateThrottle.push(userId, parsed.data);
    });

    socket.on('disconnect', () => {
      const sockets = this.socketsByUser.get(userId);
      sockets?.delete(socket.id);
      if (!sockets || sockets.size === 0) {
        this.socketsByUser.delete(userId);
        this.toCommunity('presence:changed', { userId, online: false });
        this.selfStateThrottle.cancel(userId);
        this.ctx.voice.clearSelfState(userId);
      }
    });
  }

  private async sweepExpiredSessions(): Promise<void> {
    const sockets = await this.io.fetchSockets();
    const sessionIds = [...new Set(sockets.map((s) => s.data.sessionId))];
    try {
      const valid = await this.ctx.sessions.stillValid(sessionIds);
      const ended = sessionIds.filter((id) => !valid.has(id));
      if (ended.length) this.endSessions(ended, 'expired');
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'socket session sweep failed');
    }
  }

  toCommunity<E extends keyof ServerToClientEvents>(
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    this.io.to(SOCKET_ROOMS.community).emit(event, ...args);
  }

  toOwner<E extends keyof ServerToClientEvents>(
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    this.io.to(SOCKET_ROOMS.owner).emit(event, ...args);
  }

  toUser<E extends keyof ServerToClientEvents>(
    userId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    this.io.to(SOCKET_ROOMS.user(userId)).emit(event, ...args);
  }

  endSessions(sessionIds: string[], reason: SessionEndReason): void {
    for (const sessionId of sessionIds) {
      const room = SOCKET_ROOMS.session(sessionId);
      this.io.to(room).emit('session:ended', { reason });
      this.io.in(room).disconnectSockets(false);
    }
  }

  isOnline(userId: string): boolean {
    return (this.socketsByUser.get(userId)?.size ?? 0) > 0;
  }

  onlineUserIds(): string[] {
    return [...this.socketsByUser.keys()];
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.selfStateThrottle.close();
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
  }
}
