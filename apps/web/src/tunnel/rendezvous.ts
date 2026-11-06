import { TUNNEL_BUFFER_HIGH, TUNNEL_BUFFER_LOW, TUNNEL_CHANNELS } from '@hostile/shared';
import type { RelaySeal } from 'trystero/nostr';

export const APP_ID = 'hostile-tunnel-1';

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

const digest = (algorithm: string, text: string) =>
  crypto.subtle.digest(algorithm, new TextEncoder().encode(text));

export async function roomParams(secretHex: string) {
  const roomId = hex(await digest('SHA-256', `hostile-room/${secretHex}`)).slice(0, 40);
  const password = hex(await digest('SHA-256', `hostile-password/${secretHex}`));
  return { roomId, password };
}

const MAX_SEALED = 256 * 1024;
const IV_BYTES = 12;

export async function relaySealFor(secretHex: string): Promise<RelaySeal> {
  const key = await crypto.subtle.importKey(
    'raw',
    await digest('SHA-256', `hostile-relay/${secretHex}`),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  return {
    async seal(text) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const body = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)),
      );
      const whole = new Uint8Array(iv.length + body.length);
      whole.set(iv);
      whole.set(body, iv.length);
      return btoa(String.fromCharCode(...whole));
    },
    async open(sealed) {
      if (typeof sealed !== 'string' || sealed.length > MAX_SEALED) return null;
      try {
        const whole = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: whole.subarray(0, IV_BYTES) },
          key,
          whole.subarray(IV_BYTES),
        );
        return new TextDecoder().decode(plain);
      } catch {
        return null;
      }
    },
  };
}

export function remoteFingerprint(sdp: string | undefined | null): string | null {
  const found = new Set(
    [...(sdp ?? '').matchAll(/^a=fingerprint:(\S+) (\S+)/gim)].map(
      (line) => `${line[1]!.toLowerCase()} ${line[2]!.toUpperCase()}`,
    ),
  );
  return found.size === 1 ? [...found][0]! : null;
}

export const rootTopicOf = async (roomId: string) =>
  [...new Uint8Array(await digest('SHA-1', `Trystero@${APP_ID}@${roomId}`))]
    .map((byte) => byte.toString(36))
    .join('');

export function testNetwork(): { relays: string[] } | null {
  const relays = import.meta.env.HOSTILE_TEST_RELAYS;
  return relays ? { relays: relays.split(',') } : null;
}

export const SAME_MACHINE_ONLY = { _test_only_mdnsHostFallbackToLoopback: true } as object;

export class ChannelWriter {
  private queued = 0;
  private queue: {
    frame: Uint8Array<ArrayBuffer>;
    resolve: () => void;
    reject: (e: Error) => void;
  }[] = [];
  private closed = false;

  constructor(
    readonly channel: RTCDataChannel,
    private readonly limit?: { maxQueuedBytes: number; onOverflow: () => void },
  ) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = TUNNEL_BUFFER_LOW;
    channel.addEventListener('bufferedamountlow', () => this.pump());
    channel.addEventListener('open', () => this.pump());
    channel.addEventListener('close', () => this.fail());
  }

  write(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The channel has closed.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ frame, resolve, reject });
      this.queued += frame.length;
      this.pump();
      if (this.limit && this.queued > this.limit.maxQueuedBytes) this.limit.onOverflow();
    });
  }

  get queuedBytes() {
    return this.queued;
  }

  private pump() {
    while (
      this.queue.length &&
      this.channel.readyState === 'open' &&
      this.channel.bufferedAmount < TUNNEL_BUFFER_HIGH
    ) {
      const next = this.queue.shift()!;
      this.queued -= next.frame.length;
      try {
        this.channel.send(next.frame);
        next.resolve();
      } catch (err) {
        next.reject(err as Error);
      }
    }
  }

  private fail() {
    this.closed = true;
    this.queued = 0;
    const err = new Error('The channel has closed.');
    for (const item of this.queue.splice(0)) item.reject(err);
  }
}

export function openChannels(pc: RTCPeerConnection) {
  const control = pc.createDataChannel(TUNNEL_CHANNELS.control.label, {
    negotiated: true,
    id: TUNNEL_CHANNELS.control.id,
    ordered: true,
  });
  const bulk = pc.createDataChannel(TUNNEL_CHANNELS.bulk.label, {
    negotiated: true,
    id: TUNNEL_CHANNELS.bulk.id,
    ordered: true,
  });
  return { control, bulk };
}
