import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDTO, MessageDTO, MessagePageDTO } from '@hostile/shared';

const mocks = vi.hoisted(() => ({
  endpoints: {
    history: vi.fn(),
    changes: vi.fn(),
    send: vi.fn(),
    forward: vi.fn(),
    markRead: vi.fn(),
    removeAttachment: vi.fn(),
  },
  uploads: [] as { resolve: (a: AttachmentDTO) => void; reject: (e: unknown) => void }[],
}));

vi.mock('../src/api/client', async () => {
  const { ApiError } = await import('../src/api/http');
  class UploadCanceled extends Error {}
  return {
    ApiError,
    UploadCanceled,
    endpoints: mocks.endpoints,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
    uploadAttachment: () => ({
      promise: new Promise<AttachmentDTO>((resolve, reject) => {
        mocks.uploads.push({ resolve, reject });
      }),
      abort() {},
    }),
  };
});

vi.mock('../src/features/chat/local-media', () => ({
  measureLocalMedia: () => Promise.resolve(null),
}));

const { ApiError } = await import('../src/api/http');
const { useCommunity } = await import('../src/stores/community');
const { useSession } = await import('../src/stores/session');
const { selectChannel, useUi } = await import('../src/stores/ui');
const { applyLatestPage, emptyWindow } = await import('../src/features/chat/sync');
const {
  addToTray,
  cancelReply,
  clearJump,
  closeForward,
  composerFocused,
  forwardMessage,
  isUploading,
  keepEditDraft,
  JUMP_CONTEXT_SEQS,
  loadAround,
  loadDrafts,
  loadLatest,
  loadOlder,
  markChannelRead,
  onMessageEvent,
  requestJump,
  resetChat,
  resyncChannel,
  retryPending,
  sendMessage,
  startEditing,
  startForward,
  startReply,
  stopEditing,
  useChat,
} = await import('../src/features/chat/store');

const CHANNEL = '0192d5b0-1111-7000-8000-000000000001';
const OTHER = '0192d5b0-1111-7000-8000-000000000002';

function msg(seq: number, changeSeq = seq, over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: `m${seq}`,
    channelId: CHANNEL,
    authorId: 'u2',
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

const page = (messages: MessageDTO[], syncSeq: number, hasOlder = false): MessagePageDTO => ({
  messages,
  hasOlder,
  syncSeq,
});

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const storage = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};

const pendingRows = () => Object.values(useChat.getState().pending);

function loadWindow(messages: MessageDTO[], syncSeq = messages.at(-1)?.changeSeq ?? 0) {
  useChat.setState((s) => ({
    windows: { ...s.windows, [CHANNEL]: applyLatestPage(emptyWindow(), page(messages, syncSeq)) },
  }));
}

beforeEach(() => {
  storage.clear();
  (globalThis as { window?: unknown }).window = { localStorage: fakeStorage };
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }),
  );
  for (const fn of Object.values(mocks.endpoints)) fn.mockReset();
  mocks.endpoints.markRead.mockResolvedValue({ channelId: CHANNEL, lastReadSeq: 0 });
  mocks.uploads.length = 0;
  useSession.setState({ user: { id: 'u1' } as never });
  useCommunity.setState({
    channels: [
      { id: CHANNEL, name: 'general', type: 'text', position: 0, lastMessageSeq: 100 },
      { id: OTHER, name: 'other', type: 'text', position: 1, lastMessageSeq: 100 },
    ],
    readStates: {},
  });
  resetChat();
  loadDrafts('u1');
});

afterEach(() => {
  resetChat();
  useUi.setState({ toasts: [] });
  vi.unstubAllGlobals();
});

const delivered = (nonce: string, over: Partial<MessageDTO> = {}) =>
  msg(200, 200, { authorId: 'u1', clientNonce: nonce, ...over });

describe('a reply being written', () => {
  it('is held per channel, and asks for the text field', () => {
    startReply(msg(1));
    expect(useChat.getState().replies[CHANNEL]).toMatchObject({ id: 'm1', excerpt: 'message 1' });
    expect(useChat.getState().replies[OTHER]).toBeUndefined();
    expect(useChat.getState().composerFocus).toBe(CHANNEL);
    composerFocused();
    expect(useChat.getState().composerFocus).toBeNull();
  });

  it('asks for the text field again for the same message', () => {
    startReply(msg(1));
    composerFocused();
    startReply(msg(1));
    expect(useChat.getState().composerFocus).toBe(CHANNEL);
  });

  it('starting another replaces it, and cancelling clears it', () => {
    startReply(msg(1));
    startReply(msg(2));
    expect(useChat.getState().replies[CHANNEL]?.id).toBe('m2');
    cancelReply(CHANNEL);
    expect(useChat.getState().replies[CHANNEL]).toBeUndefined();
  });

  it('is not saved across a reload', () => {
    startReply(msg(1));
    expect(JSON.stringify([...storage.values()])).not.toContain('m1');
    resetChat();
    loadDrafts('u1');
    expect(useChat.getState().replies[CHANNEL]).toBeUndefined();
  });

  it('follows the original if it is edited meanwhile, or deleted', () => {
    startReply(msg(1));
    onMessageEvent(msg(1, 5, { content: 'edited' }));
    expect(useChat.getState().replies[CHANNEL]?.excerpt).toBe('edited');
    onMessageEvent(msg(1, 6, { content: '', deleted: true }));
    expect(useChat.getState().replies[CHANNEL]).toMatchObject({ deleted: true, excerpt: '' });
  });

  it('follows it when the change comes through a resync', async () => {
    loadWindow([msg(1), msg(2)]);
    startReply(msg(1));
    mocks.endpoints.changes.mockResolvedValue({
      changes: [msg(1, 5, { content: 'edited' })],
      syncSeq: 5,
      reset: false,
    });
    await resyncChannel(CHANNEL);
    expect(useChat.getState().replies[CHANNEL]?.excerpt).toBe('edited');
  });

  it('is left alone by news of other messages', () => {
    startReply(msg(1));
    const before = useChat.getState().replies[CHANNEL];
    onMessageEvent(msg(2, 5, { content: 'something else' }));
    onMessageEvent(msg(3));
    expect(useChat.getState().replies[CHANNEL]).toBe(before);
  });
});

describe('sending a reply', () => {
  it('goes with the send and is cleared by it', async () => {
    mocks.endpoints.send.mockImplementation(async (_c, _t, nonce: string) => ({
      message: delivered(nonce),
      duplicate: false,
    }));
    loadWindow([msg(1)]);
    startReply(msg(1));
    sendMessage(CHANNEL, 'an answer');
    expect(useChat.getState().replies[CHANNEL]).toBeUndefined();
    await flush();
    const [channel, text, nonce, files, replyToId] = mocks.endpoints.send.mock.calls[0]!;
    expect([channel, text]).toEqual([CHANNEL, 'an answer']);
    expect(nonce).toEqual(expect.any(String));
    expect(files).toEqual([]);
    expect(replyToId).toBe('m1');
  });

  it('leaves a plain message exactly as it was: no extra arguments, nothing extra saved', async () => {
    let answer: (v: unknown) => void = () => {};
    mocks.endpoints.send.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    sendMessage(CHANNEL, 'plain');
    const row = pendingRows()[0]!;
    expect(row).not.toHaveProperty('replyToId');
    expect(row).not.toHaveProperty('replyQuote');
    expect(mocks.endpoints.send.mock.calls[0]).toHaveLength(3);
    answer({ message: delivered(row.nonce), duplicate: false });
    await flush();
  });

  it('shows the quote on its pending row, and a reply in one channel does not touch another', () => {
    mocks.endpoints.send.mockReturnValue(new Promise(() => {}));
    startReply(msg(1));
    startReply(msg(2, 2, { channelId: OTHER }));
    sendMessage(CHANNEL, 'here');
    expect(pendingRows()[0]).toMatchObject({
      replyToId: 'm1',
      replyQuote: { id: 'm1', excerpt: 'message 1' },
    });
    expect(useChat.getState().replies[OTHER]?.id).toBe('m2');
  });

  it('works with only files, once they are up', async () => {
    vi.stubGlobal(
      'File',
      class {
        name = 'a.png';
        size = 10;
        type = 'image/png';
      },
    );
    mocks.endpoints.send.mockImplementation(async (_c, _t, nonce: string) => ({
      message: delivered(nonce),
      duplicate: false,
    }));
    addToTray(CHANNEL, [new File([], 'a.png', { type: 'image/png' })]);
    startReply(msg(1));
    sendMessage(CHANNEL, '');
    expect(pendingRows()[0]).toMatchObject({ replyToId: 'm1', status: 'uploading' });
    await flush();
    mocks.uploads[0]!.resolve({ id: 'att1' } as AttachmentDTO);
    await flush();
    const call = mocks.endpoints.send.mock.calls[0]!;
    expect(call[1]).toBe('');
    expect(call[3]).toEqual(['att1']);
    expect(call[4]).toBe('m1');
  });

  it('a retry sends the same target under the same nonce', async () => {
    mocks.endpoints.send.mockRejectedValueOnce(new ApiError(400, 'validation_error', 'nope'));
    startReply(msg(1));
    sendMessage(CHANNEL, 'an answer');
    await flush();
    const row = pendingRows()[0]!;
    expect(row.status).toBe('failed');
    expect(row.replyToId).toBe('m1');
    mocks.endpoints.send.mockImplementation(async (_c, _t, nonce: string) => ({
      message: delivered(nonce),
      duplicate: false,
    }));
    retryPending(row.nonce);
    await flush();
    const [first, second] = mocks.endpoints.send.mock.calls;
    expect(second![2]).toBe(first![2]);
    expect(second![4]).toBe('m1');
    expect(pendingRows()).toEqual([]);
  });

  it('comes back after a reload with its target and enough to draw the quote', () => {
    mocks.endpoints.send.mockReturnValue(new Promise(() => {}));
    startReply(msg(1));
    sendMessage(CHANNEL, 'an answer');
    resetChat();
    loadDrafts('u1');
    const row = pendingRows()[0]!;
    expect(row.status).toBe('failed');
    expect(row.replyToId).toBe('m1');
    expect(row.replyQuote).toMatchObject({ id: 'm1', excerpt: 'message 1', deleted: false });
  });

  it('keeps the target but not a quote it cannot trust, from whatever storage held', () => {
    storage.set(
      'hostile:pending:u1',
      JSON.stringify([
        {
          nonce: 'n',
          channelId: CHANNEL,
          content: 'x',
          replyToId: 'm1',
          replyQuote: { id: 'm1', excerpt: 42 },
        },
        { nonce: 'n2', channelId: CHANNEL, content: 'y', replyToId: 7 },
      ]),
    );
    loadDrafts('u1');
    const rows = useChat.getState().pending;
    expect(rows.n).toMatchObject({ replyToId: 'm1' });
    expect(rows.n).not.toHaveProperty('replyQuote');
    expect(rows.n2).not.toHaveProperty('replyToId');
  });

  it('keeps a pending row current, and saves that', () => {
    mocks.endpoints.send.mockReturnValue(new Promise(() => {}));
    startReply(msg(1));
    sendMessage(CHANNEL, 'an answer');
    onMessageEvent(msg(1, 5, { content: 'edited' }));
    expect(pendingRows()[0]?.replyQuote?.excerpt).toBe('edited');
    expect(storage.get('hostile:pending:u1')).toContain('edited');
  });

  it('takes the reader along, unlike a plain message sent from up the channel', () => {
    mocks.endpoints.send.mockReturnValue(new Promise(() => {}));
    loadWindow([msg(1)]);
    useChat.setState({ following: { [CHANNEL]: false } });
    sendMessage(CHANNEL, 'plain');
    expect(useChat.getState().following[CHANNEL]).toBe(false);
    startReply(msg(1));
    sendMessage(CHANNEL, 'an answer');
    expect(useChat.getState().following[CHANNEL]).toBe(true);
  });
});

describe('editing', () => {
  it('is one message per channel', () => {
    startEditing(CHANNEL, 'm1');
    startEditing(OTHER, 'm9');
    startEditing(CHANNEL, 'm2');
    expect(useChat.getState().editing).toMatchObject({ [CHANNEL]: 'm2', [OTHER]: 'm9' });
    stopEditing(CHANNEL);
    expect(useChat.getState().editing[CHANNEL]).toBeUndefined();
    expect(useChat.getState().editing[OTHER]).toBe('m9');
  });

  it('stopped by its id, leaves alone an edit started since', () => {
    startEditing(CHANNEL, 'm1');
    startEditing(CHANNEL, 'm2');
    expect(stopEditing(CHANNEL, 'm1')).toBe(false);
    expect(useChat.getState().editing[CHANNEL]).toBe('m2');
    expect(stopEditing(CHANNEL, 'm2')).toBe(true);
    expect(useChat.getState().editing[CHANNEL]).toBeUndefined();
    expect(stopEditing(CHANNEL, 'm2')).toBe(false);
  });

  it('keeps what has been typed for as long as the edit lasts, and no longer', () => {
    startEditing(CHANNEL, 'm1');
    expect(useChat.getState().editDrafts[CHANNEL]).toBeUndefined();
    keepEditDraft(CHANNEL, 'half a thought');
    expect(useChat.getState().editDrafts[CHANNEL]).toBe('half a thought');
    startEditing(CHANNEL, 'm2');
    expect(useChat.getState().editDrafts[CHANNEL]).toBeUndefined();
    keepEditDraft(CHANNEL, 'a second thought');
    stopEditing(CHANNEL);
    expect(useChat.getState().editDrafts[CHANNEL]).toBeUndefined();
  });
});

describe('jumping', () => {
  const target = { messageId: 'm30', seq: 30 };
  const elsewhere = { messageId: 'm10', seq: 10 };

  const jump = (to: { messageId: string; seq: number } = target) => {
    requestJump(CHANNEL, to);
    return loadAround(CHANNEL, to);
  };

  const heldHistory = () => {
    const answers: ((p: MessagePageDTO) => void)[] = [];
    mocks.endpoints.history.mockImplementation(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    return answers;
  };

  const shown = () => useChat.getState().windows[CHANNEL]!.messages.map((m) => m.id);

  it('asks for a page far enough past the target to show it in context', async () => {
    loadWindow([msg(90)]);
    mocks.endpoints.history.mockResolvedValue(page([msg(30)], 90, true));
    expect(await jump()).toBe(true);
    expect(mocks.endpoints.history).toHaveBeenCalledWith(CHANNEL, 30 + JUMP_CONTEXT_SEQS, 50);
    const w = useChat.getState().windows[CHANNEL]!;
    expect(w.messages.map((m) => m.id)).toEqual(['m30']);
    expect(w.hasNewer).toBe(true);
    expect(useChat.getState().loading[CHANNEL]).toBeUndefined();
  });

  it('leaves the reader where they are if the message has gone since', async () => {
    loadWindow([msg(90)]);
    mocks.endpoints.history.mockResolvedValue(page([msg(29)], 90, true));
    expect(await jump()).toBe(false);
    expect(useChat.getState().windows[CHANNEL]!.messages.map((m) => m.id)).toEqual(['m90']);
    expect(useUi.getState().toasts.at(-1)?.text).toBe('That message is no longer there.');
  });

  it('says so if the page cannot be loaded', async () => {
    loadWindow([msg(90)]);
    mocks.endpoints.history.mockRejectedValue(new Error('offline'));
    expect(await jump()).toBe(false);
    expect(useChat.getState().windows[CHANNEL]!.messages.map((m) => m.id)).toEqual(['m90']);
    expect(useUi.getState().toasts.at(-1)?.text).toContain('offline');
    expect(useChat.getState().loading[CHANNEL]).toBeUndefined();
  });

  it('does not mark the channel read from a page in the past', async () => {
    loadWindow([msg(90)]);
    mocks.endpoints.history.mockResolvedValue(page([msg(30)], 90, true));
    await jump();
    markChannelRead(CHANNEL);
    expect(mocks.endpoints.markRead).not.toHaveBeenCalled();
  });

  it('drops an older page still on its way, which would leave a hole in the new window', async () => {
    loadWindow([msg(90)]);
    useChat.setState((s) => ({
      windows: { ...s.windows, [CHANNEL]: { ...s.windows[CHANNEL]!, hasOlder: true } },
    }));
    let answerOlder: (p: MessagePageDTO) => void = () => {};
    mocks.endpoints.history.mockReturnValueOnce(new Promise((resolve) => (answerOlder = resolve)));
    const older = loadOlder(CHANNEL);
    mocks.endpoints.history.mockResolvedValueOnce(page([msg(30)], 90, true));
    await jump();
    answerOlder(page([msg(80)], 90, true));
    await older;
    expect(useChat.getState().windows[CHANNEL]!.messages.map((m) => m.id)).toEqual(['m30']);
  });

  it('drops an older page that started after a jump and lands after its page', async () => {
    loadWindow([msg(90)]);
    useChat.setState((s) => ({
      windows: { ...s.windows, [CHANNEL]: { ...s.windows[CHANNEL]!, hasOlder: true } },
    }));
    const answers = heldHistory();
    const jumping = jump();
    mocks.endpoints.changes.mockResolvedValue({ changes: [], syncSeq: 90, reset: false });
    await resyncChannel(CHANNEL);
    expect(useChat.getState().loading[CHANNEL]).toBeUndefined();
    const older = loadOlder(CHANNEL);
    expect(useChat.getState().loading[CHANNEL]).toBe('older');
    answers[0]!(page([msg(30)], 90, true));
    await jumping;
    answers[1]!(page([msg(80)], 90, true));
    await older;
    expect(shown()).toEqual(['m30']);
    expect(useChat.getState().loading[CHANNEL]).toBeUndefined();
  });

  it('asks for the changes since a stale older page was read, which can still repair it', async () => {
    loadWindow([msg(90)], 100);
    useChat.setState((s) => ({
      windows: { ...s.windows, [CHANNEL]: { ...s.windows[CHANNEL]!, hasOlder: true } },
    }));
    mocks.endpoints.history.mockResolvedValue(page([msg(80)], 99, true));
    mocks.endpoints.changes.mockResolvedValue({
      changes: [msg(80, 100, { content: 'edited since' })],
      syncSeq: 100,
      reset: false,
    });
    await loadOlder(CHANNEL);
    await flush();
    expect(mocks.endpoints.changes).toHaveBeenCalledWith(CHANNEL, 99);
    const w = useChat.getState().windows[CHANNEL]!;
    expect(w.messages[0]?.content).toBe('edited since');
    expect(w.syncSeq).toBe(100);
    expect(w.needsResync).toBe(false);
  });

  it('still applies an older page to the window it was asked for', async () => {
    loadWindow([msg(90)]);
    useChat.setState((s) => ({
      windows: { ...s.windows, [CHANNEL]: { ...s.windows[CHANNEL]!, hasOlder: true } },
    }));
    mocks.endpoints.history.mockResolvedValue(page([msg(80)], 90, true));
    await loadOlder(CHANNEL);
    expect(shown()).toEqual(['m80', 'm90']);
  });

  describe('lets the later of two window loads win', () => {
    const latest = () => loadLatest(CHANNEL);
    const present = page([msg(90)], 90);
    const past = page([msg(30)], 90, true);

    it.each([
      ['the earlier lands first', [0, 1]],
      ['the later lands first', [1, 0]],
    ])('a jump, then the latest page, when %s', async (_name, order) => {
      loadWindow([msg(90)]);
      const answers = heldHistory();
      const loads = [jump(), latest()];
      const pages = [past, present];
      for (const at of order) {
        answers[at]!(pages[at]!);
        await flush();
      }
      expect(await loads[0]).toBe(false);
      await loads[1];
      const w = useChat.getState().windows[CHANNEL]!;
      expect(w.messages.map((m) => m.id)).toEqual(['m90']);
      expect(w.hasNewer).toBe(false);
      expect(useChat.getState().loading[CHANNEL]).toBeUndefined();
    });

    it.each([
      ['the earlier lands first', [0, 1]],
      ['the later lands first', [1, 0]],
    ])('the latest page, then a jump, when %s', async (_name, order) => {
      loadWindow([msg(90)]);
      const answers = heldHistory();
      const loads = [latest(), jump()];
      const pages = [present, past];
      for (const at of order) {
        answers[at]!(pages[at]!);
        await flush();
      }
      await loads[0];
      expect(await loads[1]).toBe(true);
      const w = useChat.getState().windows[CHANNEL]!;
      expect(w.messages.map((m) => m.id)).toEqual(['m30']);
      expect(w.hasNewer).toBe(true);
      expect(useChat.getState().loading[CHANNEL]).toBeUndefined();
    });
  });

  it.each([
    ['the earlier lands first', [0, 1]],
    ['the later lands first', [1, 0]],
  ])('a second jump takes over from the first when %s', async (_name, order) => {
    loadWindow([msg(90)]);
    const answers = heldHistory();
    const first = jump();
    const second = jump(elsewhere);
    const pages = [page([msg(30)], 90, true), page([msg(10)], 90, true)];
    for (const at of order) {
      answers[at]!(pages[at]!);
      await flush();
    }
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(shown()).toEqual(['m10']);
    expect(useChat.getState().jumps[CHANNEL]).toEqual(elsewhere);
  });

  it('a jump given up on while its page is on its way does not land, or complain', async () => {
    loadWindow([msg(90)]);
    const answers = heldHistory();
    const gaveUp = jump();
    expect(useChat.getState().loading[CHANNEL]).toBe('jump');
    clearJump(CHANNEL);
    expect(useChat.getState().loading[CHANNEL]).toBeUndefined();
    answers[0]!(page([msg(30)], 90, true));
    expect(await gaveUp).toBe(false);
    expect(shown()).toEqual(['m90']);
    expect(useChat.getState().windows[CHANNEL]!.hasNewer).toBe(false);
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('nor does it complain if its page then fails', async () => {
    loadWindow([msg(90)]);
    let fail: (e: unknown) => void = () => {};
    mocks.endpoints.history.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const gaveUp = jump();
    clearJump(CHANNEL);
    fail(new Error('offline'));
    expect(await gaveUp).toBe(false);
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('leaving a channel forgets the jump waiting there, and not the one being gone to', () => {
    useUi.setState({ selectedChannelId: CHANNEL });
    requestJump(CHANNEL, target);
    const destination = { messageId: 'm1', seq: 1 };
    requestJump(OTHER, destination);
    selectChannel(OTHER);
    expect(useChat.getState().jumps[CHANNEL]).toBeUndefined();
    expect(useChat.getState().jumps[OTHER]).toEqual(destination);
    selectChannel(OTHER);
    expect(useChat.getState().jumps[OTHER]).toEqual(destination);
    useUi.setState({ selectedChannelId: null });
  });

  it('a request does nothing by itself and waits, per channel, until it is cleared', async () => {
    loadWindow([msg(90)]);
    requestJump(CHANNEL, target);
    requestJump(OTHER, { messageId: 'm1', seq: 1 });
    await flush();
    expect(mocks.endpoints.history).not.toHaveBeenCalled();
    expect(shown()).toEqual(['m90']);
    onMessageEvent(msg(91));
    mocks.endpoints.history.mockResolvedValue(page([msg(90)], 91));
    await loadLatest(CHANNEL);
    expect(useChat.getState().jumps[CHANNEL]).toEqual(target);
    clearJump(CHANNEL);
    expect(useChat.getState().jumps[CHANNEL]).toBeUndefined();
    expect(useChat.getState().jumps[OTHER]).toEqual({ messageId: 'm1', seq: 1 });
  });

  it('sending from a window away from the present goes back to it', async () => {
    useChat.setState((s) => ({
      windows: {
        ...s.windows,
        [CHANNEL]: {
          ...applyLatestPage(emptyWindow(), page([msg(30)], 90)),
          hasNewer: true,
        },
      },
      following: { [CHANNEL]: false },
    }));
    mocks.endpoints.send.mockImplementation(async (_c, _t, nonce: string) => ({
      message: delivered(nonce),
      duplicate: false,
    }));
    mocks.endpoints.history.mockResolvedValue(page([msg(90)], 90));
    sendMessage(CHANNEL, 'back to the present');
    expect(useChat.getState().following[CHANNEL]).toBe(true);
    await flush();
    await flush();
    expect(useChat.getState().windows[CHANNEL]!.hasNewer).toBe(false);
  });
});

describe('a forward whose original is deleted', () => {
  const origin = {
    messageId: 'm1',
    seq: 1,
    authorId: 'u2',
    channelId: CHANNEL,
    channelName: 'general',
    createdAt: '2026-01-02T03:04:05.000Z',
  };
  const copy = (seq: number, messageId = 'm1') =>
    msg(seq, seq, {
      id: `copy${seq}`,
      channelId: OTHER,
      forwardedFrom: { ...origin, messageId, seq: messageId === 'm1' ? 1 : 2 },
    });

  function loadForwards(messages: MessageDTO[]) {
    useChat.setState((s) => ({
      windows: {
        ...s.windows,
        [OTHER]: applyLatestPage(emptyWindow(), page(messages, messages.at(-1)?.changeSeq ?? 0)),
      },
    }));
  }

  const origins = () =>
    useChat.getState().windows[OTHER]!.messages.map((m) => m.forwardedFrom?.messageId);

  it('stops offering the way there, wherever the forward is held, as soon as that is heard', () => {
    loadWindow([msg(1)]);
    loadForwards([copy(5), copy(6, 'm2')]);
    const untouched = useChat.getState().windows[OTHER]!.messages[1];
    onMessageEvent(msg(1, 7, { content: '', deleted: true }));
    expect(origins()).toEqual([null, 'm2']);
    expect(useChat.getState().windows[OTHER]!.messages[0]!.forwardedFrom).toMatchObject({
      seq: null,
      authorId: 'u2',
      channelName: 'general',
    });
    expect(useChat.getState().windows[OTHER]!.messages[1]).toBe(untouched);
  });

  it('hears the same from a resync', async () => {
    loadWindow([msg(1)]);
    loadForwards([copy(5)]);
    mocks.endpoints.changes.mockResolvedValue({
      changes: [msg(1, 7, { content: '', deleted: true })],
      syncSeq: 7,
      reset: false,
    });
    await resyncChannel(CHANNEL);
    expect(origins()).toEqual([null]);
  });

  it('is not disturbed by an edit of the original', () => {
    loadWindow([msg(1)]);
    loadForwards([copy(5)]);
    const before = useChat.getState().windows[OTHER]!.messages;
    onMessageEvent(msg(1, 7, { content: 'edited' }));
    expect(useChat.getState().windows[OTHER]!.messages).toBe(before);
  });
});

describe('forwarding', () => {
  it('the dialog is open for one message at a time', () => {
    startForward(msg(1));
    expect(useChat.getState().forwarding?.id).toBe('m1');
    startForward(msg(2));
    expect(useChat.getState().forwarding?.id).toBe('m2');
    closeForward();
    expect(useChat.getState().forwarding).toBeNull();
  });

  it('applies what comes back to the target, and leaves the reader where they are', async () => {
    loadWindow([msg(1)]);
    useChat.setState((s) => ({
      windows: { ...s.windows, [OTHER]: applyLatestPage(emptyWindow(), page([], 0)) },
    }));
    const copy = msg(50, 50, { channelId: OTHER, id: 'copy' });
    mocks.endpoints.forward.mockResolvedValue({ message: copy, duplicate: false });
    useUi.setState({ selectedChannelId: CHANNEL });
    await forwardMessage('m1', OTHER, 'nonce');
    expect(mocks.endpoints.forward).toHaveBeenCalledWith('m1', OTHER, 'nonce');
    expect(useChat.getState().windows[OTHER]!.messages.map((m) => m.id)).toEqual(['copy']);
    expect(useChat.getState().windows[CHANNEL]!.messages.map((m) => m.id)).toEqual(['m1']);
    expect(useUi.getState().selectedChannelId).toBe(CHANNEL);
  });

  it('throws what went wrong, for the dialog to say', async () => {
    mocks.endpoints.forward.mockRejectedValue(new ApiError(404, 'not_found', 'Message not found.'));
    await expect(forwardMessage('m1', OTHER, 'nonce')).rejects.toThrow('Message not found.');
  });
});

describe('what closing the tab would lose', () => {
  it('is any upload, running or waiting its turn, and nothing else', () => {
    const row = (status: string, files = true) =>
      ({
        nonce: 'n',
        channelId: CHANNEL,
        content: '',
        status,
        ...(files ? { files: [] } : {}),
      }) as never;
    expect(isUploading({})).toBe(false);
    expect(isUploading({ a: row('uploading') })).toBe(true);
    expect(isUploading({ a: row('waiting') })).toBe(true);
    expect(isUploading({ a: row('sending'), b: row('failed') })).toBe(false);
    expect(isUploading({ a: row('retrying', false) })).toBe(false);
  });
});

describe('signing out', () => {
  it('forgets all of it', () => {
    startReply(msg(1));
    startEditing(CHANNEL, 'm1');
    keepEditDraft(CHANNEL, 'half a thought');
    requestJump(CHANNEL, { messageId: 'm1', seq: 1 });
    startForward(msg(1));
    resetChat();
    const s = useChat.getState();
    expect(s.replies).toEqual({});
    expect(s.editing).toEqual({});
    expect(s.editDrafts).toEqual({});
    expect(s.jumps).toEqual({});
    expect(s.forwarding).toBeNull();
    expect(s.composerFocus).toBeNull();
  });
});
