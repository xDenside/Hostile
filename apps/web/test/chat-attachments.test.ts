import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDTO, MessageDTO } from '@hostile/shared';

interface Job {
  channelId: string;
  name: string | undefined;
  width: number | null | undefined;
  onProgress: (percent: number) => void;
  resolve: (a: AttachmentDTO) => void;
  reject: (err: unknown) => void;
  aborted: boolean;
}

const mocks = vi.hoisted(() => ({
  jobs: [] as Job[],
  endpoints: {
    history: vi.fn(),
    send: vi.fn(),
    markRead: vi.fn(),
    removeAttachment: vi.fn(),
  },
  measure: vi.fn(),
}));

vi.mock('../src/api/client', async () => {
  const { ApiError } = await import('../src/api/http');
  class UploadCanceled extends Error {}
  return {
    ApiError,
    UploadCanceled,
    endpoints: mocks.endpoints,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
    uploadAttachment: (
      channelId: string,
      _file: Blob,
      details: { name?: string; width?: number | null },
      onProgress: (percent: number) => void,
    ) => {
      const job = {
        channelId,
        name: details.name,
        width: details.width,
        onProgress,
        aborted: false,
      } as Job;
      const promise = new Promise<AttachmentDTO>((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      mocks.jobs.push(job);
      return {
        promise,
        abort() {
          job.aborted = true;
          job.reject(new UploadCanceled());
        },
      };
    },
  };
});

vi.mock('../src/features/chat/local-media', () => ({ measureLocalMedia: mocks.measure }));

const { ApiError } = await import('../src/api/http');
const { useCommunity } = await import('../src/stores/community');
const { useSession } = await import('../src/stores/session');
const { applyLatestPage, emptyWindow } = await import('../src/features/chat/sync');
const {
  addToTray,
  canRetryPending,
  canSendWhatGotThrough,
  deliveredPreview,
  discardPending,
  loadDrafts,
  localPreviewUrl,
  onMessageEvent,
  removeFromTray,
  resetChat,
  retryPending,
  sendMessage,
  sendWhatGotThrough,
  setDraft,
  useChat,
} = await import('../src/features/chat/store');

const CHANNEL = '0192d5b0-1111-7000-8000-000000000001';
const OTHER = '0192d5b0-1111-7000-8000-000000000002';

const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const png = (name: string, size = 10) =>
  new File([new Uint8Array(size)], name, { type: 'image/png' });
const webm = (name: string) => new File([new Uint8Array(10)], name, { type: 'video/webm' });

function attachment(id: string, kind: 'image' | 'video' = 'image'): AttachmentDTO {
  return {
    id,
    kind,
    url: `/api/attachments/${id}`,
    contentType: 'image/png',
    fileName: `${id}.png`,
    byteSize: 10,
    width: 10,
    height: 10,
  };
}

function delivered(nonce: string, attachments: AttachmentDTO[], content = ''): MessageDTO {
  return {
    id: 'm1',
    channelId: CHANNEL,
    authorId: 'u1',
    content,
    seq: 1,
    changeSeq: 1,
    clientNonce: nonce,
    createdAt: '2026-01-02T03:04:05.000Z',
    editedAt: null,
    deleted: false,
    attachments,
    replyTo: null,
    forwardedFrom: null,
  };
}

const pendingList = () => Object.values(useChat.getState().pending);
const only = () => pendingList()[0]!;
const saved = () => JSON.parse(store.get('hostile:pending:u1') ?? '[]') as unknown[];
const uploadStarted = (count: number) => vi.waitFor(() => expect(mocks.jobs).toHaveLength(count));

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { localStorage };
  store.clear();
  resetChat();
  mocks.jobs.length = 0;
  useCommunity.setState({ channels: [], readStates: {} });
  for (const fn of Object.values(mocks.endpoints)) fn.mockReset();
  mocks.endpoints.removeAttachment.mockResolvedValue(undefined);
  mocks.measure.mockReset();
  mocks.measure.mockResolvedValue(null);
  useChat.setState({
    windows: {
      [CHANNEL]: applyLatestPage(emptyWindow(), { messages: [], hasOlder: false, syncSeq: 0 }),
    },
  });
  loadDrafts('u1');
});

afterEach(() => {
  resetChat();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the tray', () => {
  it('belongs to one channel, and holds nothing that could not be saved', () => {
    addToTray(CHANNEL, [png('a.png'), webm('b.webm')]);
    const tray = useChat.getState().trays[CHANNEL]!;
    expect(tray.map((f) => [f.name, f.kind])).toEqual([
      ['a.png', 'image'],
      ['b.webm', 'video'],
    ]);
    expect(useChat.getState().trays[OTHER]).toBeUndefined();
    expect(JSON.parse(JSON.stringify(tray))).toEqual(tray);
    expect(localPreviewUrl(tray[0]!.id)).toMatch(/^blob:/);
  });

  it('turns a refused file away with a reason, and takes the rest', () => {
    addToTray(CHANNEL, [new File(['x'], 'a.txt', { type: 'text/plain' }), png('ok.png')]);
    expect(useChat.getState().trays[CHANNEL]!.map((f) => f.name)).toEqual(['ok.png']);
    expect(useChat.getState().trayNotices[CHANNEL]).toContain('"a.txt"');
    addToTray(CHANNEL, [png('next.png')]);
    expect(useChat.getState().trayNotices[CHANNEL]).toBeUndefined();
  });

  it('stops at the limit, across more than one batch', () => {
    addToTray(
      CHANNEL,
      Array.from({ length: 9 }, (_, i) => png(`${i}.png`)),
    );
    addToTray(CHANNEL, [png('x.png'), png('y.png')]);
    expect(useChat.getState().trays[CHANNEL]).toHaveLength(10);
    expect(useChat.getState().trayNotices[CHANNEL]).toContain('one was left out');
  });

  it('lets go of the preview of a file taken out', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    addToTray(CHANNEL, [png('a.png')]);
    const file = useChat.getState().trays[CHANNEL]![0]!;
    const url = localPreviewUrl(file.id)!;
    removeFromTray(CHANNEL, file.id);
    expect(useChat.getState().trays[CHANNEL]).toEqual([]);
    expect(revoke).toHaveBeenCalledWith(url);
    expect(localPreviewUrl(file.id)).toBeNull();
  });

  it('lets go of everything at sign-out', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    resetChat();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(useChat.getState().trays).toEqual({});
  });

  it('adds a late measurement to the tray or to the row the file has since moved to', async () => {
    let answer!: (size: { width: number; height: number }) => void;
    mocks.measure.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    addToTray(CHANNEL, [webm('b.webm')]);
    sendMessage(CHANNEL, '');
    expect(only().files![0]!.width).toBeNull();
    expect(mocks.jobs).toHaveLength(0);
    answer({ width: 1280, height: 720 });
    await uploadStarted(1);
    expect(only().files![0]).toMatchObject({ width: 1280, height: 720 });
    expect(mocks.jobs[0]!.width).toBe(1280);
  });
});

describe('sending files', () => {
  it('clears the composer at once, uploads one at a time, then sends the message with the ids', async () => {
    mocks.endpoints.send.mockImplementation((_c, _t, nonce: string) =>
      Promise.resolve({ message: delivered(nonce, [attachment('a1'), attachment('a2')]) }),
    );
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    sendMessage(CHANNEL, 'hello');

    expect(useChat.getState().trays[CHANNEL]).toEqual([]);
    expect(only().status).toBe('uploading');
    expect(only().content).toBe('hello');

    await uploadStarted(1);
    expect(mocks.jobs[0]!.name).toBe('a.png');
    expect(mocks.jobs[0]!.channelId).toBe(CHANNEL);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await uploadStarted(2);
    expect(mocks.jobs[1]!.name).toBe('b.png');
    expect(mocks.endpoints.send).not.toHaveBeenCalled();
    mocks.jobs[1]!.resolve(attachment('a2'));

    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    const [channel, text, , ids] = mocks.endpoints.send.mock.calls[0]!;
    expect([channel, text, ids]).toEqual([CHANNEL, 'hello', ['a1', 'a2']]);
    expect(useChat.getState().windows[CHANNEL]!.messages).toHaveLength(1);
  });

  it('can send files with no text at all', async () => {
    mocks.endpoints.send.mockImplementation((_c, _t, nonce: string) =>
      Promise.resolve({ message: delivered(nonce, [attachment('a1')]) }),
    );
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, '');
    expect(only().content).toBe('');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(mocks.endpoints.send.mock.calls[0]![1]).toBe('');
  });

  it('sends a plain message exactly as it always did', async () => {
    mocks.endpoints.send.mockImplementation((_c, _t, nonce: string) =>
      Promise.resolve({ message: delivered(nonce, [], 'words') }),
    );
    sendMessage(CHANNEL, 'words');
    expect(Object.keys(saved()[0] as object).sort()).toEqual([
      'attempts',
      'channelId',
      'content',
      'createdAt',
      'error',
      'nonce',
      'status',
    ]);
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(mocks.endpoints.send.mock.calls[0]).toHaveLength(3);
    expect(mocks.jobs).toHaveLength(0);
  });

  it('keeps progress out of what is saved, and off the row', async () => {
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    const before = store.get('hostile:pending:u1');
    const row = useChat.getState().pending;
    mocks.jobs[0]!.onProgress(40);
    const id = only().files![0]!.id;
    expect(useChat.getState().uploadPercent[id]).toBe(40);
    expect(store.get('hostile:pending:u1')).toBe(before);
    expect(useChat.getState().pending).toBe(row);
  });

  it('removes the row and holds on to an image preview when the socket gets there first', async () => {
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    const url = localPreviewUrl(only().files![0]!.id);
    const nonce = only().nonce;
    let answer!: (value: unknown) => void;
    mocks.endpoints.send.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    mocks.jobs[0]!.resolve(attachment('a1'));
    await vi.waitFor(() => expect(only().status).toBe('sending'));
    useSession.setState({ user: { id: 'u1' } as never });
    onMessageEvent(delivered(nonce, [attachment('a1')]));
    expect(pendingList()).toEqual([]);
    expect(deliveredPreview('a1')?.url).toBe(url);
    answer({ message: delivered(nonce, [attachment('a1')]) });
  });

  it('lets go of a delivered preview after a while', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    mocks.endpoints.send.mockImplementation((_c, _t, nonce: string) =>
      Promise.resolve({ message: delivered(nonce, [attachment('a1')]) }),
    );
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, '');
    await vi.waitFor(() => expect(mocks.jobs).toHaveLength(1));
    mocks.jobs[0]!.resolve(attachment('a1'));
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(deliveredPreview('a1')).not.toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(deliveredPreview('a1')).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('does not hold on to a video, which could not keep playing from a preview anyway', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    mocks.endpoints.send.mockImplementation((_c, _t, nonce: string) =>
      Promise.resolve({ message: delivered(nonce, [attachment('v1', 'video')]) }),
    );
    addToTray(CHANNEL, [webm('a.webm')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('v1', 'video'));
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(deliveredPreview('v1')).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe('when it fails', () => {
  it('stops on a failed upload and leaves the decision to the member', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, 'hi');
    await vi.waitFor(() => expect(mocks.jobs).toHaveLength(1));
    mocks.jobs[0]!.reject(new ApiError(0, 'network_error', 'Connection lost.'));
    await vi.waitFor(() => expect(only().status).toBe('failed'));
    expect(only().error).toBe('Connection lost.');
    expect(only().files![0]!.failed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(mocks.jobs).toHaveLength(1);
    expect(mocks.endpoints.send).not.toHaveBeenCalled();
  });

  it('names the file when there are several', async () => {
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    mocks.jobs[0]!.reject(new ApiError(415, 'validation_error', 'Not an image.'));
    await vi.waitFor(() => expect(only().status).toBe('failed'));
    expect(only().error).toBe('"a.png": Not an image.');
  });

  it('retries only what has not been uploaded, under the same nonce', async () => {
    mocks.endpoints.send.mockImplementation((_c, _t, nonce: string) =>
      Promise.resolve({ message: delivered(nonce, [attachment('a1'), attachment('a2')]) }),
    );
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await uploadStarted(2);
    mocks.jobs[1]!.reject(new ApiError(0, 'network_error', 'Connection lost.'));
    await vi.waitFor(() => expect(only().status).toBe('failed'));
    const nonce = only().nonce;

    retryPending(nonce);
    expect(only().status).toBe('uploading');
    expect(only().error).toBeNull();
    await uploadStarted(3);
    expect(mocks.jobs[2]!.name).toBe('b.png');
    mocks.jobs[2]!.resolve(attachment('a2'));
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(mocks.endpoints.send.mock.calls[0]!.slice(2)).toEqual([nonce, ['a1', 'a2']]);
  });

  it('shows the first issue of a refused message, not its general heading', async () => {
    mocks.endpoints.send.mockRejectedValue(
      new ApiError(400, 'validation_error', 'Some fields are invalid.', {
        issues: [{ path: 'attachmentIds', message: 'An attachment is listed more than once.' }],
      }),
    );
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await vi.waitFor(() => expect(only().status).toBe('failed'));
    expect(only().error).toBe('An attachment is listed more than once.');
  });

  it('retries the message itself by timer on a transient failure, without touching the files', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.endpoints.send
      .mockRejectedValueOnce(new ApiError(0, 'network_error', 'Cannot reach the server.'))
      .mockImplementation((_c, _t, nonce: string) =>
        Promise.resolve({ message: delivered(nonce, [attachment('a1')]) }),
      );
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, '');
    await vi.waitFor(() => expect(mocks.jobs).toHaveLength(1));
    mocks.jobs[0]!.resolve(attachment('a1'));
    await vi.waitFor(() => expect(only().status).toBe('retrying'));
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(mocks.jobs).toHaveLength(1);
    expect(mocks.endpoints.send).toHaveBeenCalledTimes(2);
  });

  it('discards what the server has, whichever way that goes', async () => {
    mocks.endpoints.removeAttachment.mockRejectedValue(new ApiError(404, 'not_found', 'Gone.'));
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await uploadStarted(2);
    mocks.jobs[1]!.reject(new ApiError(0, 'network_error', 'Connection lost.'));
    await vi.waitFor(() => expect(only().status).toBe('failed'));

    discardPending(only().nonce);
    expect(pendingList()).toEqual([]);
    expect(saved()).toEqual([]);
    expect(mocks.endpoints.removeAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.endpoints.removeAttachment).toHaveBeenCalledWith('a1');
  });

  it('cancels mid-upload: the request stops, and neither row nor message is left', async () => {
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    discardPending(only().nonce);
    expect(mocks.jobs[0]!.aborted).toBe(true);
    expect(pendingList()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.jobs).toHaveLength(1);
    expect(mocks.endpoints.send).not.toHaveBeenCalled();
  });

  it('takes back a file the server answered for in the moment of the cancel', async () => {
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    const job = mocks.jobs[0]!;
    job.resolve(attachment('late'));
    discardPending(only().nonce);
    await vi.waitFor(() => expect(mocks.endpoints.removeAttachment).toHaveBeenCalledWith('late'));
    expect(mocks.endpoints.send).not.toHaveBeenCalled();
  });
});

describe('the line for uploading', () => {
  const message = (name: string, text = '') => {
    addToTray(CHANNEL, [png(name)]);
    sendMessage(CHANNEL, text);
    return pendingList().at(-1)!.nonce;
  };
  const row = (nonce: string) => useChat.getState().pending[nonce]!;
  const started = () => mocks.jobs.map((job) => job.name);

  beforeEach(() => {
    mocks.endpoints.send.mockImplementation((_c, _t, nonce: string) =>
      Promise.resolve({ message: delivered(nonce, []) }),
    );
  });

  it('runs two messages at once, and the third waits and says so', async () => {
    const first = message('a.png');
    const second = message('b.png');
    const third = message('c.png');
    expect(row(first).status).toBe('uploading');
    expect(row(second).status).toBe('uploading');
    expect(row(third).status).toBe('waiting');
    await uploadStarted(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started()).toEqual(['a.png', 'b.png']);

    mocks.jobs[0]!.resolve(attachment('a1'));
    await uploadStarted(3);
    expect(started()[2]).toBe('c.png');
    expect(row(third).status).toBe('uploading');
  });

  it('lets them in the order they were sent, not the order they happen to fit', async () => {
    const nonces = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => message(`${n}.png`));
    await uploadStarted(2);
    mocks.jobs[1]!.resolve(attachment('b1'));
    await uploadStarted(3);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await uploadStarted(4);
    mocks.jobs[3]!.resolve(attachment('d1'));
    await uploadStarted(5);
    expect(started()).toEqual(['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
    expect(row(nonces[5]!).status).toBe('waiting');
  });

  it('starts no request for a file in the line, so a stall clock cannot run on one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    message('a.png');
    message('b.png');
    const third = message('c.png');
    await vi.waitFor(() => expect(mocks.jobs).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(mocks.jobs).toHaveLength(2);
    expect(row(third).status).toBe('waiting');
    expect(row(third).error).toBeNull();
  });

  it("gives a message's next file its turn before another message's first", async () => {
    addToTray(CHANNEL, [png('a1.png'), png('a2.png')]);
    sendMessage(CHANNEL, '');
    message('b.png');
    message('c.png');
    await uploadStarted(2);
    mocks.jobs[0]!.resolve(attachment('x'));
    await uploadStarted(3);
    expect(started()).toEqual(['a1.png', 'b.png', 'a2.png']);
  });

  it('passes the turn on from a failure, and a retry goes to the back of the line', async () => {
    const first = message('a.png');
    message('b.png');
    const third = message('c.png');
    await uploadStarted(2);
    mocks.jobs[0]!.reject(new ApiError(0, 'network_error', 'Connection lost.'));
    await uploadStarted(3);
    expect(started()[2]).toBe('c.png');
    expect(row(first).status).toBe('failed');
    expect(row(third).status).toBe('uploading');

    retryPending(first);
    expect(row(first).status).toBe('waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mocks.jobs).toHaveLength(3);
    mocks.jobs[2]!.resolve(attachment('c1'));
    await uploadStarted(4);
    expect(started()[3]).toBe('a.png');
    expect(row(first).status).toBe('uploading');
  });

  it('passes the turn on from a cancel, and a message can leave the line before its turn', async () => {
    const first = message('a.png');
    message('b.png');
    const third = message('c.png');
    const fourth = message('d.png');
    await uploadStarted(2);

    discardPending(third);
    expect(useChat.getState().pending[third]).toBeUndefined();
    discardPending(first);
    expect(mocks.jobs[0]!.aborted).toBe(true);
    await uploadStarted(3);
    expect(started()[2]).toBe('d.png');
    expect(row(fourth).status).toBe('uploading');
    expect(started()).not.toContain('c.png');
  });

  it('starts nothing twice when a message that is waiting is asked to go again', async () => {
    message('a.png');
    message('b.png');
    const third = message('c.png');
    await uploadStarted(2);
    retryPending(third);
    mocks.jobs[0]!.resolve(attachment('a1'));
    mocks.jobs[1]!.resolve(attachment('b1'));
    await uploadStarted(3);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started().filter((name) => name === 'c.png')).toHaveLength(1);
  });

  it('empties at sign-out, and the next session starts with every slot free', async () => {
    message('a.png');
    message('b.png');
    message('c.png');
    await uploadStarted(2);
    resetChat();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mocks.jobs).toHaveLength(2);
    useChat.setState({
      windows: {
        [CHANNEL]: applyLatestPage(emptyWindow(), { messages: [], hasOlder: false, syncSeq: 0 }),
      },
    });
    mocks.jobs.length = 0;
    message('d.png');
    message('e.png');
    const third = message('f.png');
    await uploadStarted(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mocks.jobs).toHaveLength(2);
    expect(row(third).status).toBe('waiting');
  });

  it('comes back from a reload as a clear failure, not as waiting', async () => {
    message('a.png');
    message('b.png');
    message('c.png');
    await uploadStarted(2);
    const snapshot = new Map(store);
    resetChat();
    store.clear();
    for (const [k, v] of snapshot) store.set(k, v);
    loadDrafts('u1');
    expect(pendingList().map((p) => p.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('leaves a plain text message out of it altogether', async () => {
    message('a.png');
    message('b.png');
    message('c.png');
    await uploadStarted(2);
    mocks.endpoints.send.mockClear();
    sendMessage(CHANNEL, 'words');
    await vi.waitFor(() => expect(mocks.endpoints.send).toHaveBeenCalledTimes(1));
    expect(mocks.endpoints.send.mock.calls[0]![1]).toBe('words');
  });
});

describe('after the server has swept the uploads', () => {
  const swept = () =>
    new ApiError(400, 'attachments_not_claimable', 'Some fields are invalid.', {
      issues: [
        { path: 'attachmentIds', message: 'One of those attachments cannot go on this message.' },
      ],
    });

  function reload() {
    const snapshot = new Map(store);
    resetChat();
    store.clear();
    for (const [k, v] of snapshot) store.set(k, v);
    loadDrafts('u1');
  }

  it('uploads again on Retry whatever this page still holds, under the same nonce', async () => {
    mocks.endpoints.send.mockRejectedValueOnce(swept());
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    sendMessage(CHANNEL, 'hello');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('old1'));
    await uploadStarted(2);
    mocks.jobs[1]!.resolve(attachment('old2'));
    await vi.waitFor(() => expect(only().status).toBe('failed'));

    const nonce = only().nonce;
    expect(only().files!.map((f) => f.attachment)).toEqual([null, null]);
    expect(only().error).toContain('Retry uploads them again');
    expect(canRetryPending(only())).toBe(true);
    expect(mocks.endpoints.removeAttachment.mock.calls.map(([id]) => id)).toEqual(['old1', 'old2']);

    mocks.endpoints.send.mockImplementation((_c, _t, n: string) =>
      Promise.resolve({ message: delivered(n, [attachment('new1'), attachment('new2')]) }),
    );
    retryPending(nonce);
    await uploadStarted(3);
    mocks.jobs[2]!.resolve(attachment('new1'));
    await uploadStarted(4);
    mocks.jobs[3]!.resolve(attachment('new2'));
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(mocks.endpoints.send.mock.lastCall!.slice(2)).toEqual([nonce, ['new1', 'new2']]);
  });

  it('hides Retry when the files went with the page, and says what to do instead', async () => {
    mocks.endpoints.send.mockReturnValueOnce(new Promise(() => undefined));
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, 'hello');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('old1'));
    await vi.waitFor(() => expect(only().status).toBe('sending'));
    reload();
    expect(canRetryPending(only())).toBe(true);

    mocks.endpoints.send.mockRejectedValueOnce(swept());
    const jobs = mocks.jobs.length;
    retryPending(only().nonce);
    await vi.waitFor(() => expect(only().files![0]!.attachment).toBeNull());
    expect(only().status).toBe('failed');
    expect(only().content).toBe('hello');
    expect(only().error).toContain('Discard this and attach them again');
    expect(canRetryPending(only())).toBe(false);

    retryPending(only().nonce);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mocks.jobs).toHaveLength(jobs);
    expect(mocks.endpoints.send).toHaveBeenCalledTimes(2);

    reload();
    expect(only().error).toContain('Its files were on the server for too long');
    expect(canRetryPending(only())).toBe(false);
  });

  it('does not take any other refusal for this', async () => {
    mocks.endpoints.send.mockRejectedValue(
      new ApiError(400, 'validation_error', 'Some fields are invalid.', {
        issues: [{ path: 'attachmentIds', message: 'An attachment is listed more than once.' }],
      }),
    );
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await vi.waitFor(() => expect(only().status).toBe('failed'));
    expect(only().files![0]!.attachment).toMatchObject({ id: 'a1' });
    expect(mocks.endpoints.removeAttachment).not.toHaveBeenCalled();
  });
});

describe('across a reload', () => {
  function reload() {
    const snapshot = new Map(store);
    resetChat();
    store.clear();
    for (const [k, v] of snapshot) store.set(k, v);
    loadDrafts('u1');
  }

  it('saves a message with files as plain data, with what is known of each', async () => {
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    sendMessage(CHANNEL, 'hello');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await uploadStarted(2);
    const row = saved()[0] as { content: string; files: { name: string; attachment: unknown }[] };
    expect(row.content).toBe('hello');
    expect(row.files.map((f) => f.name)).toEqual(['a.png', 'b.png']);
    expect(row.files[0]!.attachment).toMatchObject({ id: 'a1' });
    expect(row.files[1]!.attachment).toBeNull();
  });

  it('comes back as a clear failure, not silently gone and not a Retry that cannot work', async () => {
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    sendMessage(CHANNEL, 'hello');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await uploadStarted(2);

    reload();
    expect(only().status).toBe('failed');
    expect(only().content).toBe('hello');
    expect(only().error).toContain('The page closed before its files finished uploading');
    expect(canRetryPending(only())).toBe(false);

    const count = mocks.jobs.length;
    retryPending(only().nonce);
    expect(mocks.jobs).toHaveLength(count);
    expect(only().status).toBe('failed');

    discardPending(only().nonce);
    expect(mocks.endpoints.removeAttachment).toHaveBeenCalledWith('a1');
    reload();
    expect(pendingList()).toEqual([]);
  });

  it('can still be sent when every file was already up, because then only ids are needed', async () => {
    mocks.endpoints.send.mockReturnValue(new Promise(() => undefined));
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, 'hello');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await vi.waitFor(() => expect(only().status).toBe('sending'));

    reload();
    expect(only().status).toBe('failed');
    expect(canRetryPending(only())).toBe(true);
    expect(only().error).toBe('Not sent before the app was closed.');
    mocks.endpoints.send.mockImplementation((_c, _t, nonce: string) =>
      Promise.resolve({ message: delivered(nonce, [attachment('a1')]) }),
    );
    retryPending(only().nonce);
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(mocks.endpoints.send.mock.lastCall![3]).toEqual(['a1']);
    expect(mocks.jobs).toHaveLength(1);
  });

  it('drops what makes no sense when read back, and a text message is unaffected', () => {
    store.set(
      'hostile:pending:u1',
      JSON.stringify([
        { nonce: 'n1', channelId: CHANNEL, content: 'words', createdAt: 1, error: null },
        { nonce: 'n2', channelId: CHANNEL, content: '', files: [{ nope: true }] },
        { nonce: 'n3', channelId: CHANNEL, content: 'kept', files: [{ id: 1 }] },
        {
          nonce: 'n4',
          channelId: CHANNEL,
          content: '',
          files: [{ id: 'f', name: 'a.png', size: 1, kind: 'image', width: 'wide' }],
        },
        { nonce: 'n5', channelId: CHANNEL },
      ]),
    );
    loadDrafts('u1');
    const { pending } = useChat.getState();
    expect(Object.keys(pending).sort()).toEqual(['n1', 'n3', 'n4']);
    expect(pending.n1).toEqual({
      nonce: 'n1',
      channelId: CHANNEL,
      content: 'words',
      status: 'failed',
      attempts: 5,
      createdAt: 1,
      error: 'Not sent before the app was closed.',
    });
    expect(pending.n3!.files).toBeUndefined();
    expect(pending.n4!.files![0]).toEqual({
      id: 'f',
      name: 'a.png',
      size: 1,
      kind: 'image',
      width: null,
      height: null,
      attachment: null,
    });
  });

  it('stops everything at sign-out, and leaves the row in storage for the next sign-in', async () => {
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, 'hello');
    await uploadStarted(1);
    resetChat();
    expect(mocks.jobs[0]!.aborted).toBe(true);
    expect(saved()).toHaveLength(1);
    loadDrafts('u1');
    expect(only().error).toContain('The page closed before its files finished uploading');
  });
});

describe('when a message is given up on', () => {
  const box = () => useChat.getState().drafts[CHANNEL];
  const quote = {
    id: 'm9',
    seq: 9,
    changeSeq: 9,
    authorId: 'u2',
    excerpt: 'what it answers',
    attachmentCount: 0,
    attachmentKind: null,
    deleted: false,
  };

  it('puts its words back in the message box, with the cursor there, and not its files', async () => {
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, 'worth keeping');
    await uploadStarted(1);
    discardPending(only().nonce);
    expect(pendingList()).toEqual([]);
    expect(box()).toBe('worth keeping');
    expect(useChat.getState().composerFocus).toBe(CHANNEL);
    expect(useChat.getState().trays[CHANNEL]).toEqual([]);
  });

  it('does the same for a message of words alone that could not be sent', async () => {
    mocks.endpoints.send.mockRejectedValue(new ApiError(403, 'forbidden', 'Not allowed.'));
    sendMessage(CHANNEL, 'worth keeping');
    await vi.waitFor(() => expect(only().status).toBe('failed'));
    discardPending(only().nonce);
    expect(box()).toBe('worth keeping');
  });

  it('keeps what has been typed since, after the older words', async () => {
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, 'written first');
    await uploadStarted(1);
    setDraft(CHANNEL, 'typed since');
    discardPending(only().nonce);
    expect(box()).toBe('written first\ntyped since');
  });

  it('leaves the box and the cursor alone when the message had no words', async () => {
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, '');
    await uploadStarted(1);
    setDraft(CHANNEL, 'typed since');
    discardPending(only().nonce);
    expect(box()).toBe('typed since');
    expect(useChat.getState().composerFocus).toBeNull();
  });

  it('brings back what it answered, unless the box is answering something else by now', async () => {
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    useChat.setState({ replies: { [CHANNEL]: quote } });
    sendMessage(CHANNEL, 'first answer');
    await uploadStarted(1);
    discardPending(only().nonce);
    expect(useChat.getState().replies[CHANNEL]).toEqual(quote);

    const newer = { ...quote, id: 'm10', excerpt: 'something newer' };
    addToTray(CHANNEL, [png('c.png')]);
    sendMessage(CHANNEL, 'second answer');
    await new Promise((resolve) => setTimeout(resolve, 5));
    useChat.setState({ replies: { [CHANNEL]: newer } });
    discardPending(only().nonce);
    expect(useChat.getState().replies[CHANNEL]).toEqual(newer);
  });

  it('does not hand back the words of a message the server already has', () => {
    useChat.setState({
      pending: {
        sent: {
          nonce: 'sent',
          channelId: CHANNEL,
          content: 'already delivered',
          status: 'failed',
          attempts: 1,
          createdAt: 0,
          error: 'Sent, but the channel could not be reloaded to show it.',
        },
      },
    });
    discardPending('sent');
    expect(pendingList()).toEqual([]);
    expect(box()).toBeUndefined();
  });
});

describe('after a reload mid-upload', () => {
  function reload() {
    const snapshot = new Map(store);
    resetChat();
    store.clear();
    for (const [k, v] of snapshot) store.set(k, v);
    loadDrafts('u1');
  }

  async function oneUpOneLost(content: string) {
    addToTray(CHANNEL, [png('a.png'), png('b.png')]);
    sendMessage(CHANNEL, content);
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await uploadStarted(2);
    reload();
    return only().nonce;
  }

  it('offers to send what got through, and sends just that, once, under the same nonce', async () => {
    const nonce = await oneUpOneLost('hello');
    expect(only().error).toContain('Send what got through');
    expect(canRetryPending(only())).toBe(false);
    expect(canSendWhatGotThrough(only())).toBe(true);

    mocks.endpoints.send.mockResolvedValue({
      message: delivered(nonce, [attachment('a1')], 'hello'),
    });
    sendWhatGotThrough(nonce);
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(mocks.endpoints.send).toHaveBeenCalledTimes(1);
    expect(mocks.endpoints.send).toHaveBeenCalledWith(CHANNEL, 'hello', nonce, ['a1']);
    expect(mocks.jobs).toHaveLength(2);
  });

  it('still answers what it was answering', async () => {
    useChat.setState({
      replies: {
        [CHANNEL]: {
          id: 'm9',
          seq: 9,
          changeSeq: 9,
          authorId: 'u2',
          excerpt: 'what it answers',
          attachmentCount: 0,
          attachmentKind: null,
          deleted: false,
        },
      },
    });
    const nonce = await oneUpOneLost('hello');
    mocks.endpoints.send.mockResolvedValue({
      message: delivered(nonce, [attachment('a1')], 'hello'),
    });
    sendWhatGotThrough(nonce);
    await vi.waitFor(() => expect(pendingList()).toEqual([]));
    expect(mocks.endpoints.send).toHaveBeenCalledWith(CHANNEL, 'hello', nonce, ['a1'], 'm9');
  });

  it('ends in an ordinary Retry when the send itself is refused', async () => {
    const nonce = await oneUpOneLost('hello');
    mocks.endpoints.send.mockRejectedValue(new ApiError(403, 'forbidden', 'Not allowed.'));
    sendWhatGotThrough(nonce);
    await vi.waitFor(() => expect(only().status).toBe('failed'));
    expect(only().files!.map((f) => f.attachment?.id)).toEqual(['a1']);
    expect(canRetryPending(only())).toBe(true);
    expect(canSendWhatGotThrough(only())).toBe(false);
  });

  it('survives another reload still offering it', async () => {
    await oneUpOneLost('hello');
    reload();
    expect(only().error).toContain('Send what got through');
    expect(canSendWhatGotThrough(only())).toBe(true);
  });

  it('does not offer it when nothing got through', async () => {
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, 'hello');
    await uploadStarted(1);
    reload();
    expect(canSendWhatGotThrough(only())).toBe(false);
    expect(only().error).toContain('Discard this and attach them again');
    expect(only().error).not.toContain('Send what got through');

    sendWhatGotThrough(only().nonce);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mocks.endpoints.send).not.toHaveBeenCalled();
  });

  it('does not offer it when Retry can send everything', async () => {
    mocks.endpoints.send.mockReturnValue(new Promise(() => undefined));
    addToTray(CHANNEL, [png('a.png')]);
    sendMessage(CHANNEL, 'hello');
    await uploadStarted(1);
    mocks.jobs[0]!.resolve(attachment('a1'));
    await vi.waitFor(() => expect(only().status).toBe('sending'));
    reload();
    expect(canRetryPending(only())).toBe(true);
    expect(canSendWhatGotThrough(only())).toBe(false);
  });
});
