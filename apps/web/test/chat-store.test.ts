import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDTO, MessageDTO } from '@hostile/shared';
import { ApiError } from '../src/api/http';

const mocks = vi.hoisted(() => ({
  endpoints: {
    history: vi.fn(),
    changes: vi.fn(),
    send: vi.fn(),
    markRead: vi.fn(),
  },
}));

vi.mock('../src/api/client', async () => {
  const { ApiError: Err } = await import('../src/api/http');
  return {
    ApiError: Err,
    endpoints: mocks.endpoints,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  };
});

const { useCommunity } = await import('../src/stores/community');
const { applyEvent, applyLatestPage, emptyWindow, enforceCap } =
  await import('../src/features/chat/sync');
const {
  loadDrafts,
  markChannelRead,
  onMessageEvent,
  resetChat,
  resyncChannel,
  saveDraftsNow,
  sendMessage,
  setDraft,
  useChat,
} = await import('../src/features/chat/store');

const CHANNEL = '0192d5b0-1111-7000-8000-000000000001';

function msg(seq: number, changeSeq = seq, over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: `m${seq}`,
    channelId: CHANNEL,
    authorId: 'u1',
    content: `message ${seq}`,
    seq,
    changeSeq,
    clientNonce: `n${seq}`,
    createdAt: '2026-01-02T03:04:05.000Z',
    editedAt: null,
    deleted: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    ...over,
  };
}

function channel(lastMessageSeq: number): ChannelDTO {
  return { id: CHANNEL, name: 'general', type: 'text', position: 0, lastMessageSeq };
}

function loadedWindow() {
  return applyLatestPage(emptyWindow(), {
    messages: [msg(1), msg(2), msg(3)],
    hasOlder: false,
    syncSeq: 3,
  });
}

function trimmedWindow() {
  const w = enforceCap(loadedWindow(), false, 2);
  if (!w.hasNewer) throw new Error('fixture is not trimmed');
  return w;
}

const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { localStorage };
  store.clear();
  resetChat();
  useCommunity.setState({ channels: [channel(3)], readStates: {} });
  for (const fn of Object.values(mocks.endpoints)) fn.mockReset();
  mocks.endpoints.markRead.mockResolvedValue({ lastReadSeq: 0 });
});

afterEach(() => {
  resetChat();
  vi.useRealTimers();
});

describe('sending into a window that was trimmed away from the present', () => {
  it('shows the message the author just sent instead of dropping it', async () => {
    useChat.setState({ windows: { [CHANNEL]: trimmedWindow() } });
    mocks.endpoints.send.mockResolvedValue({ message: msg(4) });
    mocks.endpoints.history.mockResolvedValue({
      messages: [msg(2), msg(3), msg(4)],
      hasOlder: true,
      syncSeq: 4,
    });

    sendMessage(CHANNEL, 'message 4');
    await vi.waitFor(() => expect(useChat.getState().pending).toEqual({}));

    const w = useChat.getState().windows[CHANNEL]!;
    expect(w.messages.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
    expect(w.hasNewer).toBe(false);
  });

  it('catches up when the socket event for the own message arrives first', async () => {
    useChat.setState({
      windows: { [CHANNEL]: trimmedWindow() },
      pending: {
        n4: {
          nonce: 'n4',
          channelId: CHANNEL,
          content: 'message 4',
          status: 'sending',
          attempts: 1,
          createdAt: 1,
          error: null,
        },
      },
    });
    const { useSession } = await import('../src/stores/session');
    useSession.setState({ user: { id: 'u1' } as never });
    mocks.endpoints.history.mockResolvedValue({
      messages: [msg(2), msg(3), msg(4)],
      hasOlder: true,
      syncSeq: 4,
    });

    onMessageEvent(msg(4));
    await vi.waitFor(() =>
      expect(useChat.getState().windows[CHANNEL]!.messages.map((m) => m.id)).toContain('m4'),
    );
    expect(useChat.getState().pending).toEqual({});
  });

  it('keeps the row when the reload that would show the message fails', async () => {
    useChat.setState({ windows: { [CHANNEL]: trimmedWindow() } });
    mocks.endpoints.send.mockResolvedValue({ message: msg(4) });
    mocks.endpoints.history.mockRejectedValue(new ApiError(500, 'internal', 'Server error.'));

    sendMessage(CHANNEL, 'message 4');
    await vi.waitFor(() =>
      expect(Object.values(useChat.getState().pending)[0]?.status).toBe('failed'),
    );

    expect(useChat.getState().windows[CHANNEL]!.hasNewer).toBe(true);
    expect(Object.values(useChat.getState().pending)[0]?.content).toBe('message 4');
  });
});

describe('marking a channel read', () => {
  it('takes back an optimistic mark the server never accepted', async () => {
    useChat.setState({ windows: { [CHANNEL]: loadedWindow() } });
    useCommunity.setState({ readStates: { [CHANNEL]: 1 } });
    mocks.endpoints.markRead.mockRejectedValue(new ApiError(0, 'network', 'Offline.'));

    markChannelRead(CHANNEL);
    expect(useCommunity.getState().readStates[CHANNEL]).toBe(3);
    await vi.waitFor(() => expect(useCommunity.getState().readStates[CHANNEL]).toBe(1));

    mocks.endpoints.markRead.mockResolvedValue({ lastReadSeq: 3 });
    markChannelRead(CHANNEL);
    expect(mocks.endpoints.markRead).toHaveBeenCalledTimes(2);
  });

  it('asks the server to clear a channel whose newest message was deleted', async () => {
    useChat.setState({ windows: { [CHANNEL]: loadedWindow() } });
    useCommunity.setState({ channels: [channel(4)], readStates: { [CHANNEL]: 3 } });
    mocks.endpoints.markRead.mockResolvedValue({ lastReadSeq: 4 });

    markChannelRead(CHANNEL);
    expect(mocks.endpoints.markRead).toHaveBeenCalledWith(CHANNEL, 3);
    await vi.waitFor(() => expect(useCommunity.getState().readStates[CHANNEL]).toBe(4));
  });

  it('does not repeat a mark the server declined to move', async () => {
    useChat.setState({ windows: { [CHANNEL]: loadedWindow() } });
    useCommunity.setState({ channels: [channel(4)], readStates: { [CHANNEL]: 3 } });
    mocks.endpoints.markRead.mockResolvedValue({ lastReadSeq: 3 });

    markChannelRead(CHANNEL);
    await vi.waitFor(() => expect(mocks.endpoints.markRead).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    markChannelRead(CHANNEL);
    markChannelRead(CHANNEL);
    expect(mocks.endpoints.markRead).toHaveBeenCalledTimes(1);
  });
});

describe('unsent messages survive a reload', () => {
  it('restores them as failed rows without resending them', async () => {
    loadDrafts('user-1');
    mocks.endpoints.send.mockRejectedValue(
      new ApiError(0, 'network_error', 'Cannot reach the server.'),
    );

    sendMessage(CHANNEL, 'text that must not disappear');
    await vi.waitFor(() =>
      expect(Object.values(useChat.getState().pending)[0]?.status).toBe('retrying'),
    );

    resetChat();
    expect(useChat.getState().pending).toEqual({});
    loadDrafts('user-1');

    const restored = Object.values(useChat.getState().pending);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.content).toBe('text that must not disappear');
    expect(restored[0]!.status).toBe('failed');
    expect(mocks.endpoints.send).toHaveBeenCalledTimes(1);
  });

  it('forgets an entry once the server accepted it', async () => {
    loadDrafts('user-1');
    mocks.endpoints.send.mockResolvedValue({ message: msg(4) });

    sendMessage(CHANNEL, 'accepted');
    await vi.waitFor(() => expect(useChat.getState().pending).toEqual({}));

    resetChat();
    loadDrafts('user-1');
    expect(useChat.getState().pending).toEqual({});
  });
});

describe('drafts', () => {
  it('saves a still-debounced draft when the session ends instead of erasing it', () => {
    vi.useFakeTimers();
    loadDrafts('user-1');
    setDraft(CHANNEL, 'half a sentence');

    resetChat();
    vi.advanceTimersByTime(1000);

    loadDrafts('user-1');
    expect(useChat.getState().drafts[CHANNEL]).toBe('half a sentence');
  });
});

describe('a page that is going away', () => {
  it('saves the draft the debounce had not written yet, and keeps the account attached', () => {
    vi.useFakeTimers();
    loadDrafts('u1');
    setDraft(CHANNEL, 'half a thought');
    expect(store.get('hostile:drafts:u1')).toBeUndefined();

    saveDraftsNow();
    expect(store.get('hostile:drafts:u1')).toContain('half a thought');

    setDraft(CHANNEL, 'a whole thought');
    vi.advanceTimersByTime(400);
    expect(store.get('hostile:drafts:u1')).toContain('a whole thought');
  });
});

describe('resync', () => {
  it('retries a failed resync and admits the window may be incomplete meanwhile', async () => {
    vi.useFakeTimers();
    useChat.setState({ windows: { [CHANNEL]: loadedWindow() } });
    mocks.endpoints.changes.mockRejectedValueOnce(
      new ApiError(500, 'internal_error', 'Request failed (500).'),
    );

    await resyncChannel(CHANNEL);
    expect(useChat.getState().syncStale[CHANNEL]).toBe(true);
    expect(useChat.getState().loading[CHANNEL]).toBeUndefined();

    mocks.endpoints.changes.mockResolvedValueOnce({ changes: [msg(4)], syncSeq: 4, reset: false });
    await vi.advanceTimersByTimeAsync(2000);

    expect(mocks.endpoints.changes).toHaveBeenCalledTimes(2);
    expect(useChat.getState().syncStale[CHANNEL]).toBe(false);
    expect(useChat.getState().windows[CHANNEL]!.syncSeq).toBe(4);
  });

  it('does not mark a channel read while its window is known to be incomplete', async () => {
    useChat.setState({ windows: { [CHANNEL]: loadedWindow() } });
    mocks.endpoints.changes.mockRejectedValue(
      new ApiError(500, 'internal_error', 'Request failed (500).'),
    );

    await resyncChannel(CHANNEL);
    markChannelRead(CHANNEL);
    expect(mocks.endpoints.markRead).not.toHaveBeenCalled();
  });

  it('backs off instead of re-requesting changes back to back when the gap cannot close', async () => {
    vi.useFakeTimers();
    useChat.setState({ windows: { [CHANNEL]: applyEvent(loadedWindow(), msg(6)) } });
    let calls = 0;
    mocks.endpoints.changes.mockImplementation(async () => {
      calls += 1;
      if (calls > 3) throw new ApiError(500, 'internal_error', 'too many attempts');
      return { changes: [], syncSeq: 3, reset: false };
    });

    await resyncChannel(CHANNEL);
    expect(calls).toBe(1);
    expect(useChat.getState().windows[CHANNEL]!.needsResync).toBe(true);

    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toBe(2);
  });
});

describe('a creation event', () => {
  it('leaves the channel list untouched when nothing about it changed', () => {
    const before = useCommunity.getState().channels;
    onMessageEvent(msg(3));
    expect(useCommunity.getState().channels).toBe(before);

    onMessageEvent(msg(4));
    expect(useCommunity.getState().channels).not.toBe(before);
    expect(useCommunity.getState().channels[0]!.lastMessageSeq).toBe(4);
  });
});
