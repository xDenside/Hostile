import { playCue } from '../features/voice/sounds';
import { setJoinRequests, useJoinRequests } from '../features/join/JoinRequests';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SessionEndReason,
  VoiceSelfStatePayload,
} from '@hostile/shared';
import { endpoints, errorMessage } from '../api/client';
import { onMessageEvent, onTyping, resyncAllLoaded, retryWaitingNow } from '../features/chat/store';
import { reuse } from '../lib/reuse';
import { platform } from '../platform';
import { socketTransportOptions, tunnelSocketUrl } from '../tunnel/net';
import { sortChannels, useCommunity } from '../stores/community';
import { useSession } from '../stores/session';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;
let sessionEndedHandler: ((reason: SessionEndReason | 'auth') => void) | null = null;
let bootstrapSeq = 0;

async function synchronize(attempt = 0) {
  const seq = ++bootstrapSeq;
  try {
    const b = await endpoints.bootstrap();
    if (seq !== bootstrapSeq) return;
    const current = useSession.getState().user;
    if (current && b.self.id !== current.id) {
      sessionEndedHandler?.('revoked');
      return;
    }
    useSession.setState({ user: reuse(current, b.self) });
    const previous = useCommunity.getState();
    const snapshotRead = Object.fromEntries(b.readStates.map((r) => [r.channelId, r.lastReadSeq]));
    const readChannelIds = new Set([
      ...Object.keys(previous.readStates),
      ...Object.keys(snapshotRead),
    ]);
    useCommunity.setState({
      ready: true,
      communityName: b.community.name,
      channels: reuse(
        previous.channels,
        sortChannels(
          b.channels.map((c) => {
            const held = previous.channels.find((p) => p.id === c.id);
            return { ...c, lastMessageSeq: Math.max(c.lastMessageSeq, held?.lastMessageSeq ?? 0) };
          }),
        ),
      ),
      members: reuse(previous.members, Object.fromEntries(b.members.map((m) => [m.id, m]))),
      readStates: reuse(
        previous.readStates,
        Object.fromEntries(
          [...readChannelIds].map((id) => [
            id,
            Math.max(snapshotRead[id] ?? 0, previous.readStates[id] ?? 0),
          ]),
        ),
      ),
      online: reuse(
        previous.online,
        Object.fromEntries(b.onlineUserIds.map((id) => [id, true as const])),
      ),
      voice: reuse(previous.voice, b.voice),
      connectionError: null,
    });
    await resyncAllLoaded();
    retryWaitingNow();
  } catch (err) {
    if (seq !== bootstrapSeq) return;
    useCommunity.setState({ connectionError: `Could not load data: ${errorMessage(err)}` });
    setTimeout(
      () => {
        if (seq === bootstrapSeq && socket?.connected) void synchronize(attempt + 1);
      },
      Math.min(30_000, 1000 * 2 ** attempt),
    );
  }
}

export function connectRealtime(onSessionEnded: (reason: SessionEndReason | 'auth') => void) {
  disconnectRealtime();
  sessionEndedHandler = onSessionEnded;
  const p = platform();
  const s: AppSocket = io(p.socketUrl() ?? tunnelSocketUrl() ?? '', {
    path: '/socket.io',
    auth: (cb) => cb(p.socketAuth()),
    withCredentials: p.kind === 'web',
    ...socketTransportOptions(),
    reconnectionDelay: 500,
    reconnectionDelayMax: 8000,
    timeout: 10_000,
  });
  socket = s;
  useCommunity.setState({ connection: 'connecting' });

  s.on('connect', () => {
    useCommunity.setState({ connection: 'connected', connectionError: null });
    void synchronize();
  });

  s.on('disconnect', (reason) => {
    useCommunity.setState({
      connection: reason === 'io client disconnect' ? 'offline' : 'reconnecting',
    });
    if (reason === 'io server disconnect') {
      void verifySessionThenReconnect();
    }
  });

  s.on('connect_error', (err: Error & { data?: { code?: string } }) => {
    const code = err.data?.code;
    if (code === 'session_expired' || code === 'unauthenticated') {
      void verifySessionThenReconnect();
      return;
    }
    if (code === 'account_disabled') {
      sessionEndedHandler?.('disabled');
      return;
    }
    useCommunity.setState({
      connection: 'reconnecting',
      connectionError: s.active ? null : err.message,
    });
    if (!s.active)
      setTimeout(() => {
        if (socket === s && !s.connected && !s.active) s.connect();
      }, 3000);
  });

  s.on('session:ended', ({ reason }) => sessionEndedHandler?.(reason));
  s.on('message:created', onMessageEvent);
  s.on('message:updated', onMessageEvent);
  s.on('typing', ({ channelId, userId }) => onTyping(channelId, userId));
  s.on('channel:upserted', (channel) =>
    useCommunity.setState((st) => ({
      channels: sortChannels([...st.channels.filter((c) => c.id !== channel.id), channel]),
    })),
  );
  s.on('channel:removed', ({ id }) =>
    useCommunity.setState((st) => ({ channels: st.channels.filter((c) => c.id !== id) })),
  );
  s.on('join:requests', ({ requests }) => {
    const someoneNew = requests.length > useJoinRequests.getState().requests.length;
    setJoinRequests(requests);
    if (someoneNew) playCue('viewer-join');
  });
  s.on('member:upserted', (member) =>
    useCommunity.setState((st) => ({ members: { ...st.members, [member.id]: member } })),
  );
  s.on('presence:changed', ({ userId, online }) =>
    useCommunity.setState((st) => {
      const next = { ...st.online };
      if (online) next[userId] = true;
      else delete next[userId];
      return { online: next };
    }),
  );
  s.on('voice:status', (voice) => useCommunity.setState({ voice }));
  s.on('read:updated', ({ channelId, lastReadSeq }) =>
    useCommunity.setState((st) => ({
      readStates: {
        ...st.readStates,
        [channelId]: Math.max(lastReadSeq, st.readStates[channelId] ?? 0),
      },
    })),
  );
}

async function verifySessionThenReconnect() {
  const p = platform();
  const refreshed = await p.recoverFromUnauthorized();
  if (refreshed) {
    socket?.connect();
    return;
  }
  try {
    const user = await p.restoreSession();
    if (user) {
      socket?.connect();
      return;
    }
  } catch {
    setTimeout(() => socket?.connect(), 3000);
    return;
  }
  sessionEndedHandler?.('auth');
}

export function disconnectRealtime() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  bootstrapSeq++;
}

export function kickRealtime() {
  if (socket && !socket.connected) socket.connect();
  else if (socket?.connected) void synchronize();
}

export function nudgeRealtime() {
  if (socket && !socket.connected) socket.connect();
  else if (socket?.connected) retryWaitingNow();
}

export function emitTyping(channelId: string) {
  socket?.emit('typing:start', { channelId });
}

export function emitVoiceSelfState(state: VoiceSelfStatePayload) {
  if (socket?.connected) socket.emit('voice:self-state', state);
}

export function onRealtimeConnect(listener: () => void): () => void {
  const s = socket;
  if (!s) return () => undefined;
  s.on('connect', listener);
  return () => s.off('connect', listener);
}
