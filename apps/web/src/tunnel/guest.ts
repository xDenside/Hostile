import {
  decodeFrame,
  encodeFrame,
  encodeJsonFrame,
  FRAME,
  parseJsonPayload,
  parseRoomCode,
  TUNNEL_MAX_FRAME,
  TUNNEL_PROTOCOL,
} from '@hostile/shared';
import type { JoinRoomConfig, Room } from 'trystero/nostr';
import { deviceKeyFor, forgetDeviceKey } from './device-key';
import { registerFileWorker } from './file-worker';
import { TunnelMux, type FrameSender } from './mux';
import { installLivekitShims, setTunnelNet } from './net';
import {
  APP_ID,
  ChannelWriter,
  guestSealFor,
  KNOCK,
  openChannels,
  remoteFingerprint,
  rootTopicOf,
  roomParams,
  SAME_MACHINE_ONLY,
  testNetwork,
} from './rendezvous';
import { useTunnel, type JoinStep } from './state';

const CODE_KEY = 'hostile:tunnel:code';

const RELAY_KEY = 'hostile:tunnel:relay';
const HOST_KEY_PREFIX = 'hostile:tunnel:host:';
const JAR_PREFIX = 'hostile:tunnel:jar:';
const MEETING_POINT_MS = 10_000;
const FIND_HOST_MS = 20_000;
const DIRECT_MS = 25_000;
const GREETING_MS = 8_000;
const RETRY_MS = 10_000;
const PING_EVERY_MS = 4_000;
const HOST_SILENT_MS = 12_000;
const KNOCK_EVERY_MS = 4_000;

const FAILURE: Record<JoinStep, string> = {
  code: 'That is not a room code. Check that you copied all of it.',
  'meeting-point':
    'Could not reach any meeting point, the public relays that introduce you to the host. Check your connection, or enter a relay of your own below.',
  'finding-host':
    'No host answered. The host may be away, or the code may be wrong or out of date.',
  direct:
    'Found the host, but your two networks could not connect directly. A relay of your own can carry the connection: enter it below.',
  greeting:
    'Reached the host, but it did not answer. It may still be starting, or it may run another version.',
};

const BYE_MESSAGE: Record<string, string> = {
  account_disabled:
    'The host removed you from this room. With the code you can ask to join again, as someone new.',
  version_mismatch: 'This host runs a different version of the app. Update whichever is older.',
  room_full: 'This room has as many people as it can take right now.',
  frame_too_large: 'The host refused something this page sent.',
  protocol_error: 'The host refused something this page sent.',
  too_many_streams: 'The host refused something this page sent.',
};

const NOT_THE_HOST =
  'Someone answered this code, but not the host this device joined before, so nothing was sent to them. Who you are in that room stays on this device. If the host really has moved to a new PC or renewed its key, choose Use a different code and paste this one again: you would then ask to join as someone new.';

export const storedCode = () => localStorage.getItem(CODE_KEY);

class StepFailure extends Error {
  constructor(
    readonly step: JoinStep,
    message?: string,
  ) {
    super(message ?? FAILURE[step]);
  }
}

interface HostLink {
  pc: RTCPeerConnection;
  mux: TunnelMux;
  writers: { control: ChannelWriter; bulk: ChannelWriter };
  lastHeard: number;
  timer: ReturnType<typeof setInterval>;
}

let room: Room | null = null;
let link: HostLink | null = null;
let hostKey: string | null = null;
let attempt = 0;
let identity: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let knockTimer: ReturnType<typeof setInterval> | null = null;
let upListeners: (() => void)[] = [];
let sdpExchanged = false;
let directFailed = false;

export function onHostBack(listener: () => void) {
  upListeners.push(listener);
  return () => {
    upListeners = upListeners.filter((l) => l !== listener);
  };
}

function relayIceServers(relay: string): RTCIceServer[] | null {
  const match = /^(turns?):(?:([^:@]+):([^@]+)@)?(.+)$/.exec(relay);
  if (!match) return null;
  return [
    {
      urls: `${match[1]}:${match[4]}`,
      ...(match[2] ? { username: match[2], credential: match[3] } : {}),
    },
  ];
}

const fingerprintOf = (pc: RTCPeerConnection) => remoteFingerprint(pc.remoteDescription?.sdp);

function isKnownHost(pc: RTCPeerConnection) {
  const known = hostKey && localStorage.getItem(hostKey);
  return !known || fingerprintOf(pc) === known;
}

function watchedPeerConnection() {
  return class extends RTCPeerConnection {
    constructor(config?: RTCConfiguration) {
      super(config);
      this.addEventListener('iceconnectionstatechange', () => {
        if (this.iceConnectionState === 'failed') directFailed = true;
      });
    }
    override setRemoteDescription(description: RTCSessionDescriptionInit) {
      sdpExchanged = true;
      return super.setRemoteDescription(description);
    }
  };
}

function detach(reason: string) {
  const old = link;
  link = null;
  if (!old) return;
  clearInterval(old.timer);
  setTunnelNet(null);
  old.mux.fail(reason);
  try {
    old.writers.control.channel.close();
    old.writers.bulk.channel.close();
  } catch {}
}

function legacyToken(name: string): string | null {
  try {
    const cookies = JSON.parse(localStorage.getItem(name) ?? '{}') as Record<
      string,
      { value?: string }
    >;
    const found = Object.entries(cookies).find(([key]) => key.endsWith('_session'));
    return found?.[1].value || null;
  } catch {
    return null;
  }
}

async function endIdentityOf(name: string) {
  localStorage.removeItem(name);
  await forgetDeviceKey(name).catch(() => undefined);
}

async function signInOverLink(mux: TunnelMux, name: string) {
  let key;
  try {
    key = await deviceKeyFor(name);
  } catch {
    return;
  }
  const post = (path: string, body: unknown) =>
    mux
      .fetch('room', path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      .catch(() => null);
  const legacy = legacyToken(name);
  if (legacy) {
    const claimed = await post('/api/auth/device/claim', {
      token: legacy,
      deviceKey: key.publicKey,
    });
    if (claimed && claimed.status < 500 && claimed.status !== 429) localStorage.removeItem(name);
    if (claimed?.ok) return;
  }
  const issued = await post('/api/auth/device/challenge', {});
  if (!issued?.ok) return;
  const { challenge } = (await issued.json()) as { challenge: string };
  await post('/api/auth/device/sign-in', {
    deviceKey: key.publicKey,
    challenge,
    signature: await key.sign(challenge),
  });
}

async function attachHost(pc: RTCPeerConnection, mine: number): Promise<void> {
  const fingerprint = fingerprintOf(pc);
  if (!fingerprint || !isKnownHost(pc)) throw new StepFailure('greeting', NOT_THE_HOST);
  identity = JAR_PREFIX + fingerprint;
  const channels = openChannels(pc);
  const writers = {
    control: new ChannelWriter(channels.control),
    bulk: new ChannelWriter(channels.bulk),
  };
  const send: FrameSender = (frame, bulk) => (bulk ? writers.bulk : writers.control).write(frame);
  const mux = new TunnelMux(send);
  const candidate: HostLink = { pc, mux, writers, lastHeard: Date.now(), timer: 0 as never };

  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(hello);
      reject(new StepFailure('greeting'));
    }, GREETING_MS);
    const hello = setInterval(() => {
      if (channels.control.readyState === 'open')
        channels.control.send(encodeJsonFrame(FRAME.HELLO, 0, { version: TUNNEL_PROTOCOL }));
    }, 300);
    const onFrame = (event: MessageEvent<ArrayBuffer>) => {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > TUNNEL_MAX_FRAME) return;
      const frame = decodeFrame(new Uint8Array(event.data));
      if (!frame) return;
      candidate.lastHeard = Date.now();
      const payload = frame.payload as Uint8Array<ArrayBuffer>;
      switch (frame.type) {
        case FRAME.WELCOME:
          clearTimeout(deadline);
          clearInterval(hello);
          resolve();
          return;
        case FRAME.BYE: {
          const bye = parseJsonPayload<{ reason?: string }>(payload);
          clearTimeout(deadline);
          clearInterval(hello);
          if (link === candidate) hostEnded(bye?.reason ?? 'host_stopping');
          else
            reject(new StepFailure('greeting', BYE_MESSAGE[bye?.reason ?? ''] ?? FAILURE.greeting));
          return;
        }
        case FRAME.PONG:
          return;
        default:
          mux.receive(frame.type, frame.streamId, payload);
      }
    };
    channels.control.onmessage = onFrame;
    channels.bulk.onmessage = onFrame;
  });
  if (mine !== attempt) return;
  await signInOverLink(mux, identity!);
  if (mine !== attempt) return;

  detach('The host changed.');
  if (hostKey) localStorage.setItem(hostKey, fingerprint);
  candidate.timer = setInterval(() => {
    if (Date.now() - candidate.lastHeard > HOST_SILENT_MS) return hostLost();
    send(encodeFrame(FRAME.PING, 0), false).catch(() => undefined);
  }, PING_EVERY_MS);
  channels.control.onclose = () => {
    if (link === candidate) hostLost();
  };
  link = candidate;
  stopKnocking();
  if (retryTimer) clearTimeout(retryTimer);
  localStorage.setItem(CODE_KEY, useTunnel.getState().code ?? '');
  setTunnelNet({
    fetch: (target, path, init) => mux.fetch(target, path, init),
    openSocket: (socket, target, path, protocols) =>
      mux.openSocket(socket, target, path, protocols),
  });
  useTunnel.setState({
    hostFingerprint: fingerprint,
    phase: 'connected',
    step: null,
    failedStep: null,
    message: null,
    retryAt: null,
  });
  for (const listener of upListeners) listener();
}

function hostLost() {
  detach('The host cannot be reached.');
  const { phase } = useTunnel.getState();
  if (phase === 'ended') return;
  useTunnel.setState({
    phase: 'away',
    message:
      'The host is away. Waiting for it to come back. If this goes on, ask the host whether the code changed.',
  });
  void connect(attempt);
}

function hostEnded(reason: string) {
  if (reason === 'host_stopping' || reason === 'sign_in_timeout' || reason === 'room_full')
    return hostLost();
  detach('The host ended the connection.');
  attempt++;
  stopKnocking();
  room?.leave().catch(() => undefined);
  room = null;
  if (reason === 'account_disabled' && identity) void endIdentityOf(identity);
  useTunnel.setState({
    phase: 'ended',
    step: null,
    message: BYE_MESSAGE[reason] ?? 'The host ended the connection.',
  });
}

function stopKnocking() {
  if (knockTimer) clearInterval(knockTimer);
  knockTimer = null;
}

async function knock(topic: string) {
  const { createEvent, getRelaySockets } = await import('trystero/nostr');
  const event = await createEvent(topic, KNOCK);
  for (const socket of Object.values(getRelaySockets() as Record<string, WebSocket>)) {
    if (socket.readyState === WebSocket.OPEN) socket.send(event);
  }
}

function joinKeepingTheRoomOnStay(join: () => Room): Room {
  const native = window.addEventListener;
  window.addEventListener = function (
    this: Window,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ) {
    native.call(this, type === 'beforeunload' ? 'pagehide' : type, listener, options);
  } as typeof window.addEventListener;
  try {
    return join();
  } finally {
    window.addEventListener = native;
  }
}

async function waitFor<T>(
  check: () => T | null | undefined | false,
  ms: number,
  gone: () => boolean,
) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (gone()) return null;
    if (Date.now() > end) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function connect(mine: number): Promise<boolean> {
  if (retryTimer) clearTimeout(retryTimer);
  const state = useTunnel.getState();
  const code = state.code;
  const secret = code ? parseRoomCode(code) : null;
  const step = (name: JoinStep) => {
    if (useTunnel.getState().phase !== 'away')
      useTunnel.setState({
        phase: 'connecting',
        step: name,
        failedStep: null,
        message: null,
        retryAt: null,
      });
  };
  try {
    step('code');
    if (!secret) throw new StepFailure('code');
    const { roomId, password } = await roomParams(secret);
    hostKey = HOST_KEY_PREFIX + roomId;

    await registerFileWorker();
    installLivekitShims();

    const { joinRoom, getRelaySockets, setRelaySeal } = await import('trystero/nostr');
    const seal = await guestSealFor(secret);
    if (mine !== attempt) return false;
    if (room) {
      const leaving = room;
      room = null;
      await leaving.leave().catch(() => undefined);
      if (mine !== attempt) return false;
    }
    setRelaySeal(seal);
    sdpExchanged = false;
    directFailed = false;
    const relay = state.customRelay.trim();
    const iceFromRelay = relay ? relayIceServers(relay) : null;
    const test = testNetwork();
    const config: JoinRoomConfig = {
      appId: APP_ID,
      password,
      passive: true,
      rtcPolyfill: watchedPeerConnection(),
      relayConfig: {
        warnOnRelayFailure: false,
        ...(test ? { urls: test.relays } : relay && !iceFromRelay ? { urls: [relay] } : {}),
      },
      ...(test
        ? { rtcConfig: { iceServers: iceFromRelay ?? [] }, ...SAME_MACHINE_ONLY }
        : iceFromRelay
          ? { turnConfig: iceFromRelay as never }
          : {}),
    };
    let joinError: string | null = null;
    const peers: { id: string; pc: RTCPeerConnection }[] = [];
    let someoneElse = false;
    const joined = joinKeepingTheRoomOnStay(() =>
      joinRoom(config, roomId, {
        onJoinError: (details) => {
          joinError = details.error;
        },
      }),
    );
    room = joined;
    joined.onPeerJoin = (id) => {
      const pc = joined.getPeers()[id];
      if (!pc) return;
      if (isKnownHost(pc)) {
        peers.push({ id, pc });
      } else {
        someoneElse = true;
        pc.close();
      }
    };
    joined.onPeerLeave = () => {
      const current = link;
      if (current && current.pc.connectionState !== 'connected') hostLost();
    };
    const gone = () => mine !== attempt;

    step('meeting-point');
    const socketsOpen = () =>
      Object.values(getRelaySockets() as Record<string, WebSocket>).some(
        (s) => s.readyState === WebSocket.OPEN,
      );
    if (!(await waitFor(socketsOpen, MEETING_POINT_MS, gone)) && !gone())
      throw new StepFailure('meeting-point');

    step('finding-host');
    const topic = await rootTopicOf(roomId);
    stopKnocking();
    void knock(topic);
    knockTimer = setInterval(() => void knock(topic), KNOCK_EVERY_MS);
    setTimeout(() => void knock(topic), 400);
    await waitFor(() => sdpExchanged || peers.length > 0, FIND_HOST_MS, gone);
    if (gone()) return false;
    if (!sdpExchanged && !peers.length) throw new StepFailure('finding-host');

    step('direct');
    await waitFor(() => peers.length > 0 || directFailed || joinError, DIRECT_MS, gone);
    if (gone()) return false;
    if (!peers.length && someoneElse) throw new StepFailure('greeting', NOT_THE_HOST);
    if (!peers.length) throw new StepFailure('direct');

    step('greeting');
    const first = peers[peers.length - 1]!.pc;
    joined.onPeerJoin = (id) => {
      const pc = joined.getPeers()[id];
      if (!pc || pc === first) return;
      if (hostKey && localStorage.getItem(hostKey) && isKnownHost(pc))
        void attachHost(pc, mine).catch(() => undefined);
      else pc.close();
    };
    await attachHost(first, mine);
    return true;
  } catch (err) {
    if (mine !== attempt) return false;
    const failure = err instanceof StepFailure ? err : null;
    stopKnocking();
    const { phase } = useTunnel.getState();
    const retryable = failure?.step !== 'code' && storedCode() === code;
    const retryAt = retryable ? Date.now() + RETRY_MS : null;
    if (phase === 'away') {
      useTunnel.setState({ retryAt });
    } else {
      useTunnel.setState({
        phase: 'failed',
        step: null,
        failedStep: failure?.step ?? 'greeting',
        message: failure?.message ?? (err as Error).message,
        retryAt,
      });
    }
    if (retryable) retryTimer = setTimeout(() => void connect(mine), RETRY_MS);
    return false;
  }
}

export function connectWithCode(code: string): Promise<boolean> {
  attempt++;
  detach('Connecting again.');
  useTunnel.setState({
    code: code.trim(),
    phase: 'connecting',
    message: null,
    failedStep: null,
    retryAt: null,
  });
  return connect(attempt);
}

export function setCustomRelay(relay: string) {
  useTunnel.setState({ customRelay: relay });
  if (relay) localStorage.setItem(RELAY_KEY, relay);
  else localStorage.removeItem(RELAY_KEY);
}

export function forgetRoom({ endIdentity = false }: { endIdentity?: boolean } = {}) {
  attempt++;
  if (retryTimer) clearTimeout(retryTimer);
  stopKnocking();
  detach('Left the room.');
  room?.leave().catch(() => undefined);
  room = null;
  if (endIdentity && identity) void endIdentityOf(identity);
  identity = null;
  if (hostKey) localStorage.removeItem(hostKey);
  hostKey = null;
  localStorage.removeItem(CODE_KEY);
  useTunnel.setState({
    phase: 'idle',
    code: null,
    hostFingerprint: null,
    step: null,
    failedStep: null,
    message: null,
    retryAt: null,
  });
}

export function initialCode(): string | null {
  const relay = localStorage.getItem(RELAY_KEY);
  if (relay) useTunnel.setState({ customRelay: relay });
  const hash = location.hash.slice(1);
  if (hash && parseRoomCode(hash)) {
    history.replaceState(null, '', location.pathname + location.search);
    return hash;
  }
  return storedCode();
}
