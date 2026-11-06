import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapDTO, ChannelDTO, MessageDTO, ReadStateDTO } from '@hostile/shared';
import { ApiError } from '../src/api/http';

const mocks = vi.hoisted(() => ({
  endpoints: { bootstrap: vi.fn(), history: vi.fn(), changes: vi.fn(), send: vi.fn() },
  io: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: mocks.io }));

vi.mock('../src/api/client', async () => {
  const { ApiError: Err } = await import('../src/api/http');
  return {
    ApiError: Err,
    endpoints: mocks.endpoints,
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  };
});

vi.mock('../src/platform', () => ({
  platform: () => ({
    kind: 'web',
    apiBase: () => '',
    socketUrl: () => undefined,
    authHeaders: () => ({}),
    socketAuth: () => ({}),
    recoverFromUnauthorized: async () => false,
  }),
}));

const { emptyVoiceStatus, isUnread, useCommunity } = await import('../src/stores/community');
const { useSession } = await import('../src/stores/session');
const { connectRealtime, disconnectRealtime } = await import('../src/realtime/socket');

const CHANNEL = '0192d5b0-1111-7000-8000-000000000001';

function channel(lastMessageSeq: number): ChannelDTO {
  return { id: CHANNEL, name: 'general', type: 'text', position: 0, lastMessageSeq };
}

function msg(seq: number): MessageDTO {
  return {
    id: `m${seq}`,
    channelId: CHANNEL,
    authorId: 'u2',
    content: `message ${seq}`,
    seq,
    changeSeq: seq,
    clientNonce: `n${seq}`,
    createdAt: '2026-01-02T03:04:05.000Z',
    editedAt: null,
    deleted: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
  };
}

function bootstrap(channels: ChannelDTO[], readStates: ReadStateDTO[]): BootstrapDTO {
  return {
    self: { id: 'u1' } as BootstrapDTO['self'],
    community: { name: 'Hostile' } as BootstrapDTO['community'],
    channels,
    readStates,
    members: [],
    onlineUserIds: [],
    voice: emptyVoiceStatus,
    serverTime: '2026-01-02T03:04:05.000Z',
  };
}

function fakeSocket() {
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  return {
    connected: true,
    active: true,
    on(event: string, fn: (arg?: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    off: () => undefined,
    emit: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
    removeAllListeners: () => handlers.clear(),
    fire(event: string, arg?: unknown) {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(arg);
    },
  };
}

let socket: ReturnType<typeof fakeSocket>;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  socket = fakeSocket();
  mocks.io.mockReset();
  mocks.io.mockReturnValue(socket);
  mocks.endpoints.bootstrap.mockReset();
  useSession.setState({ user: { id: 'u1' } as never });
  useCommunity.setState({
    ready: false,
    channels: [channel(10)],
    readStates: { [CHANNEL]: 10 },
    connectionError: null,
  });
});

describe('bootstrap applied after events that arrived while it was in flight', () => {
  it('keeps a newer lastMessageSeq, so the message keeps its unread indicator', async () => {
    let resolveBootstrap!: (b: BootstrapDTO) => void;
    mocks.endpoints.bootstrap.mockReturnValue(
      new Promise<BootstrapDTO>((resolve) => {
        resolveBootstrap = resolve;
      }),
    );

    connectRealtime(() => undefined);
    socket.fire('connect');
    await flush();

    socket.fire('message:created', msg(11));
    expect(useCommunity.getState().channels[0]!.lastMessageSeq).toBe(11);

    resolveBootstrap(bootstrap([channel(10)], [{ channelId: CHANNEL, lastReadSeq: 10 }]));
    await vi.waitFor(() => expect(useCommunity.getState().ready).toBe(true));

    const { channels, readStates } = useCommunity.getState();
    expect(channels[0]!.lastMessageSeq).toBe(11);
    expect(isUnread(channels[0]!, readStates)).toBe(true);
  });

  it('keeps a newer read state, so no phantom unread dot is left behind', async () => {
    let resolveBootstrap!: (b: BootstrapDTO) => void;
    mocks.endpoints.bootstrap.mockReturnValue(
      new Promise<BootstrapDTO>((resolve) => {
        resolveBootstrap = resolve;
      }),
    );

    connectRealtime(() => undefined);
    socket.fire('connect');
    await flush();

    socket.fire('read:updated', { channelId: CHANNEL, lastReadSeq: 11 });
    resolveBootstrap(bootstrap([channel(11)], [{ channelId: CHANNEL, lastReadSeq: 10 }]));
    await vi.waitFor(() => expect(useCommunity.getState().ready).toBe(true));

    const { channels, readStates } = useCommunity.getState();
    expect(readStates[CHANNEL]).toBe(11);
    expect(isUnread(channels[0]!, readStates)).toBe(false);
  });
});

describe('a bootstrap that fails', () => {
  it('reports the error while it is still the current one', async () => {
    mocks.endpoints.bootstrap.mockRejectedValue(new ApiError(0, 'network_error', 'Cannot reach.'));
    connectRealtime(() => undefined);
    socket.fire('connect');
    await vi.waitFor(() =>
      expect(useCommunity.getState().connectionError).toBe('Could not load data: Cannot reach.'),
    );
  });

  it('says nothing once it has been superseded (a sign-out, a newer connect)', async () => {
    let rejectBootstrap!: (err: unknown) => void;
    mocks.endpoints.bootstrap.mockReturnValue(
      new Promise<BootstrapDTO>((_resolve, reject) => {
        rejectBootstrap = reject;
      }),
    );

    connectRealtime(() => undefined);
    socket.fire('connect');
    await flush();

    disconnectRealtime();
    useCommunity.setState({ connectionError: null });
    rejectBootstrap(new ApiError(401, 'unauthenticated', 'This device is not part of the room.'));
    await flush();

    expect(useCommunity.getState().connectionError).toBeNull();
  });
});

describe('a bootstrap that says what the client already knows', () => {
  it('leaves everything with the identity it had, so that nothing re-renders', async () => {
    const snapshot = () => ({
      ...bootstrap([channel(10)], [{ channelId: CHANNEL, lastReadSeq: 10 }]),
      members: [{ id: 'u1', displayName: 'Alice' }] as BootstrapDTO['members'],
      onlineUserIds: ['u1'],
      voice: { ...emptyVoiceStatus, rooms: { [CHANNEL]: [] } },
    });
    mocks.endpoints.bootstrap.mockResolvedValueOnce(snapshot());
    connectRealtime(() => undefined);
    socket.fire('connect');
    await vi.waitFor(() => expect(useCommunity.getState().ready).toBe(true));
    await flush();
    const before = useCommunity.getState();
    const user = useSession.getState().user;

    mocks.endpoints.bootstrap.mockResolvedValueOnce({
      ...snapshot(),
      voice: { ...snapshot().voice, checkedAt: '2026-01-02T03:04:20.000Z' },
    });
    socket.fire('connect');
    await vi.waitFor(() => expect(useCommunity.getState().voice.checkedAt).not.toBeNull());
    await flush();

    const after = useCommunity.getState();
    expect(after.channels).toBe(before.channels);
    expect(after.members).toBe(before.members);
    expect(after.readStates).toBe(before.readStates);
    expect(after.online).toBe(before.online);
    expect(after.voice.rooms).toBe(before.voice.rooms);
    expect(useSession.getState().user).toBe(user);
  });

  it('still takes what did change, and only that', async () => {
    const first = {
      ...bootstrap([channel(10)], [{ channelId: CHANNEL, lastReadSeq: 10 }]),
      members: [
        { id: 'u1', displayName: 'Alice' },
        { id: 'u2', displayName: 'Bob' },
      ] as BootstrapDTO['members'],
    };
    mocks.endpoints.bootstrap.mockResolvedValueOnce(first);
    connectRealtime(() => undefined);
    socket.fire('connect');
    await vi.waitFor(() => expect(useCommunity.getState().ready).toBe(true));
    await flush();
    const before = useCommunity.getState().members;

    mocks.endpoints.bootstrap.mockResolvedValueOnce({
      ...structuredClone(first),
      members: [
        { id: 'u1', displayName: 'Alice' },
        { id: 'u2', displayName: 'Robert' },
      ] as BootstrapDTO['members'],
    });
    socket.fire('connect');
    await vi.waitFor(() => expect(useCommunity.getState().members.u2?.displayName).toBe('Robert'));

    const after = useCommunity.getState().members;
    expect(after.u1).toBe(before.u1);
    expect(after.u2).not.toBe(before.u2);
  });
});
