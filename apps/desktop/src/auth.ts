import {
  ErrorCode,
  type AccessTokenResponse,
  type ApiErrorBody,
  type DesktopAuthResponse,
  type DesktopAuthResult,
} from '@hostile/shared';
import { apiRequest } from './api.js';
import { log } from './log.js';
import type { Runtime } from './runtime.js';

export interface AuthService {
  signInAsOwner(): Promise<DesktopAuthResult>;
  refresh(): Promise<DesktopAuthResult>;
  logout(): Promise<{ serverConfirmed: boolean }>;
  forget(): void;
}

function failed(
  status: number,
  code: ApiErrorBody['error']['code'],
  message: string,
): DesktopAuthResult {
  return { ok: false, status, error: { code, message } };
}

export function createAuthService(runtime: Runtime, ownerSecret: () => string | null): AuthService {
  const serverUrl = () => runtime.settings.get().serverUrl;
  const scope = () => runtime.credentialScope();

  const accept = async (
    server: string,
    response: DesktopAuthResponse,
  ): Promise<DesktopAuthResult> => {
    if (!response?.refreshToken || !response.accessToken || !response.user) {
      return failed(0, ErrorCode.Internal, 'The server returned an unexpected response.');
    }
    const owner = scope();
    if (serverUrl() !== server || !owner) {
      log.info('the room changed while signing in; not storing that credential');
      return failed(401, ErrorCode.Unauthenticated, 'The room changed. Try again.');
    }
    await runtime.credentials.save({ serverUrl: owner, refreshToken: response.refreshToken });
    return {
      ok: true,
      user: response.user,
      accessToken: response.accessToken,
      accessTokenExpiresAt: response.accessTokenExpiresAt,
    };
  };

  const signInAsOwner = async (): Promise<DesktopAuthResult> => {
    const server = serverUrl();
    const secret = ownerSecret();
    if (!server || !secret)
      return failed(401, ErrorCode.Unauthenticated, 'This app hosts no room.');
    const result = await apiRequest<DesktopAuthResponse>(server, '/api/auth/owner', {
      method: 'POST',
      body: { secret, client: 'desktop' },
    });
    if (!result.ok) return { ok: false, status: result.status, error: result.error };
    return accept(server, result.value);
  };

  return {
    signInAsOwner,

    async refresh() {
      const server = serverUrl();
      if (!server) return failed(401, ErrorCode.Unauthenticated, 'This app hosts no room.');
      const stored = await runtime.credentials.load();
      if (stored && stored.serverUrl !== scope()) {
        log.info('stored credential belongs to another room; discarding it');
        runtime.credentials.clear();
      } else if (stored) {
        const result = await apiRequest<AccessTokenResponse>(server, '/api/auth/refresh', {
          method: 'POST',
          body: { refreshToken: stored.refreshToken },
        });
        if (result.ok) {
          const { user, accessToken, accessTokenExpiresAt } = result.value;
          if (!user || !accessToken)
            return failed(0, ErrorCode.Internal, 'The server returned an unexpected response.');
          return { ok: true, user, accessToken, accessTokenExpiresAt };
        }
        if (result.status !== 401 && result.status !== 403)
          return { ok: false, status: result.status, error: result.error };
        runtime.credentials.clear();
      }
      return signInAsOwner();
    },

    async logout() {
      const server = serverUrl();
      const stored = await runtime.credentials.load();
      runtime.credentials.clear();
      if (!server || !stored) return { serverConfirmed: true };
      if (stored.serverUrl !== scope()) {
        log.warn('stored credential belongs to another room; not presenting it');
        return { serverConfirmed: false };
      }
      const result = await apiRequest<null>(server, '/api/auth/logout', {
        method: 'POST',
        body: { refreshToken: stored.refreshToken },
        timeoutMs: 8000,
      });
      if (!result.ok) {
        log.warn(
          `ending the session could not be confirmed by the server: ${result.error.message}`,
        );
        return { serverConfirmed: result.status === 401 || result.status === 403 };
      }
      return { serverConfirmed: true };
    },

    forget() {
      runtime.credentials.clear();
    },
  };
}
