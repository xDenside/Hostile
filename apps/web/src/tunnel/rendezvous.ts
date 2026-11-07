import {
  HOST_KEY_BYTES,
  ROOM_CODE_BYTES,
  ROOM_CODE_SALT_BYTES,
  roomCodeInput,
  TUNNEL_BUFFER_HIGH,
  TUNNEL_BUFFER_LOW,
  TUNNEL_CHANNELS,
  type BridgeIdentity,
} from '@hostile/shared';
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
const MAX_BODY = 64 * 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SIGNATURE_BYTES = 64;
const STAMP_BYTES = 8;
const CHUNK = 0x8000;
const DH = { name: 'ECDH', namedCurve: 'P-256' };
const SIGNING = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGNATURE = { name: 'ECDSA', hash: 'SHA-256' };

export const KNOCK = JSON.stringify({ peerId: '!' });
const KNOCK_ENVELOPE = JSON.stringify({ v: 1, t: 'k' });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += CHUNK)
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(text);
}

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const fromBase64Url = (text: string) => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/'));
const bytesOfHex = (secretHex: string) =>
  Uint8Array.from(secretHex.match(/../g)!, (pair) => parseInt(pair, 16));
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

function labelled(label: string, ...parts: Uint8Array[]) {
  const head = encoder.encode(label);
  const whole = new Uint8Array(parts.reduce((n, part) => n + part.length, head.length + 1));
  whole.set(head);
  let at = head.length + 1;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

function field(value: unknown, bytes: number) {
  if (typeof value !== 'string' || value.length > Math.ceil(bytes / 3) * 4) return null;
  const decoded = fromBase64(value);
  return decoded.length === bytes ? decoded : null;
}

function point(value: unknown) {
  const decoded = field(value, HOST_KEY_BYTES);
  return decoded?.[0] === 4 ? decoded : null;
}

function body(value: unknown) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BODY / 3) * 4) return null;
  const decoded = fromBase64(value);
  return decoded.length >= TAG_BYTES ? decoded : null;
}

function envelopeOf(text: string | null) {
  if (text === null) return null;
  const value = JSON.parse(text) as Record<string, unknown> | null;
  return value && typeof value === 'object' && value.v === 1 ? value : null;
}

export async function roomCodeCommitment(identityPublicKey: Uint8Array, salt: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', roomCodeInput(identityPublicKey, salt));
  return new Uint8Array(hash).subarray(0, ROOM_CODE_BYTES);
}

async function outerSealFor(secretHex: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    await digest('SHA-256', `hostile-relay/${secretHex}`),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  return {
    async seal(text: string) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text)),
      );
      const whole = new Uint8Array(iv.length + sealed.length);
      whole.set(iv);
      whole.set(sealed, iv.length);
      return toBase64(whole);
    },
    async open(sealed: unknown) {
      if (typeof sealed !== 'string' || sealed.length > MAX_SEALED) return null;
      try {
        const whole = fromBase64(sealed);
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: whole.subarray(0, IV_BYTES) },
          key,
          whole.subarray(IV_BYTES),
        );
        return decoder.decode(plain);
      } catch {
        return null;
      }
    },
  };
}

async function guestKey(
  shared: ArrayBuffer,
  code: Uint8Array<ArrayBuffer>,
  e: Uint8Array,
  dh: Uint8Array,
) {
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: code,
      info: labelled('hostile-guest-envelope/1', e, dh),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function stamp(run: number) {
  const bytes = new Uint8Array(STAMP_BYTES);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(run));
  return bytes;
}

const signed = (code: Uint8Array, dh: Uint8Array, run: number, text: string) =>
  labelled('hostile-host-envelope/1', code, dh, stamp(run), encoder.encode(text));

export async function hostSealFor(
  secretHex: string,
  identity: BridgeIdentity,
  dh: CryptoKeyPair,
  run = Date.now(),
): Promise<RelaySeal> {
  const outer = await outerSealFor(secretHex);
  const code = bytesOfHex(secretHex);
  const signer = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64Url(identity.privateKey),
    SIGNING,
    false,
    ['sign'],
  );
  const dhRaw = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  const fixed = {
    v: 1,
    t: 'h',
    id: toBase64(fromBase64Url(identity.publicKey)),
    s: toBase64(fromBase64Url(identity.salt)),
    dh: toBase64(dhRaw),
    r: run,
  };
  return {
    async seal(b) {
      const g = await crypto.subtle.sign(SIGNATURE, signer, signed(code, dhRaw, run, b));
      return outer.seal(JSON.stringify({ ...fixed, b, g: toBase64(new Uint8Array(g)) }));
    },
    async open(sealed) {
      try {
        const envelope = envelopeOf(await outer.open(sealed));
        if (envelope?.t === 'k') return KNOCK;
        if (envelope?.t !== 'g') return null;
        const e = point(envelope.e);
        const iv = field(envelope.i, IV_BYTES);
        const c = body(envelope.c);
        if (!e || !iv || !c) return null;
        const theirs = await crypto.subtle.importKey('raw', e, DH, false, []);
        const shared = await crypto.subtle.deriveBits(
          { name: 'ECDH', public: theirs },
          dh.privateKey,
          256,
        );
        const key = await guestKey(shared, code, e, dhRaw);
        return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, c));
      } catch {
        return null;
      }
    },
  };
}

export async function guestSealFor(secretHex: string): Promise<RelaySeal> {
  const outer = await outerSealFor(secretHex);
  const code = bytesOfHex(secretHex);
  let host: { key: CryptoKey; raw: Uint8Array<ArrayBuffer>; run: number } | null = null;
  const older = (run: number) => host !== null && run < host.run;
  return {
    async seal(text) {
      if (text === KNOCK) return outer.seal(KNOCK_ENVELOPE);
      const to = host;
      if (!to) throw new Error('No host has been verified, so nothing goes on the relay.');
      const own = await crypto.subtle.generateKey(DH, false, ['deriveBits']);
      const e = new Uint8Array(await crypto.subtle.exportKey('raw', own.publicKey));
      const shared = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: to.key },
        own.privateKey,
        256,
      );
      const key = await guestKey(shared, code, e, to.raw);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text));
      return outer.seal(
        JSON.stringify({
          v: 1,
          t: 'g',
          e: toBase64(e),
          i: toBase64(iv),
          c: toBase64(new Uint8Array(c)),
        }),
      );
    },
    async open(sealed) {
      try {
        const envelope = envelopeOf(await outer.open(sealed));
        if (envelope?.t !== 'h' || typeof envelope.b !== 'string') return null;
        const run = envelope.r;
        if (typeof run !== 'number' || !Number.isSafeInteger(run) || run < 0 || older(run))
          return null;
        const id = point(envelope.id);
        const salt = field(envelope.s, ROOM_CODE_SALT_BYTES);
        const dh = point(envelope.dh);
        const g = field(envelope.g, SIGNATURE_BYTES);
        if (!id || !salt || !dh || !g) return null;
        if (!sameBytes(await roomCodeCommitment(id, salt), code)) return null;
        const verifier = await crypto.subtle.importKey('raw', id, SIGNING, false, ['verify']);
        if (
          !(await crypto.subtle.verify(SIGNATURE, verifier, g, signed(code, dh, run, envelope.b)))
        )
          return null;
        const key = await crypto.subtle.importKey('raw', dh, DH, false, []);
        if (older(run)) return null;
        host = { key, raw: dh, run };
        return envelope.b;
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
