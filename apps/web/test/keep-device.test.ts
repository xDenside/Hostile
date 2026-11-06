import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepThisDevice } from '../src/app/session';
import { isGuestBuild } from '../src/tunnel/net';

vi.mock('../src/tunnel/net', async (original) => ({
  ...(await original<typeof import('../src/tunnel/net')>()),
  isGuestBuild: vi.fn(),
}));

describe('a guest asks the browser to keep what they are', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks in a guest build, and only there', () => {
    const persist = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal('navigator', { storage: { persist } });
    vi.mocked(isGuestBuild).mockReturnValue(false);
    keepThisDevice();
    expect(persist).not.toHaveBeenCalled();
    vi.mocked(isGuestBuild).mockReturnValue(true);
    keepThisDevice();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('carries on in a browser that does not offer it, or refuses', async () => {
    vi.mocked(isGuestBuild).mockReturnValue(true);
    vi.stubGlobal('navigator', {});
    expect(() => keepThisDevice()).not.toThrow();
    vi.stubGlobal('navigator', { storage: { persist: () => Promise.reject(new Error('no')) } });
    expect(() => keepThisDevice()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
