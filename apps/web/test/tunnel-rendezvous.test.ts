import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { formatRoomCode, parseRoomCode, type BridgeIdentity } from '@hostile/shared';
import {
  ChannelWriter,
  guestSealFor,
  hostSealFor,
  KNOCK,
  remoteFingerprint,
  roomCodeCommitment,
} from '../src/tunnel/rendezvous';

class StubChannel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  bufferedAmountLowThreshold = 0;
  sent: Uint8Array[] = [];
  send(frame: Uint8Array) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = 'closed';
  }
}

const channelOf = (stub: StubChannel) => stub as unknown as RTCDataChannel;

describe('ChannelWriter', () => {
  it('counts what waits, and calls out once when it passes the limit', async () => {
    const stub = new StubChannel();
    stub.bufferedAmount = 10_000_000;
    let overflows = 0;
    const writer = new ChannelWriter(channelOf(stub), {
      maxQueuedBytes: 1000,
      onOverflow: () => overflows++,
    });
    for (let i = 0; i < 5; i++) void writer.write(new Uint8Array(100)).catch(() => undefined);
    expect(writer.queuedBytes).toBe(500);
    expect(overflows).toBe(0);
    for (let i = 0; i < 6; i++) void writer.write(new Uint8Array(100)).catch(() => undefined);
    expect(writer.queuedBytes).toBe(1100);
    expect(overflows).toBe(1);
  });

  it('counts down as the channel drains, so an honest burst is never refused', async () => {
    const stub = new StubChannel();
    let overflows = 0;
    const writer = new ChannelWriter(channelOf(stub), {
      maxQueuedBytes: 1000,
      onOverflow: () => overflows++,
    });
    for (let i = 0; i < 100; i++) await writer.write(new Uint8Array(100));
    expect(stub.sent).toHaveLength(100);
    expect(writer.queuedBytes).toBe(0);
    expect(overflows).toBe(0);
  });
});

const KNOWN_KEY = Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => i + 1)]);
const KNOWN_SALT = Uint8Array.from(Array.from({ length: 32 }, (_, i) => 0xa0 + i));
const KNOWN_CODE = 'A4N3G-NB092-0C2YQ-RH1FE-GNR5Q-8GH8';

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(new Uint8Array(bytes)).toString('base64url');
const fromB64url = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));

async function newIdentity(): Promise<BridgeIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return {
    privateKey: b64url(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
    salt: b64url(randomBytes(32)),
  };
}

async function secretOf(identity: BridgeIdentity) {
  const bytes = await roomCodeCommitment(fromB64url(identity.publicKey), fromB64url(identity.salt));
  return parseRoomCode(formatRoomCode(bytes))!;
}

const newDh = () =>
  crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

const outerKey = (secret: string) =>
  createHash('sha256').update(`hostile-relay/${secret}`).digest();

function openOuter(secret: string, sealed: string) {
  const whole = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', outerKey(secret), whole.subarray(0, 12));
  decipher.setAuthTag(whole.subarray(-16));
  return Buffer.concat([decipher.update(whole.subarray(12, -16)), decipher.final()]).toString();
}

function sealOuter(secret: string, text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', outerKey(secret), iv);
  const body = Buffer.concat([cipher.update(text), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
}

const resealed = (secret: string, sealed: string, change: (e: Record<string, unknown>) => void) => {
  const envelope = JSON.parse(openOuter(secret, sealed)) as Record<string, unknown>;
  change(envelope);
  return sealOuter(secret, JSON.stringify(envelope));
};

async function room() {
  const identity = await newIdentity();
  const secret = await secretOf(identity);
  const host = await hostSealFor(secret, identity, await newDh());
  return { identity, secret, host };
}

const announce = JSON.stringify({ peerId: 'hosthosthost' });
const offer = JSON.stringify({
  peerId: 'guestguest',
  offer: 'v=0 a=candidate:1 1 udp 2122260223 192.168.1.23 54321 typ host',
});

describe('the code names the host key', () => {
  it('gives the same 16 bytes as the desktop, and a code that reads back to them', async () => {
    const bytes = await roomCodeCommitment(KNOWN_KEY, KNOWN_SALT);
    expect(formatRoomCode(bytes)).toBe(KNOWN_CODE);
    expect(parseRoomCode(KNOWN_CODE)).toBe(Buffer.from(bytes).toString('hex'));
    expect(parseRoomCode(KNOWN_CODE)).toBe('512a3855604880c17af8885ee85705ba');
  });
});

describe('the seals on what goes through a relay', () => {
  it('carries the host to the guest and the guest to that host alone', async () => {
    const { secret, host } = await room();
    const guest = await guestSealFor(secret);
    expect(await guest.open(await host.seal(announce))).toBe(announce);
    const sealed = await guest.seal(offer);
    expect(await host.open(sealed)).toBe(offer);
    expect(await guest.seal(offer)).not.toBe(sealed);
    expect(await host.open(await guest.seal(KNOCK))).toBe(KNOCK);
  });

  it('keeps a guest envelope from another code holder, guest or host', async () => {
    const { identity, secret, host } = await room();
    const guest = await guestSealFor(secret);
    const holder = await guestSealFor(secret);
    const envelope = await host.seal(announce);
    expect(await guest.open(envelope)).toBe(announce);
    expect(await holder.open(envelope)).toBe(announce);
    const sealed = await guest.seal(offer);
    const sameKey = await hostSealFor(secret, identity, await newDh());
    expect(await sameKey.open(sealed)).toBeNull();
    const fake = await hostSealFor(secret, await newIdentity(), await newDh());
    expect(await fake.open(sealed)).toBeNull();
    expect(await host.open(sealed)).toBe(offer);
  });

  it('shows the code key alone nothing of what a guest sends', async () => {
    const { secret, host } = await room();
    const guest = await guestSealFor(secret);
    await guest.open(await host.seal(announce));
    const opened = openOuter(secret, await guest.seal(offer));
    const envelope = JSON.parse(opened) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(['c', 'e', 'i', 't', 'v']);
    expect(envelope.t).toBe('g');
    for (const words of ['candidate', '192.168', 'typ host', 'offer', 'guestguest'])
      expect(opened).not.toContain(words);
    const knock = JSON.parse(openOuter(secret, await guest.seal(KNOCK))) as unknown;
    expect(knock).toEqual({ v: 1, t: 'k' });
  });

  it('believes only the host the code names', async () => {
    const { identity, secret, host } = await room();
    const guest = await guestSealFor(secret);
    const dh = await newDh();
    const other = await newIdentity();
    const fakes = [
      await hostSealFor(secret, other, dh),
      await hostSealFor(secret, { ...other, salt: identity.salt }, dh),
      await hostSealFor(secret, { ...identity, publicKey: other.publicKey }, dh),
    ];
    for (const fake of fakes) expect(await guest.open(await fake.seal(announce))).toBeNull();

    const real = await host.seal(announce);
    const tampered = resealed(secret, real, (e) => {
      e.b = JSON.stringify({ peerId: 'someoneelse' });
    });
    expect(await guest.open(tampered)).toBeNull();
    const otherDh = new Uint8Array(await crypto.subtle.exportKey('raw', (await newDh()).publicKey));
    const swapped = resealed(secret, real, (e) => {
      e.dh = Buffer.from(otherDh).toString('base64');
    });
    expect(await guest.open(swapped)).toBeNull();
    const restamped = resealed(secret, real, (e) => {
      e.r = Number(e.r) + 1;
    });
    expect(await guest.open(restamped)).toBeNull();

    const elsewhere = await room();
    const forOtherCode = await hostSealFor(elsewhere.secret, identity, dh);
    const moved = sealOuter(secret, openOuter(elsewhere.secret, await forOtherCode.seal(announce)));
    expect(await guest.open(moved)).toBeNull();
    expect(await guest.open(await elsewhere.host.seal(announce))).toBeNull();
    const intoThisCode = sealOuter(
      secret,
      openOuter(elsewhere.secret, await elsewhere.host.seal(announce)),
    );
    expect(await guest.open(intoThisCode)).toBeNull();

    await expect(guest.seal(offer)).rejects.toThrow();
    expect(await guest.open(real)).toBe(announce);
  });

  it('sends nothing but a knock before a host is verified', async () => {
    const { secret } = await room();
    const guest = await guestSealFor(secret);
    await expect(guest.seal(offer)).rejects.toThrow();
    await expect(guest.seal(JSON.stringify({ peerId: 'x', passive: true }))).rejects.toThrow();
    expect(JSON.parse(openOuter(secret, await guest.seal(KNOCK)))).toEqual({ v: 1, t: 'k' });
  });

  it('follows the host to its new key when it restarts, and never back to an old one', async () => {
    const identity = await newIdentity();
    const secret = await secretOf(identity);
    const host = await hostSealFor(secret, identity, await newDh(), 1_000);
    const guest = await guestSealFor(secret);
    const old = await host.seal(announce);
    expect(await guest.open(old)).toBe(announce);
    const restarted = await hostSealFor(secret, identity, await newDh(), 2_000);
    expect(await guest.open(await restarted.seal(announce))).toBe(announce);
    expect(await guest.open(old)).toBeNull();
    expect(await guest.open(await host.seal(announce))).toBeNull();
    expect(await guest.open(await restarted.seal(announce))).toBe(announce);
    const sealed = await guest.seal(offer);
    expect(await restarted.open(sealed)).toBe(offer);
    expect(await host.open(sealed)).toBeNull();
  });

  it('turns any knock into the one knock, and drops the rest of what the code key opens', async () => {
    const { secret, host } = await room();
    const knock = sealOuter(secret, JSON.stringify({ v: 1, t: 'k', b: offer, peerId: 'zzzz' }));
    expect(await host.open(knock)).toBe(KNOCK);
    expect(await host.open(sealOuter(secret, offer))).toBeNull();
    expect(await host.open(sealOuter(secret, JSON.stringify({ peerId: 'zzzz' })))).toBeNull();
    expect(await host.open(await host.seal(announce))).toBeNull();
    const other = await hostSealFor(secret, await newIdentity(), await newDh());
    expect(await host.open(await other.seal(announce))).toBeNull();
    const guest = await guestSealFor(secret);
    expect(await guest.open(await guest.seal(KNOCK))).toBeNull();
    expect(await guest.open(sealOuter(secret, announce))).toBeNull();
  });

  it('answers malformed and oversized input with nothing, and never throws', async () => {
    const { secret, host } = await room();
    const guest = await guestSealFor(secret);
    await guest.open(await host.seal(announce));
    const point = Buffer.from([4, ...new Array<number>(64).fill(0)]).toString('base64');
    const realPoint = Buffer.from(
      await crypto.subtle.exportKey('raw', (await newDh()).publicKey),
    ).toString('base64');
    const iv = randomBytes(12).toString('base64');
    const g = (fields: Record<string, unknown>) =>
      sealOuter(
        secret,
        JSON.stringify({ v: 1, t: 'g', e: realPoint, i: iv, c: 'A'.repeat(64), ...fields }),
      );
    const real = JSON.parse(openOuter(secret, await host.seal(announce))) as Record<
      string,
      unknown
    >;
    const h = (fields: Record<string, unknown>) =>
      sealOuter(secret, JSON.stringify({ ...real, ...fields }));
    const junk: unknown[] = [
      '',
      '!!!',
      'AAAA',
      5,
      null,
      undefined,
      {},
      'A'.repeat(300_000),
      sealOuter(secret, 'not json'),
      sealOuter(secret, 'null'),
      sealOuter(secret, '[]'),
      sealOuter(secret, '"text"'),
      sealOuter(secret, JSON.stringify({ v: 2, t: 'g' })),
      g({ e: point }),
      g({ e: 'AAAA' }),
      g({ e: Buffer.from([3, ...randomBytes(64)]).toString('base64') }),
      g({ i: 'AAAA' }),
      g({ c: 'A'.repeat(200_000) }),
      g({ c: 'AAAA' }),
      g({ c: '!!!!' }),
      g({ e: 5 }),
      h({ id: 'AAAA' }),
      h({ id: point }),
      h({ s: 'AAAA' }),
      h({ dh: point }),
      h({ g: 'AAAA' }),
      h({ g: 'A'.repeat(88) }),
      h({ b: 5 }),
      h({ r: undefined }),
      h({ r: '5' }),
      h({ r: -1 }),
      h({ r: 1.5 }),
      h({ r: 2 ** 64 }),
    ];
    for (const value of junk) {
      await expect(host.open(value)).resolves.toBeNull();
      await expect(guest.open(value)).resolves.toBeNull();
    }
  });
});

describe('remoteFingerprint', () => {
  const line = (hash: string) => `a=fingerprint:sha-256 ${hash}`;
  const sdp = (...lines: string[]) =>
    ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', ...lines, ''].join('\r\n');

  it('reads the one fingerprint in a description, however it is cased', () => {
    expect(remoteFingerprint(sdp(line('AA:BB')))).toBe('sha-256 AA:BB');
    expect(remoteFingerprint(sdp(line('aa:bb')))).toBe('sha-256 AA:BB');
    expect(remoteFingerprint(sdp(line('AA:BB'), 'm=application 9', line('AA:BB')))).toBe(
      'sha-256 AA:BB',
    );
  });

  it('answers nothing for a description with none', () => {
    expect(remoteFingerprint(sdp())).toBeNull();
    expect(remoteFingerprint(undefined)).toBeNull();
  });

  it('answers nothing when two differ, since the browser may check the other one', () => {
    expect(remoteFingerprint(sdp(line('AA:BB'), 'm=application 9', line('CC:DD')))).toBeNull();
  });
});
