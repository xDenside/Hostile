import { describe, expect, it } from 'vitest';
import { ChannelWriter, remoteFingerprint, relaySealFor } from '../src/tunnel/rendezvous';

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

describe('the seal on what goes through a relay', () => {
  const secret = 'ab'.repeat(16);

  it('opens with the same code and hides the words', async () => {
    const seal = await relaySealFor(secret);
    const text = JSON.stringify({ peerId: 'abc', passive: true });
    const sealed = await seal.seal(text);
    expect(sealed).not.toContain('peerId');
    expect(sealed).not.toContain('abc');
    expect(await seal.open(sealed)).toBe(text);
  });

  it('gives a different blob each time', async () => {
    const seal = await relaySealFor(secret);
    expect(await seal.seal('same')).not.toBe(await seal.seal('same'));
  });

  it('drops what another code sealed, and anything that is not a seal', async () => {
    const seal = await relaySealFor(secret);
    const other = await relaySealFor('cd'.repeat(16));
    expect(await seal.open(await other.seal('{"peerId":"x"}'))).toBeNull();
    for (const junk of ['{"peerId":"zzzz"}', '', '!!!', 'AAAA', 5, null, undefined, {}])
      expect(await seal.open(junk)).toBeNull();
    expect(await seal.open('A'.repeat(300_000))).toBeNull();
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
