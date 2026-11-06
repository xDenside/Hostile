import type { DesktopAuthResult, DesktopBridge, SelfUser } from '@hostile/shared';
import { ApiError } from '../api/http';
import type { Platform } from './index';

export function createDesktopPlatform(
  bridge: DesktopBridge,
  serverUrl: string | null = null,
): Platform {
  const server = serverUrl;
  let accessToken: string | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshing: Promise<boolean> | null = null;

  const accept = (result: DesktopAuthResult): SelfUser => {
    if (!result.ok)
      throw new ApiError(result.status, result.error.code, result.error.message, result.error);
    accessToken = result.accessToken;
    scheduleRefresh(result.accessTokenExpiresAt);
    return result.user;
  };

  function scheduleRefresh(expiresAtIso: string) {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = Math.max(5_000, new Date(expiresAtIso).getTime() - Date.now() - 60_000);
    refreshTimer = setTimeout(() => void refresh(), delay);
  }

  function refresh(): Promise<boolean> {
    refreshing ??= bridge.auth
      .refresh()
      .then((result) => {
        if (!result.ok) {
          if (result.status !== 0) accessToken = null;
          return false;
        }
        accept(result);
        return true;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  return {
    kind: 'desktop',
    desktop: bridge,
    apiBase: () => server ?? '',
    socketUrl: () => server ?? undefined,
    authHeaders: () =>
      accessToken ? ({ Authorization: `Bearer ${accessToken}` } as Record<string, string>) : {},
    socketAuth: () => (accessToken ? ({ token: accessToken } as Record<string, string>) : {}),
    recoverFromUnauthorized: () => refresh(),

    adoptSession: () => undefined,

    async restoreSession() {
      const result = await bridge.auth.refresh();
      if (result.ok) return accept(result);
      if (result.status === 0) throw new ApiError(0, result.error.code, result.error.message);
      return null;
    },

    async logout() {
      if (refreshTimer) clearTimeout(refreshTimer);
      accessToken = null;
      return bridge.auth.logout();
    },

    dropCredentials() {
      if (refreshTimer) clearTimeout(refreshTimer);
      accessToken = null;
    },

    openExternal(url) {
      bridge.openExternal(url).catch(() => undefined);
    },
  };
}
