import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestJson: vi.fn() }));

vi.mock('../src/api/http', async (original) => ({
  ...(await original<typeof import('../src/api/http')>()),
  requestJson: mocks.requestJson,
}));

const { ApiError } = await import('../src/api/http');
const { createWebPlatform } = await import('../src/platform/web');

const user = { id: 'u1', displayName: 'Alice' };

function csrfOf(call: unknown[]): string | undefined {
  return (call[1] as { headers?: Record<string, string> } | undefined)?.headers?.['X-CSRF-Token'];
}

describe('web sign-out', () => {
  beforeEach(() => mocks.requestJson.mockReset());

  it('treats an already-ended session as signed out', async () => {
    mocks.requestJson.mockRejectedValueOnce(
      new ApiError(401, 'unauthorized', 'Not part of the room.'),
    );
    await expect(createWebPlatform().logout()).resolves.toEqual({ serverConfirmed: true });
  });

  it('retries a refused CSRF token with a fresh one instead of claiming success', async () => {
    mocks.requestJson
      .mockRejectedValueOnce(new ApiError(403, 'csrf_failed', 'Refresh and try again.'))
      .mockResolvedValueOnce({ user, csrfToken: 'fresh' })
      .mockResolvedValueOnce({});

    await expect(createWebPlatform().logout()).resolves.toEqual({ serverConfirmed: true });

    expect(mocks.requestJson.mock.calls.map((c) => c[0])).toEqual([
      '/api/auth/logout',
      '/api/auth/session',
      '/api/auth/logout',
    ]);
    expect(csrfOf(mocks.requestJson.mock.calls[2]!)).toBe('fresh');
  });

  it('reports the failure when the session is still alive after the retry', async () => {
    mocks.requestJson
      .mockRejectedValueOnce(new ApiError(403, 'csrf_failed', 'Refresh and try again.'))
      .mockResolvedValueOnce({ user, csrfToken: 'fresh' })
      .mockRejectedValueOnce(new ApiError(403, 'csrf_failed', 'Refresh and try again.'));

    await expect(createWebPlatform().logout()).rejects.toMatchObject({ status: 403 });
  });
});
