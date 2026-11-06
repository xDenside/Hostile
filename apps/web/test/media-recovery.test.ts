import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  imageFailureFrom,
  MEDIA_RETRY_MS,
  probeFile,
  videoFailureFrom,
  videoFailureFromCode,
  whenWorthRetrying,
} from '../src/features/chat/media-recovery';
import { useCommunity } from '../src/stores/community';

const ABORTED = 1;
const NETWORK = 2;
const DECODE = 3;
const NOT_SUPPORTED = 4;

describe('asking the server about a file that would not load', () => {
  afterEach(() => vi.unstubAllGlobals());

  const answering = (result: Response | Error) => {
    const fetchMock = vi.fn(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('says it is there on a success, asking the server and not its cache', async () => {
    const fetchMock = answering(new Response(null, { status: 200 }));
    await expect(probeFile('/f')).resolves.toBe('present');
    expect(fetchMock).toHaveBeenCalledWith('/f', { method: 'HEAD', cache: 'no-store' });
  });

  it('says it is gone only when the server says so', async () => {
    answering(new Response(null, { status: 404 }));
    await expect(probeFile('/f')).resolves.toBe('missing');
    answering(new Response(null, { status: 410 }));
    await expect(probeFile('/f')).resolves.toBe('missing');
  });

  it.each([500, 502, 503, 504, 429, 403])('knows nothing yet from a %i', async (status) => {
    answering(new Response(null, { status }));
    await expect(probeFile('/f')).resolves.toBe('unreachable');
  });

  it('knows nothing yet from a request that failed', async () => {
    answering(new TypeError('Failed to fetch'));
    await expect(probeFile('/f')).resolves.toBe('unreachable');
  });
});

describe('what an image that would not load has become', () => {
  it('is final only on the word of a server that answered', () => {
    expect(imageFailureFrom('missing', false)).toBe('missing');
    expect(imageFailureFrom('unreachable', false)).toBe('unreachable');
    expect(imageFailureFrom('unreachable', true)).toBe('unreachable');
  });

  it('is tried once more when the server has it, in case it had only just come back', () => {
    expect(imageFailureFrom('present', false)).toBe('retry');
    expect(imageFailureFrom('present', true)).toBe('broken');
  });
});

describe('what a video that would not load has become', () => {
  it('reads the code first: an abort is nothing, a decode failure needs no question', () => {
    expect(videoFailureFromCode(ABORTED)).toBe('ignore');
    expect(videoFailureFromCode(DECODE)).toBe('broken');
    expect(videoFailureFromCode(NETWORK)).toBe('ask');
    expect(videoFailureFromCode(NOT_SUPPORTED)).toBe('ask');
    expect(videoFailureFromCode(undefined)).toBe('ask');
  });

  it('never blames the browser for a network error, even with the server answering', () => {
    expect(videoFailureFrom(NETWORK, 'present', false)).toBe('unreachable');
    expect(videoFailureFrom(NETWORK, 'present', true)).toBe('unreachable');
    expect(videoFailureFrom(NETWORK, 'unreachable', false)).toBe('unreachable');
    expect(videoFailureFrom(NETWORK, 'missing', false)).toBe('missing');
  });

  it('blames the browser only for a file the server has, twice over', () => {
    expect(videoFailureFrom(NOT_SUPPORTED, 'present', false)).toBe('retry');
    expect(videoFailureFrom(NOT_SUPPORTED, 'present', true)).toBe('broken');
  });

  it('never blames the browser with the server out of reach or in trouble', () => {
    expect(videoFailureFrom(NOT_SUPPORTED, 'unreachable', false)).toBe('unreachable');
    expect(videoFailureFrom(NOT_SUPPORTED, 'unreachable', true)).toBe('unreachable');
    expect(videoFailureFrom(undefined, 'unreachable', true)).toBe('unreachable');
  });

  it('says a file is gone when the server says so', () => {
    expect(videoFailureFrom(NOT_SUPPORTED, 'missing', false)).toBe('missing');
    expect(videoFailureFrom(undefined, 'missing', true)).toBe('missing');
  });
});

describe('knowing when it is worth trying again', () => {
  function fakeTarget() {
    const listeners = new Map<string, Set<() => void>>();
    return {
      listeners,
      visibilityState: 'visible',
      addEventListener(type: string, fn: () => void) {
        listeners.set(type, (listeners.get(type) ?? new Set()).add(fn));
      },
      removeEventListener(type: string, fn: () => void) {
        listeners.get(type)?.delete(fn);
      },
      fire(type: string) {
        for (const fn of listeners.get(type) ?? []) fn();
      },
      count: (type: string) => listeners.get(type)?.size ?? 0,
    };
  }

  let win: ReturnType<typeof fakeTarget>;
  let doc: ReturnType<typeof fakeTarget>;

  beforeEach(() => {
    vi.useFakeTimers();
    win = fakeTarget();
    doc = fakeTarget();
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    useCommunity.setState({ connection: 'connected' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('says so when the network comes back', () => {
    const retry = vi.fn();
    const stop = whenWorthRetrying(retry);
    win.fire('online');
    expect(retry).toHaveBeenCalledTimes(1);
    stop();
  });

  it('says so when the socket has reconnected, and not for every change of state', () => {
    const retry = vi.fn();
    const stop = whenWorthRetrying(retry);
    useCommunity.setState({ connection: 'reconnecting' });
    expect(retry).not.toHaveBeenCalled();
    useCommunity.setState({ connection: 'connected' });
    expect(retry).toHaveBeenCalledTimes(1);
    useCommunity.setState({ connectionError: 'something else' });
    expect(retry).toHaveBeenCalledTimes(1);
    stop();
  });

  it('says so when the page is being looked at again', () => {
    const retry = vi.fn();
    const stop = whenWorthRetrying(retry);
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    expect(retry).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    expect(retry).toHaveBeenCalledTimes(1);
    stop();
  });

  it('says so by itself after a while, when the blip was too short for any of those', () => {
    const retry = vi.fn();
    const stop = whenWorthRetrying(retry);
    vi.advanceTimersByTime(MEDIA_RETRY_MS - 1);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps one set of listeners for any number of files, and none once they have all gone', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = whenWorthRetrying(first);
    const stopSecond = whenWorthRetrying(second);
    expect(win.count('online')).toBe(1);
    win.fire('online');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    win.fire('online');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    stopSecond();
    expect(win.count('online')).toBe(0);
    expect(doc.count('visibilitychange')).toBe(0);
    vi.advanceTimersByTime(MEDIA_RETRY_MS * 3);
    useCommunity.setState({ connection: 'reconnecting' });
    useCommunity.setState({ connection: 'connected' });
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('lets a file stop waiting from inside its own callback', () => {
    const stops: (() => void)[] = [];
    const retry = vi.fn(() => stops.forEach((stop) => stop()));
    stops.push(whenWorthRetrying(retry));
    const other = vi.fn();
    const stopOther = whenWorthRetrying(other);
    win.fire('online');
    expect(retry).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    stopOther();
  });
});
