import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ kick: vi.fn(), nudge: vi.fn() }));

vi.mock('../src/platform', () => ({
  needsServerSetup: () => false,
  platform: () => ({ kind: 'web' }),
}));
vi.mock('../src/realtime/socket', () => ({
  connectRealtime: vi.fn(),
  disconnectRealtime: vi.fn(),
  kickRealtime: hoisted.kick,
  nudgeRealtime: hoisted.nudge,
  onRealtimeConnect: () => () => undefined,
}));

const { installConnectivityHooks } = await import('../src/app/session');

describe('coming back to the tab', () => {
  let dispose: () => void;
  const listeners = new Map<string, () => void>();
  const page = {
    visibilityState: 'visible',
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: () => undefined,
  };
  const become = (state: string) => {
    page.visibilityState = state;
    listeners.get('visibilitychange')!();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.kick.mockReset();
    hoisted.nudge.mockReset();
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', page);
    dispose = installConnectivityHooks();
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks nothing of the server after a glance at another window', () => {
    become('hidden');
    vi.advanceTimersByTime(29_000);
    become('visible');
    expect(hoisted.kick).not.toHaveBeenCalled();
    expect(hoisted.nudge).toHaveBeenCalledTimes(1);
  });

  it('catches up after a longer absence', () => {
    become('hidden');
    vi.advanceTimersByTime(30_000);
    become('visible');
    expect(hoisted.kick).toHaveBeenCalledTimes(1);
  });

  it('counts each absence from when it started', () => {
    become('hidden');
    vi.advanceTimersByTime(20_000);
    become('visible');
    vi.advanceTimersByTime(60_000);
    become('hidden');
    vi.advanceTimersByTime(1000);
    become('visible');
    expect(hoisted.kick).not.toHaveBeenCalled();
  });

  it('catches up when it never saw the tab being hidden', () => {
    become('visible');
    expect(hoisted.kick).toHaveBeenCalledTimes(1);
  });
});
