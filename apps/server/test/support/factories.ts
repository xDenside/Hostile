import { randomUUID } from 'node:crypto';
import { BRAND } from '@hostile/shared';
import { csrfTokenFor, signAccessToken } from '../../src/auth/access-token.js';
import type { AppContext } from '../../src/context.js';
import type { Channel, User } from '../../src/generated/prisma/client.js';
import type { TestApi } from './harness.js';

const SESSION_COOKIE = `${BRAND.slug}_session`;

let counter = 0;

export async function createUser(
  ctx: AppContext,
  options: {
    displayName?: string;
    role?: 'OWNER' | 'MEMBER';
    disabled?: boolean;
  } = {},
): Promise<User> {
  const id = randomUUID();
  return ctx.db.user.create({
    data: {
      id,
      displayName: options.displayName ?? `person-${++counter}`,
      avatarColor: '#2e2e2e',
      role: options.role ?? 'MEMBER',
      disabledAt: options.disabled ? new Date() : null,
    },
  });
}

export function createChannel(
  ctx: AppContext,
  options: { name?: string; type?: 'TEXT' | 'VOICE'; position?: number; archived?: boolean } = {},
): Promise<Channel> {
  return ctx.db.channel.create({
    data: {
      name: options.name ?? `channel-${++counter}`,
      type: options.type ?? 'TEXT',
      position: options.position ?? counter,
      archivedAt: options.archived ? new Date() : null,
    },
  });
}

export interface WebSession {
  userId: string;
  cookie: string;
  csrfToken: string;
}

export interface DesktopSession {
  userId: string;
  refreshToken: string;
  accessToken: string;
}

export function sessionCookie(setCookie: string[] | undefined): string {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!header) throw new Error(`The response carried no ${SESSION_COOKIE} cookie`);
  return header.split(';')[0]!;
}

export async function loginWeb(api: TestApi, user: Pick<User, 'id'>): Promise<WebSession> {
  const { session, token } = await api.ctx.sessions.create(user, 'WEB', undefined);
  return {
    userId: user.id,
    cookie: `${SESSION_COOKIE}=${token}`,
    csrfToken: csrfTokenFor(api.ctx.config.sessionSecret, session.id),
  };
}

export async function loginDesktop(api: TestApi, user: Pick<User, 'id'>): Promise<DesktopSession> {
  const { session, token } = await api.ctx.sessions.create(user, 'DESKTOP', undefined);
  const access = signAccessToken(
    api.ctx.config.sessionSecret,
    { sid: session.id, uid: user.id },
    api.ctx.config.accessTokenTtlSec,
  );
  return { userId: user.id, refreshToken: token, accessToken: access.token };
}

export const webAuth = (session: WebSession) => ({
  Cookie: session.cookie,
  'X-CSRF-Token': session.csrfToken,
});

export const bearerAuth = (session: DesktopSession) => ({
  Authorization: `Bearer ${session.accessToken}`,
});

export async function sendMessage(
  api: TestApi,
  session: DesktopSession,
  channelId: string,
  content: string,
  clientNonce = randomUUID(),
) {
  const res = await api
    .http()
    .post(`/api/channels/${channelId}/messages`)
    .set(bearerAuth(session))
    .send({ content, clientNonce });
  if (res.status !== 201) throw new Error(`Send failed: ${res.status} ${res.text}`);
  return res.body.message as { id: string; seq: number; changeSeq: number; content: string };
}
