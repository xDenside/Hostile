import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  checkTunnelRoute,
  decodeCredit,
  decodeFrame,
  encodeCredit,
  encodeFrame,
  encodeJsonFrame,
  encodeMessagePiece,
  FRAME,
  parseJsonPayload,
  TUNNEL_CREDIT_STEP,
  TUNNEL_MAX_CHUNK,
  TUNNEL_MAX_FRAME,
  TUNNEL_MAX_STREAMS,
  TUNNEL_MAX_WS_MESSAGE,
  TUNNEL_PROTOCOL,
  TUNNEL_STREAM_WINDOW,
  type TunnelByeReason,
  type TunnelHead,
  type TunnelOpenHttp,
  type TunnelOpenWs,
  type TunnelTarget,
} from '@hostile/shared';
import { GATEWAY_TOKEN_HEADER } from '../http/gateway-address.js';

export interface GatewayOptions {
  roomUrl: string;
  livekitUrl: string | null;
  origin: string;
  secret: string;
  roomTrustProxy: boolean | number | string;
  roomToken: string;
  port?: number;
  maxGuests?: number;
  maxNewGuestsPerMinute?: number;
  maxAnonymousGuests?: number;
  signInLimitMs?: number;
}

export interface TunnelGateway {
  port: number;
  url: string;
  guests(): number;
  close(): Promise<void>;
}

const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'range',
  'user-agent',
  'x-csrf-token',
]);
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const IDLE_LIMIT_MS = 45_000;
const AUTH_LIMIT_MS = 5_000;
const MAX_ANONYMOUS_GUESTS = 10;
const SIGN_IN_LIMIT_MS = 3 * 60_000;
const OPENS_PER_SECOND = 50;
const OPENS_BURST = 200;
const ROOM_OPENS_PER_SECOND = 400;
const ROOM_OPENS_BURST = 800;
const MAX_CLOSE_REASON = 123;
const DISABLED_MESSAGE = /^42\["session:ended",\{"reason":"disabled"\}\]$/;
const ACCEPTED_MESSAGE = /^40\{/;

class Bucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

function closeReason(given: unknown): string {
  if (typeof given !== 'string') return '';
  const bytes = Buffer.from(given.slice(0, MAX_CLOSE_REASON));
  if (bytes.length <= MAX_CLOSE_REASON) return bytes.toString('utf8');
  return bytes
    .subarray(0, MAX_CLOSE_REASON)
    .toString('utf8')
    .replace(/\uFFFD+$/, '');
}

function allowedHeaders(given: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!given || typeof given !== 'object') return out;
  for (const [name, value] of Object.entries(given)) {
    const lower = name.toLowerCase();
    if (ALLOWED_REQUEST_HEADERS.has(lower) && typeof value === 'string') out[lower] = value;
  }
  return out;
}

const guestAddress = () =>
  `fd68:${randomBytes(14)
    .toString('hex')
    .replace(/(.{4})(?=.)/g, '$1:')}`;

interface Stream {
  sendWindow: number;
  receiveWindow: number;
  unreported: number;
  onCredit(): void;
  onData(bytes: Buffer): void;
  onEnd(): void;
  onMessage(flags: number, bytes: Buffer): void;
  onClose(code: number | undefined, reason: string | undefined): void;
  destroy(): void;
}

class GuestLink {
  readonly address = guestAddress();
  private readonly streams = new Map<number, Stream>();
  private lastSeen = Date.now();
  private readonly joinedAt = Date.now();
  private readonly opens = new Bucket(OPENS_PER_SECOND, OPENS_BURST);
  private over = false;
  signedIn = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly options: GatewayOptions,
    private readonly roomOpens: Bucket,
    private readonly onGone: () => void,
  ) {
    socket.on('message', (data, isBinary) => {
      if (!isBinary) return this.bye('protocol_error');
      try {
        this.onFrame(toBuffer(data));
      } catch {
        this.bye('protocol_error');
      }
    });
    socket.on('close', () => this.destroy());
    socket.on('error', () => this.destroy());
  }

  get idle() {
    return Date.now() - this.lastSeen > IDLE_LIMIT_MS;
  }

  waitedLongerThan(ms: number) {
    return !this.signedIn && Date.now() - this.joinedAt > ms;
  }

  bye(reason: TunnelByeReason) {
    if (this.over) return;
    this.send(encodeJsonFrame(FRAME.BYE, 0, { reason }));
    this.socket.close(1000);
    this.destroy();
  }

  destroy() {
    if (this.over) return;
    this.over = true;
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000);
    this.onGone();
  }

  private send(frame: Uint8Array) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(frame, { binary: true });
  }

  private onFrame(raw: Buffer) {
    this.lastSeen = Date.now();
    if (raw.length > TUNNEL_MAX_FRAME) return this.bye('frame_too_large');
    const frame = decodeFrame(raw);
    if (!frame) return this.bye('protocol_error');
    const { type, streamId, payload } = frame;
    const bytes = Buffer.from(payload);
    switch (type) {
      case FRAME.HELLO: {
        const hello = parseJsonPayload<{ version?: number }>(payload);
        if (hello?.version !== TUNNEL_PROTOCOL) return this.bye('version_mismatch');
        return this.send(encodeJsonFrame(FRAME.WELCOME, 0, { version: TUNNEL_PROTOCOL }));
      }
      case FRAME.PING:
        return this.send(encodeFrame(FRAME.PONG, 0));
      case FRAME.OPEN_HTTP:
      case FRAME.OPEN_WS: {
        if (this.streams.has(streamId)) return this.bye('protocol_error');
        if (this.streams.size >= TUNNEL_MAX_STREAMS) return this.bye('too_many_streams');
        if (!this.opens.take()) return this.bye('too_many_streams');
        if (!this.roomOpens.take()) return this.reset(streamId, 'refused', 'the host is busy');
        return type === FRAME.OPEN_HTTP
          ? this.openHttp(streamId, parseJsonPayload<TunnelOpenHttp>(payload))
          : this.openWs(streamId, parseJsonPayload<TunnelOpenWs>(payload));
      }
    }
    const stream = this.streams.get(streamId);
    if (!stream) return;
    switch (type) {
      case FRAME.CREDIT: {
        const credit = decodeCredit(payload);
        if (credit < 0 || stream.sendWindow + credit > 2 * TUNNEL_STREAM_WINDOW)
          return this.bye('protocol_error');
        stream.sendWindow += credit;
        return stream.onCredit();
      }
      case FRAME.DATA:
      case FRAME.MESSAGE: {
        if (type === FRAME.MESSAGE && bytes.length === 0) return this.bye('protocol_error');
        stream.receiveWindow -= bytes.length;
        if (stream.receiveWindow < 0) return this.bye('protocol_error');
        return type === FRAME.DATA
          ? stream.onData(bytes)
          : stream.onMessage(bytes[0] ?? 0, bytes.subarray(1));
      }
      case FRAME.END:
        return stream.onEnd();
      case FRAME.CLOSE: {
        const close = parseJsonPayload<{ code?: number; reason?: string }>(payload);
        return stream.onClose(close?.code, close?.reason);
      }
      case FRAME.RESET:
        stream.destroy();
        this.streams.delete(streamId);
        return;
      default:
        return this.bye('protocol_error');
    }
  }

  private reset(id: number, code: string, message: string) {
    this.send(encodeJsonFrame(FRAME.RESET, id, { code, message }));
    this.streams.get(id)?.destroy();
    this.streams.delete(id);
  }

  private upstream(target: TunnelTarget): string | null {
    return target === 'room' ? this.options.roomUrl : this.options.livekitUrl;
  }

  private headersFor(target: TunnelTarget, given: unknown): Record<string, string> {
    return {
      ...allowedHeaders(given),
      'x-forwarded-for': this.address,
      ...(target === 'room'
        ? { origin: this.options.origin, [GATEWAY_TOKEN_HEADER]: this.options.roomToken }
        : {}),
    };
  }

  private report(id: number, stream: Stream, bytes: number) {
    stream.unreported += bytes;
    stream.receiveWindow += bytes;
    if (stream.unreported >= TUNNEL_CREDIT_STEP) {
      this.send(encodeFrame(FRAME.CREDIT, id, encodeCredit(stream.unreported)));
      stream.unreported = 0;
    }
  }

  private openHttp(id: number, open: TunnelOpenHttp | null) {
    const method = typeof open?.method === 'string' ? open.method.toUpperCase() : '';
    const route = checkTunnelRoute('http', open?.target, open?.path, method);
    if (!open || !route.ok)
      return this.reset(id, 'refused', route.ok ? 'bad request' : route.reason);
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method))
      return this.reset(id, 'refused', 'method not allowed');
    const base = this.upstream(route.target);
    if (!base) return this.reset(id, 'refused', 'target not available');
    const upstream = new URL(base);

    let request: ClientRequest | null = null;
    let response: IncomingMessage | null = null;
    let held: Buffer | null = null;
    let responseEnded = false;
    const finish = () => {
      this.send(encodeFrame(FRAME.END, id));
      this.streams.delete(id);
      request?.destroy();
    };
    const pump = (chunk: Buffer | null) => {
      let rest = chunk ?? held;
      held = null;
      while (rest && rest.length > 0) {
        const room = Math.min(stream.sendWindow, TUNNEL_MAX_CHUNK);
        if (room <= 0) {
          held = rest;
          response?.pause();
          return;
        }
        const piece = rest.subarray(0, room);
        rest = rest.subarray(piece.length);
        stream.sendWindow -= piece.length;
        this.send(encodeFrame(FRAME.DATA, id, piece));
      }
      if (responseEnded) finish();
      else response?.resume();
    };
    const stream: Stream = {
      sendWindow: TUNNEL_STREAM_WINDOW,
      receiveWindow: TUNNEL_STREAM_WINDOW,
      unreported: 0,
      onCredit: () => pump(null),
      onData: (bytes) => {
        if (!open.hasBody || !request || request.writableEnded) return;
        request.write(bytes, () => this.report(id, stream, bytes.length));
      },
      onEnd: () => {
        if (request && !request.writableEnded) request.end();
      },
      onMessage: () => this.bye('protocol_error'),
      onClose: () => this.bye('protocol_error'),
      destroy: () => {
        response?.destroy();
        request?.destroy();
      },
    };
    this.streams.set(id, stream);
    try {
      request = http.request({
        host: upstream.hostname,
        port: upstream.port,
        method,
        path: route.path,
        headers: this.headersFor(route.target, open.headers),
        agent: false,
      });
    } catch {
      return this.reset(id, 'refused', 'bad request');
    }
    request.on('response', (res) => {
      response = res;
      const headers: [string, string][] = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const name = res.rawHeaders[i]!.toLowerCase();
        if (!HOP_BY_HOP.has(name)) headers.push([name, res.rawHeaders[i + 1]!]);
      }
      const head: TunnelHead = { status: res.statusCode ?? 502, headers };
      this.send(encodeJsonFrame(FRAME.HEAD, id, head));
      res.on('data', (chunk: Buffer) => pump(chunk));
      res.on('end', () => {
        responseEnded = true;
        if (!held) finish();
      });
      res.on('error', () => this.reset(id, 'upstream_error', 'the answer was cut off'));
    });
    request.on('error', () => {
      if (this.streams.has(id) && !response)
        this.reset(id, 'upstream_error', 'the host could not reach its server');
    });
    if (!open.hasBody) request.end();
  }

  private openWs(id: number, open: TunnelOpenWs | null) {
    const route = checkTunnelRoute('ws', open?.target, open?.path);
    if (!open || !route.ok)
      return this.reset(id, 'refused', route.ok ? 'bad request' : route.reason);
    const base = this.upstream(route.target);
    if (!base) return this.reset(id, 'refused', 'target not available');
    const url = base.replace(/^http/, 'ws') + route.path;
    const protocols = Array.isArray(open.protocols)
      ? open.protocols.filter((p) => typeof p === 'string')
      : [];
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, protocols, {
        headers: this.headersFor(route.target, open.headers),
        perMessageDeflate: false,
        maxPayload: TUNNEL_MAX_WS_MESSAGE,
        handshakeTimeout: 10_000,
        followRedirects: false,
      });
    } catch {
      return this.reset(id, 'refused', 'bad request');
    }
    const outgoing: Uint8Array[] = [];
    let closeFrame: Uint8Array | null = null;
    let cutAfterSending = false;
    let parts: Buffer[] = [];
    let partsLength = 0;
    const drain = () => {
      while (outgoing.length) {
        const next = outgoing[0]!;
        if (stream.sendWindow < next.length - 1) {
          socket.pause();
          return;
        }
        stream.sendWindow -= next.length - 1;
        outgoing.shift();
        this.send(encodeFrame(FRAME.MESSAGE, id, next));
      }
      if (socket.readyState === WebSocket.OPEN && socket.isPaused) socket.resume();
      if (closeFrame) {
        this.send(closeFrame);
        this.streams.delete(id);
      }
      if (cutAfterSending) this.bye('account_disabled');
    };
    const stream: Stream = {
      sendWindow: TUNNEL_STREAM_WINDOW,
      receiveWindow: TUNNEL_STREAM_WINDOW,
      unreported: 0,
      onCredit: drain,
      onData: () => this.bye('protocol_error'),
      onEnd: () => this.bye('protocol_error'),
      onMessage: (flags, bytes) => {
        partsLength += bytes.length;
        if (partsLength > TUNNEL_MAX_WS_MESSAGE) return this.bye('frame_too_large');
        parts.push(Buffer.from(bytes));
        if (!(flags & 1)) return;
        const whole = Buffer.concat(parts);
        const size = partsLength + parts.length;
        parts = [];
        partsLength = 0;
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(whole, { binary: (flags & 2) !== 0 }, () => this.report(id, stream, size));
      },
      onClose: (code, reason) => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          const valid =
            Number.isInteger(code) && (code === 1000 || (code! >= 3000 && code! <= 4999));
          if (valid) socket.close(code, closeReason(reason));
          else socket.close();
        }
      },
      destroy: () => socket.terminate(),
    };
    this.streams.set(id, stream);
    socket.on('open', () => {
      const head: TunnelHead = { status: 101, headers: [], protocol: socket.protocol };
      this.send(encodeJsonFrame(FRAME.HEAD, id, head));
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      const bytes = toBuffer(data);
      if (!isBinary && route.target === 'room' && bytes.length < 200) {
        const text = bytes.toString('utf8');
        if (ACCEPTED_MESSAGE.test(text)) this.signedIn = true;
        if (DISABLED_MESSAGE.test(text)) cutAfterSending = true;
      }
      if (bytes.length === 0) outgoing.push(encodeMessagePiece(bytes, true, isBinary));
      for (let at = 0; at < bytes.length; at += TUNNEL_MAX_CHUNK) {
        const piece = bytes.subarray(at, at + TUNNEL_MAX_CHUNK);
        outgoing.push(encodeMessagePiece(piece, at + TUNNEL_MAX_CHUNK >= bytes.length, isBinary));
      }
      drain();
    });
    socket.on('unexpected-response', (_req, res) => {
      this.reset(id, 'refused', `refused with status ${res.statusCode ?? 0}`);
    });
    socket.on('close', (code, reason) => {
      if (!this.streams.has(id)) return;
      closeFrame = encodeJsonFrame(FRAME.CLOSE, id, {
        code: code === 1005 || code === 1006 ? 1000 : code,
        reason: reason.toString('utf8'),
      });
      drain();
    });
    socket.on('error', () => {
      if (this.streams.has(id) && socket.readyState !== WebSocket.OPEN)
        this.reset(id, 'upstream_error', 'the host could not reach its server');
    });
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function sameSecret(given: unknown, secret: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startTunnelGateway(options: GatewayOptions): Promise<TunnelGateway> {
  if (options.roomTrustProxy !== 'loopback') {
    throw new Error(
      'The tunnel gateway needs a room server running with TRUST_PROXY=loopback, or every guest shares one address.',
    );
  }
  if (!options.roomToken)
    throw new Error('The tunnel gateway needs its token for the room server.');
  const maxGuests = options.maxGuests ?? 50;
  const maxNewPerMinute = options.maxNewGuestsPerMinute ?? 120;
  const maxAnonymous = options.maxAnonymousGuests ?? MAX_ANONYMOUS_GUESTS;
  const signInLimit = options.signInLimitMs ?? SIGN_IN_LIMIT_MS;
  const roomOpens = new Bucket(ROOM_OPENS_PER_SECOND, ROOM_OPENS_BURST);
  const links = new Set<GuestLink>();
  let recentJoins: number[] = [];
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: options.port ?? 0,
    maxPayload: TUNNEL_MAX_FRAME,
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.on('connection', (socket) => {
    socket.on('error', () => undefined);
    const authTimer = setTimeout(() => socket.terminate(), AUTH_LIMIT_MS);
    socket.once('message', (data, isBinary) => {
      clearTimeout(authTimer);
      const hello = isBinary ? null : parseJsonPayload<{ secret?: string }>(toBuffer(data));
      if (!sameSecret(hello?.secret, options.secret)) {
        socket.close(4001);
        return;
      }
      const now = Date.now();
      recentJoins = recentJoins.filter((t) => now - t < 60_000);
      if (recentJoins.length < maxNewPerMinute) {
        const waiting = [...links].filter((link) => !link.signedIn);
        if (waiting.length >= maxAnonymous || (links.size >= maxGuests && waiting.length))
          waiting[0]!.bye('room_full');
      }
      if (links.size >= maxGuests || recentJoins.length >= maxNewPerMinute) {
        socket.send(encodeJsonFrame(FRAME.BYE, 0, { reason: 'room_full' }), { binary: true });
        socket.close(1000);
        return;
      }
      recentJoins.push(now);
      socket.send(JSON.stringify({ ok: true }));
      const link: GuestLink = new GuestLink(socket, options, roomOpens, () => links.delete(link));
      links.add(link);
    });
  });
  const sweeper = setInterval(
    () => {
      for (const link of links) {
        if (link.idle) link.destroy();
        else if (link.waitedLongerThan(signInLimit)) link.bye('sign_in_timeout');
      }
    },
    Math.min(10_000, signInLimit),
  );
  sweeper.unref();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    guests: () => links.size,
    async close() {
      clearInterval(sweeper);
      for (const link of links) link.bye('host_stopping');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
