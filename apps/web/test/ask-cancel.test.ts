import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  join: {
    ask: vi.fn(),
    cancel: vi.fn(),
    picture: vi.fn(),
    status: vi.fn(),
  },
  enterApp: vi.fn(),
}));

vi.mock('../src/api/client', async () => {
  const { ApiError } = await import('../src/api/http');
  return {
    ApiError,
    endpoints: { join: mocks.join },
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  };
});
vi.mock('../src/app/session', () => ({ enterApp: mocks.enterApp }));
vi.mock('../src/platform', () => ({ platform: () => ({ adoptSession: vi.fn() }) }));
vi.mock('../src/tunnel/device-key', () => ({ currentDeviceKey: () => null }));

const stored = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
});

const { ApiError } = await import('../src/api/http');
const { askToJoin, cancelAsking, useAsk } = await import('../src/app/ask');

const later = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('cancelling an ask to join', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.clear();
    mocks.join.cancel.mockResolvedValue(undefined);
    useAsk.setState({ phase: 'form', nickname: 'Sam', avatar: null, banner: null, error: null });
  });

  it('withdraws a request whose ticket arrives after Cancel', async () => {
    const asked = later<{ ticket: string }>();
    mocks.join.ask.mockReturnValue(asked.promise);
    askToJoin();
    expect(useAsk.getState().phase).toBe('waiting');
    cancelAsking();
    asked.resolve({ ticket: 'late' });
    await settle();
    expect(mocks.join.cancel).toHaveBeenCalledWith('late');
    expect(useAsk.getState().phase).toBe('form');
    expect(stored.size).toBe(0);
    expect(mocks.join.status).not.toHaveBeenCalled();
  });

  it('does not try again after Cancel when the ask itself failed', async () => {
    vi.useFakeTimers();
    const asked = later<{ ticket: string }>();
    mocks.join.ask.mockReturnValue(asked.promise);
    askToJoin();
    cancelAsking();
    asked.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    expect(mocks.join.ask).toHaveBeenCalledTimes(1);
  });

  it('withdraws the request when its picture is refused', async () => {
    mocks.join.ask.mockResolvedValue({ ticket: 'with-picture' });
    mocks.join.picture.mockRejectedValue(
      new ApiError(413, 'too_large', 'That picture is too big.'),
    );
    useAsk.setState({ avatar: {} as File });
    askToJoin();
    await settle();
    expect(mocks.join.cancel).toHaveBeenCalledWith('with-picture');
    expect(useAsk.getState()).toMatchObject({ phase: 'form', error: 'That picture is too big.' });
  });
});
