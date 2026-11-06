import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { boot, installConnectivityHooks } from '../src/app/session';
import { useSession } from '../src/stores/session';

const hoisted = vi.hoisted(() => ({
  restoreSession: vi.fn<() => Promise<unknown>>(),
  offPower: vi.fn(),
  offShortcut: vi.fn(),
  onPowerEvent: vi.fn(),
  onTriggered: vi.fn(),
}));

vi.mock('../src/platform', () => ({
  needsServerSetup: () => false,
  desktopRoom: () => null,
  platform: () => ({
    kind: 'desktop',
    restoreSession: hoisted.restoreSession,
    desktop: {
      onPowerEvent: hoisted.onPowerEvent,
      shortcuts: { onTriggered: hoisted.onTriggered },
    },
  }),
}));

function fakeTarget() {
  const listeners = new Map<string, unknown[]>();
  return {
    listeners,
    count: (type: string) => (listeners.get(type) ?? []).length,
    addEventListener(type: string, fn: unknown) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: unknown) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== fn),
      );
    },
  };
}

describe('boot', () => {
  beforeEach(() => {
    hoisted.restoreSession.mockReset();
  });

  it('clears a stale boot error once the server answers again', async () => {
    useSession.setState({ status: 'unreachable', bootError: 'Cannot reach the server.' });
    hoisted.restoreSession.mockResolvedValue(null);

    await boot();

    expect(useSession.getState().status).toBe('ask');
    expect(useSession.getState().bootError).toBeNull();
  });

  it('still explains a boot that really failed', async () => {
    useSession.setState({ status: 'booting', bootError: null });
    hoisted.restoreSession.mockRejectedValue(
      new ApiError(0, 'network_error', 'Cannot reach the server.'),
    );

    await boot();

    expect(useSession.getState().status).toBe('unreachable');
    expect(useSession.getState().bootError).toBe('Cannot reach the server.');
  });

  it('does not offer the sign-in form while the server is failing', async () => {
    useSession.setState({ status: 'booting', bootError: null });
    hoisted.restoreSession.mockRejectedValue(new ApiError(503, 'unavailable', 'Try again soon.'));

    await boot();

    expect(useSession.getState().status).toBe('unreachable');
  });
});

describe('installConnectivityHooks', () => {
  const win = fakeTarget();
  const doc = fakeTarget();

  beforeEach(() => {
    win.listeners.clear();
    doc.listeners.clear();
    hoisted.onPowerEvent.mockReset().mockReturnValue(hoisted.offPower);
    hoisted.onTriggered.mockReset().mockReturnValue(hoisted.offShortcut);
    hoisted.offPower.mockReset();
    hoisted.offShortcut.mockReset();
    globalThis.window = win as unknown as typeof globalThis.window;
    globalThis.document = doc as unknown as typeof globalThis.document;
  });

  afterEach(() => {
    installConnectivityHooks()();
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
  });

  it('installs each listener once, however often it is called', () => {
    const dispose = installConnectivityHooks();
    const again = installConnectivityHooks();

    expect(again).toBe(dispose);
    expect(win.count('online')).toBe(1);
    expect(doc.count('visibilitychange')).toBe(1);
    expect(hoisted.onPowerEvent).toHaveBeenCalledTimes(1);
    expect(hoisted.onTriggered).toHaveBeenCalledTimes(1);
  });

  it('removes everything it registered, and can be installed again afterwards', () => {
    installConnectivityHooks()();

    expect(win.count('online')).toBe(0);
    expect(doc.count('visibilitychange')).toBe(0);
    expect(hoisted.offPower).toHaveBeenCalledTimes(1);
    expect(hoisted.offShortcut).toHaveBeenCalledTimes(1);

    installConnectivityHooks();
    expect(win.count('online')).toBe(1);
  });
});
