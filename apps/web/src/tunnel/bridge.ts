import {
  encodeJsonFrame,
  FRAME,
  frameIsBulk,
  parseRoomCode,
  TUNNEL_MAX_FRAME,
  TUNNEL_MAX_QUEUED,
} from '@hostile/shared';
import { joinRoom, setRelaySeal, type Room } from 'trystero/nostr';
import { hostCertificate } from './host-certificate';
import {
  APP_ID,
  ChannelWriter,
  openChannels,
  relaySealFor,
  roomParams,
  SAME_MACHINE_ONLY,
  testNetwork,
} from './rendezvous';

export interface BridgeConfig {
  code: string;
  gatewayUrl: string;
  gatewaySecret: string;
}

export interface BridgeStatus {
  room: 'joining' | 'open';
  guests: number;
}

export async function startBridge(config: BridgeConfig, onStatus: (s: BridgeStatus) => void) {
  const secret = parseRoomCode(config.code);
  if (!secret) throw new Error('Not a room code.');
  const { roomId, password } = await roomParams(secret);
  const test = testNetwork();
  const guests = new Map<string, () => void>();
  const report = (state: BridgeStatus['room']) => onStatus({ room: state, guests: guests.size });
  report('joining');
  setRelaySeal(await relaySealFor(secret));
  const certificates = [await hostCertificate()];

  const room: Room = joinRoom(
    {
      appId: APP_ID,
      password,
      relayConfig: { warnOnRelayFailure: false, ...(test ? { urls: test.relays } : {}) },
      rtcConfig: { certificates, ...(test ? { iceServers: [] } : {}) },
      ...(test ? SAME_MACHINE_ONLY : {}),
    },
    roomId,
  );

  room.onPeerJoin = (id) => {
    const pc = room.getPeers()[id];
    if (!pc) return;
    guests.get(id)?.();
    guests.set(
      id,
      attachGuest(pc, config, () => {
        guests.delete(id);
        report('open');
      }),
    );
    report('open');
  };
  room.onPeerLeave = (id) => {
    guests.get(id)?.();
    guests.delete(id);
    report('open');
  };
  report('open');

  return {
    async stop() {
      for (const end of guests.values()) end();
      guests.clear();
      await room.leave();
    },
  };
}

function attachGuest(pc: RTCPeerConnection, config: BridgeConfig, onEnded: () => void) {
  const channels = openChannels(pc);
  const limit = {
    maxQueuedBytes: TUNNEL_MAX_QUEUED,
    onOverflow: () => refuse('too_many_streams'),
  };
  const control = new ChannelWriter(channels.control, limit);
  const bulk = new ChannelWriter(channels.bulk, limit);
  const gateway = new WebSocket(config.gatewayUrl);
  gateway.binaryType = 'arraybuffer';
  let authed = false;
  let over = false;

  const end = () => {
    if (over) return;
    over = true;
    gateway.close();
    try {
      channels.control.close();
      channels.bulk.close();
      setTimeout(() => pc.close(), 300);
    } catch {}
    onEnded();
  };

  const refuse = (reason: string) => {
    if (channels.control.readyState === 'open')
      channels.control.send(encodeJsonFrame(FRAME.BYE, 0, { reason }));
    end();
  };

  gateway.onopen = () => gateway.send(JSON.stringify({ secret: config.gatewaySecret }));
  gateway.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
    if (typeof event.data === 'string') {
      authed = true;
      return;
    }
    const frame = new Uint8Array(event.data);
    (frameIsBulk(frame) ? bulk : control).write(frame).catch(() => end());
  };
  gateway.onclose = end;
  gateway.onerror = end;

  const fromGuest = (event: MessageEvent<ArrayBuffer | string>) => {
    if (typeof event.data === 'string') return refuse('protocol_error');
    if (event.data.byteLength > TUNNEL_MAX_FRAME) return refuse('frame_too_large');
    if (authed && gateway.readyState === WebSocket.OPEN) gateway.send(event.data);
  };
  channels.control.onmessage = fromGuest;
  channels.bulk.onmessage = fromGuest;
  channels.control.onclose = end;
  return end;
}
