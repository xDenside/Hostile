import type { SelfUser, SessionResponse } from '@hostile/shared';
import { ApiError, requestJson } from '../api/http';
import { isGuestBuild, siteBase } from '../tunnel/net';
import type { Platform } from './index';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createWebPlatform(): Platform {
  let csrfToken: string | null = null;
  const json = { 'Content-Type': 'application/json' };

  return {
    kind: 'web',
    desktop: null,
    apiBase: () => (isGuestBuild() ? siteBase() : ''),
    socketUrl: () => undefined,
    authHeaders: (method) =>
      UNSAFE.has(method.toUpperCase()) && csrfToken
        ? ({ 'X-CSRF-Token': csrfToken } as Record<string, string>)
        : {},
    socketAuth: () => ({}),
    recoverFromUnauthorized: async () => false,

    adoptSession(token) {
      csrfToken = token;
    },

    async restoreSession(): Promise<SelfUser | null> {
      try {
        const res = await requestJson<SessionResponse>('/api/auth/session');
        csrfToken = res.csrfToken;
        return res.user;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null;
        throw err;
      }
    },

    async logout() {
      const attempt = () =>
        requestJson('/api/auth/logout', {
          method: 'POST',
          headers: { ...json, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
          body: '{}',
        });
      try {
        await attempt();
      } catch (err) {
        if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) throw err;
        if (err.status === 403 && (await this.restoreSession())) await attempt();
      }
      csrfToken = null;
      return { serverConfirmed: true };
    },

    dropCredentials() {
      csrfToken = null;
    },

    openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  };
}
