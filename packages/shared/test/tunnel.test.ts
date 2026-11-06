import { describe, expect, it } from 'vitest';
import {
  checkTunnelRoute,
  decodeFrame,
  encodeCredit,
  decodeCredit,
  encodeFrame,
  formatRoomCode,
  FRAME,
  frameIsBulk,
  parseRoomCode,
  TUNNEL_BULK_BIT,
  TUNNEL_MAX_FRAME,
} from '../src/tunnel';

describe('frames', () => {
  it('round-trips the type, a large stream id and the payload', () => {
    const id = (7 | TUNNEL_BULK_BIT) >>> 0;
    const frame = encodeFrame(FRAME.DATA, id, Uint8Array.from([1, 2, 3]));
    const decoded = decodeFrame(frame)!;
    expect(decoded.type).toBe(FRAME.DATA);
    expect(decoded.streamId).toBe(id);
    expect([...decoded.payload]).toEqual([1, 2, 3]);
    expect(frameIsBulk(frame)).toBe(true);
    expect(frameIsBulk(encodeFrame(FRAME.DATA, 7))).toBe(false);
  });

  it('refuses a frame past the limit, and one too short to have a header', () => {
    expect(decodeFrame(new Uint8Array(TUNNEL_MAX_FRAME + 1))).toBeNull();
    expect(decodeFrame(new Uint8Array(4))).toBeNull();
    expect(decodeFrame(new Uint8Array(TUNNEL_MAX_FRAME))).not.toBeNull();
  });

  it('round-trips credit, and refuses a malformed one', () => {
    expect(decodeCredit(encodeCredit(300_000))).toBe(300_000);
    expect(decodeCredit(new Uint8Array(3))).toBe(-1);
  });
});

describe('what a guest may reach', () => {
  const refused: [string, unknown, unknown][] = [
    ['http', 'room', 'http://127.0.0.1:5432/'],
    ['http', 'room', '//evil.example/api/x'],
    ['http', 'room', '\\\\evil.example/api/x'],
    ['http', 'room', '/\\evil.example/api/x'],
    ['http', 'room', '@evil.example/api/x'],
    ['http', 'room', '/api/x y'],
    ['http', 'room', '/api/x\r\nHost: evil'],
    ['http', 'room', '/api/../etc/passwd'],
    ['http', 'room', '/api/%2e%2e/x'],
    ['http', 'room', '/api%2fx'],
    ['http', 'room', '/api/livekit'],
    ['http', 'room', '/API/LIVEKIT/x'],
    ['http', 'room', '/'],
    ['http', 'room', '/socket.io/'],
    ['http', 'livekit', '/twirp/livekit.RoomService/ListRooms'],
    ['http', 'http://127.0.0.1:1', '/api/x'],
    ['http', 'nothing', '/api/x'],
    ['http', undefined, '/api/x'],
    ['http', 'room', 42],
    ['ws', 'room', '/api/health'],
    ['ws', 'livekit', '/twirp'],
    ['ws', 'ws://127.0.0.1:1', '/socket.io/'],
  ];
  it.each(refused)('%s %s %s is refused', (kind, target, path) => {
    expect(checkTunnelRoute(kind as 'http', target, path).ok).toBe(false);
  });

  it("refuses the owner's exchange however it is spelled", () => {
    for (const path of [
      '/api/auth/owner',
      '/API/auth/owner',
      '/api/AUTH/OWNER',
      '/api/auth/owner/x',
    ]) {
      expect(checkTunnelRoute('http', 'room', path, 'POST').ok, path).toBe(false);
    }
    expect(checkTunnelRoute('http', 'room', '/api/join', 'POST').ok).toBe(true);
  });

  it('refuses a write to LiveKit over HTTP', () => {
    expect(checkTunnelRoute('http', 'livekit', '/rtc/validate', 'POST').ok).toBe(false);
  });

  it('allows what the client uses, with the query kept', () => {
    expect(checkTunnelRoute('http', 'room', '/api/bootstrap')).toEqual({
      ok: true,
      target: 'room',
      path: '/api/bootstrap',
    });
    expect(checkTunnelRoute('ws', 'room', '/socket.io/?EIO=4&transport=websocket').ok).toBe(true);
    expect(checkTunnelRoute('ws', 'livekit', '/rtc/v1?access_token=x').ok).toBe(true);
    expect(checkTunnelRoute('http', 'livekit', '/rtc/v1/validate?access_token=x').ok).toBe(true);
  });
});

describe('room codes', () => {
  const secret = Uint8Array.from({ length: 16 }, (_, i) => i * 13);
  const hex = [...secret].map((b) => b.toString(16).padStart(2, '0')).join('');

  it('round-trips 128 bits', () => {
    expect(parseRoomCode(formatRoomCode(secret))).toBe(hex);
  });

  it('takes it pasted with spaces, in lower case, or as a link', () => {
    const code = formatRoomCode(secret);
    expect(parseRoomCode(`  ${code.toLowerCase()} `)).toBe(hex);
    expect(parseRoomCode(code.replace(/-/g, ' '))).toBe(hex);
    expect(parseRoomCode(`https://example.test/Hostile/#${code}`)).toBe(hex);
  });

  it('catches a typo in any position, and anything that is not a code', () => {
    const code = formatRoomCode(secret).replace(/-/g, '');
    for (let i = 0; i < code.length; i++) {
      const other = code[i] === 'A' ? 'B' : 'A';
      expect(parseRoomCode(code.slice(0, i) + other + code.slice(i + 1))).toBeNull();
    }
    expect(parseRoomCode('')).toBeNull();
    expect(parseRoomCode('not-a-code')).toBeNull();
    expect(parseRoomCode(code.slice(1))).toBeNull();
  });
});
