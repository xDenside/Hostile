declare class TextEncoder {
  encode(text: string): Uint8Array<ArrayBuffer>;
}
declare class TextDecoder {
  decode(bytes: Uint8Array): string;
}

export const TUNNEL_PROTOCOL = 1;
export const TUNNEL_MAX_FRAME = 16 * 1024;
const HEADER_BYTES = 5;
export const TUNNEL_MAX_CHUNK = TUNNEL_MAX_FRAME - HEADER_BYTES - 1;
export const TUNNEL_STREAM_WINDOW = 256 * 1024;
export const TUNNEL_CREDIT_STEP = 64 * 1024;
export const TUNNEL_MAX_STREAMS = 64;
export const TUNNEL_MAX_WS_MESSAGE = 8 * 1024 * 1024;
export const TUNNEL_BULK_BIT = 0x80000000;
export const TUNNEL_CHANNELS = {
  control: { label: 'hostile-control', id: 64 },
  bulk: { label: 'hostile-bulk', id: 65 },
} as const;
export const TUNNEL_BUFFER_HIGH = 512 * 1024;
export const TUNNEL_BUFFER_LOW = 128 * 1024;
export const TUNNEL_MAX_QUEUED = 2 * TUNNEL_MAX_STREAMS * TUNNEL_STREAM_WINDOW;

export const FRAME = {
  HELLO: 1,
  WELCOME: 2,
  BYE: 3,
  PING: 4,
  PONG: 5,
  OPEN_HTTP: 10,
  OPEN_WS: 11,
  HEAD: 12,
  DATA: 13,
  END: 14,
  MESSAGE: 15,
  CLOSE: 16,
  RESET: 17,
  CREDIT: 18,
} as const;

export type TunnelTarget = 'room' | 'livekit';

export interface TunnelOpenHttp {
  target: TunnelTarget;
  path: string;
  method: string;
  headers: Record<string, string>;
  hasBody: boolean;
}
export interface TunnelOpenWs {
  target: TunnelTarget;
  path: string;
  protocols: string[];
  headers: Record<string, string>;
}
export interface TunnelHead {
  status: number;
  headers: [string, string][];
  protocol?: string;
}
export type TunnelByeReason =
  | 'frame_too_large'
  | 'protocol_error'
  | 'too_many_streams'
  | 'version_mismatch'
  | 'account_disabled'
  | 'room_full'
  | 'sign_in_timeout'
  | 'host_stopping';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(type: number, streamId: number, payload?: Uint8Array) {
  const frame = new Uint8Array(HEADER_BYTES + (payload?.length ?? 0));
  frame[0] = type;
  frame[1] = (streamId >>> 24) & 0xff;
  frame[2] = (streamId >>> 16) & 0xff;
  frame[3] = (streamId >>> 8) & 0xff;
  frame[4] = streamId & 0xff;
  if (payload) frame.set(payload, HEADER_BYTES);
  return frame;
}

export function encodeJsonFrame(type: number, streamId: number, value: unknown) {
  return encodeFrame(type, streamId, encoder.encode(JSON.stringify(value)));
}

export function decodeFrame(frame: Uint8Array): {
  type: number;
  streamId: number;
  payload: Uint8Array;
} | null {
  if (frame.length < HEADER_BYTES || frame.length > TUNNEL_MAX_FRAME) return null;
  return {
    type: frame[0]!,
    streamId: ((frame[1]! << 24) | (frame[2]! << 16) | (frame[3]! << 8) | frame[4]!) >>> 0,
    payload: frame.subarray(HEADER_BYTES),
  };
}

export const frameIsBulk = (frame: Uint8Array) => frame.length > 1 && (frame[1]! & 0x80) !== 0;

export function parseJsonPayload<T>(payload: Uint8Array): T | null {
  try {
    return JSON.parse(decoder.decode(payload)) as T;
  } catch {
    return null;
  }
}

export const encodeCredit = (bytes: number) => {
  const out = new Uint8Array(4);
  out[0] = (bytes >>> 24) & 0xff;
  out[1] = (bytes >>> 16) & 0xff;
  out[2] = (bytes >>> 8) & 0xff;
  out[3] = bytes & 0xff;
  return out;
};
export const decodeCredit = (p: Uint8Array) =>
  p.length === 4 ? ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0 : -1;

export function encodeMessagePiece(bytes: Uint8Array, last: boolean, binary: boolean) {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = (last ? 1 : 0) | (binary ? 2 : 0);
  out.set(bytes, 1);
  return out;
}

const PLACEHOLDER_ORIGIN = 'http://tunnel.invalid';
const ROOM_WS_PATHS = new Set(['/socket.io/']);
const LIVEKIT_WS_PATHS = new Set(['/rtc', '/rtc/v1']);
const LIVEKIT_HTTP_PATHS = new Set(['/', '/rtc/validate', '/rtc/v1/validate']);

export function checkTunnelRoute(
  kind: 'http' | 'ws',
  target: unknown,
  rawPath: unknown,
  method = 'GET',
): { ok: true; target: TunnelTarget; path: string } | { ok: false; reason: string } {
  if (target !== 'room' && target !== 'livekit') return { ok: false, reason: 'unknown target' };
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//'))
    return { ok: false, reason: 'not a path' };
  if (/[\\\u0000- \u007f]/.test(rawPath)) return { ok: false, reason: 'not a path' };
  let url: URL;
  try {
    url = new URL(rawPath, PLACEHOLDER_ORIGIN);
  } catch {
    return { ok: false, reason: 'not a path' };
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return { ok: false, reason: 'not a path' };
  const pathname = url.pathname;
  if (/%2e|%2f|%5c/i.test(pathname)) return { ok: false, reason: 'not a path' };
  const path = pathname + url.search;
  if (kind === 'ws') {
    const allowed = target === 'room' ? ROOM_WS_PATHS : LIVEKIT_WS_PATHS;
    return allowed.has(pathname)
      ? { ok: true, target, path }
      : { ok: false, reason: 'path not allowed' };
  }
  if (target === 'livekit') {
    return LIVEKIT_HTTP_PATHS.has(pathname) && (method === 'GET' || method === 'HEAD')
      ? { ok: true, target, path }
      : { ok: false, reason: 'path not allowed' };
  }
  if (
    !pathname.startsWith('/api/') ||
    /^\/api\/livekit(\/|$)/i.test(pathname) ||
    /^\/api\/auth\/owner(\/|$)/i.test(pathname)
  )
    return { ok: false, reason: 'path not allowed' };
  return { ok: true, target, path };
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ROOM_CODE_BYTES = 16;
export const ROOM_CODE_SALT_BYTES = 32;
export const HOST_KEY_BYTES = 65;

export interface BridgeIdentity {
  privateKey: string;
  publicKey: string;
  salt: string;
}

function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function formatRoomCode(random: Uint8Array): string {
  if (random.length !== ROOM_CODE_BYTES) throw new Error('A room code needs 16 random bytes.');
  const crc = crc16(random);
  const bytes = [...random, crc >> 8, crc & 0xff];
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,5}/g)!.join('-');
}

export function parseRoomCode(text: string): string | null {
  const afterHash = text.includes('#') ? text.slice(text.lastIndexOf('#') + 1) : text;
  const clean = afterHash
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (clean.length !== 29) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  const secret = Uint8Array.from(bytes.slice(0, ROOM_CODE_BYTES));
  const sum = (bytes[ROOM_CODE_BYTES]! << 8) | bytes[ROOM_CODE_BYTES + 1]!;
  if (crc16(secret) !== sum) return null;
  return [...secret].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function roomCodeInput(identityPublicKey: Uint8Array, salt: Uint8Array) {
  if (identityPublicKey.length !== HOST_KEY_BYTES || salt.length !== ROOM_CODE_SALT_BYTES)
    throw new Error('A room code needs a 65-byte public key and a 32-byte salt.');
  const label = encoder.encode('hostile-room-code/1');
  const input = new Uint8Array(label.length + 1 + HOST_KEY_BYTES + ROOM_CODE_SALT_BYTES);
  input.set(label);
  input.set(identityPublicKey, label.length + 1);
  input.set(salt, label.length + 1 + HOST_KEY_BYTES);
  return input;
}
