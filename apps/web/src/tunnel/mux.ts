import {
  decodeCredit,
  encodeCredit,
  encodeFrame,
  encodeJsonFrame,
  encodeMessagePiece,
  FRAME,
  parseJsonPayload,
  TUNNEL_BULK_BIT,
  TUNNEL_CREDIT_STEP,
  TUNNEL_MAX_CHUNK,
  TUNNEL_MAX_STREAMS,
  TUNNEL_MAX_WS_MESSAGE,
  TUNNEL_STREAM_WINDOW,
  type TunnelHead,
  type TunnelTarget,
} from '@hostile/shared';
import type { CookieJar } from './cookie-jar';

export type FrameSender = (frame: Uint8Array<ArrayBuffer>, bulk: boolean) => Promise<void>;

export interface TunnelFetchInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
  bulk?: boolean;
  onUploadProgress?: (sent: number, total: number) => void;
}

const NULL_BODY = new Set([101, 204, 205, 304]);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

class SendWindow {
  available = TUNNEL_STREAM_WINDOW;
  private waiting: { n: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  private failure: Error | null = null;

  take(n: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiting.length === 0 && this.available >= n) {
      this.available -= n;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.waiting.push({ n, resolve, reject }));
  }

  grant(n: number) {
    this.available += n;
    while (this.waiting.length && this.available >= this.waiting[0]!.n) {
      const next = this.waiting.shift()!;
      this.available -= next.n;
      next.resolve();
    }
  }

  fail(err: Error) {
    this.failure = err;
    for (const w of this.waiting.splice(0)) w.reject(err);
  }
}

interface MuxStream {
  window: SendWindow;
  onHead?(head: TunnelHead): void;
  onData?(bytes: Uint8Array<ArrayBuffer>): void;
  onEnd?(): void;
  onMessage?(flags: number, bytes: Uint8Array<ArrayBuffer>): void;
  onClose?(code: number, reason: string): void;
  onFail(err: Error): void;
  onCredit?(): void;
}

const failed = (message: string) => new TypeError(message);

export class TunnelMux {
  private nextId = 1;
  private readonly streams = new Map<number, MuxStream>();
  private over: Error | null = null;

  constructor(
    private readonly send: FrameSender,
    private readonly jar: CookieJar,
  ) {}

  private allocate(bulk: boolean, stream: MuxStream): number {
    if (this.streams.size >= TUNNEL_MAX_STREAMS - 2) throw failed('Too many requests at once.');
    const id = ((this.nextId++ & 0x7fffffff) | (bulk ? TUNNEL_BULK_BIT : 0)) >>> 0;
    this.streams.set(id, stream);
    return id;
  }

  private post(frame: Uint8Array<ArrayBuffer>, bulk: boolean) {
    this.send(frame, bulk).catch(() => undefined);
  }

  receive(type: number, id: number, payload: Uint8Array<ArrayBuffer>) {
    const stream = this.streams.get(id);
    if (!stream) return;
    switch (type) {
      case FRAME.HEAD: {
        const head = parseJsonPayload<TunnelHead>(payload);
        if (head) stream.onHead?.(head);
        return;
      }
      case FRAME.DATA:
        return stream.onData?.(payload);
      case FRAME.END:
        this.streams.delete(id);
        return stream.onEnd?.();
      case FRAME.MESSAGE:
        return stream.onMessage?.(payload[0] ?? 0, payload.subarray(1));
      case FRAME.CLOSE: {
        const close = parseJsonPayload<{ code?: number; reason?: string }>(payload);
        this.streams.delete(id);
        return stream.onClose?.(close?.code ?? 1000, close?.reason ?? '');
      }
      case FRAME.RESET: {
        const reset = parseJsonPayload<{ message?: string }>(payload);
        this.streams.delete(id);
        stream.window.fail(failed(reset?.message ?? 'The host refused this.'));
        return stream.onFail(failed(reset?.message ?? 'The host refused this.'));
      }
      case FRAME.CREDIT: {
        const credit = decodeCredit(payload);
        if (credit > 0) stream.window.grant(credit);
        return stream.onCredit?.();
      }
    }
  }

  fail(message: string) {
    this.over = failed(message);
    for (const stream of this.streams.values()) {
      stream.window.fail(this.over);
      stream.onFail(this.over);
    }
    this.streams.clear();
  }

  fetch(target: TunnelTarget, path: string, init: TunnelFetchInit = {}): Promise<Response> {
    if (this.over) return Promise.reject(this.over);
    const signal = init.signal ?? null;
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    const bulk = init.bulk === true;
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? undefined).forEach((value, name) => (headers[name] = value));
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    headers['user-agent'] = navigator.userAgent;
    const hasBody = init.body !== undefined && init.body !== null;

    return new Promise<Response>((resolve, reject) => {
      let bodyController: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | null = null;
      let received = 0;
      let reported = 0;
      let ended = false;
      const HIGH_WATER = TUNNEL_CREDIT_STEP;
      const settle = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        const reason = signal!.reason as Error;
        this.post(encodeFrame(FRAME.RESET, id), bulk);
        this.streams.delete(id);
        stream.window.fail(reason);
        settle();
        reject(reason);
        try {
          bodyController?.error(reason);
        } catch {}
      };
      const stream: MuxStream = {
        window: new SendWindow(),
        onHead: (head) => {
          const out = new Headers();
          const cookies: string[] = [];
          for (const [name, value] of head.headers) {
            if (name === 'set-cookie') cookies.push(value);
            else out.append(name, value);
          }
          if (cookies.length) this.jar.absorb(cookies);
          if (NULL_BODY.has(head.status) || init.method === 'HEAD') {
            resolve(new Response(null, { status: head.status, headers: out }));
            return;
          }
          const body = new ReadableStream<Uint8Array<ArrayBuffer>>(
            {
              start: (c) => {
                bodyController = c;
              },
              pull: (c) => {
                const taken = received - (HIGH_WATER - (c.desiredSize ?? 0));
                if (!ended && taken - reported >= TUNNEL_CREDIT_STEP) {
                  this.post(encodeFrame(FRAME.CREDIT, id, encodeCredit(taken - reported)), bulk);
                  reported = taken;
                }
              },
              cancel: () => {
                if (!ended) this.post(encodeFrame(FRAME.RESET, id), bulk);
                this.streams.delete(id);
                stream.window.fail(failed('Canceled.'));
                settle();
              },
            },
            new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER }),
          );
          resolve(new Response(body, { status: head.status, headers: out }));
        },
        onData: (bytes) => {
          received += bytes.length;
          bodyController?.enqueue(bytes.slice());
        },
        onEnd: () => {
          ended = true;
          stream.window.fail(failed('The answer has ended.'));
          settle();
          try {
            bodyController?.close();
          } catch {}
        },
        onFail: (err) => {
          ended = true;
          settle();
          reject(err);
          try {
            bodyController?.error(err);
          } catch {}
        },
      };
      let id: number;
      try {
        id = this.allocate(bulk, stream);
      } catch (err) {
        reject(err as Error);
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.post(
        encodeJsonFrame(FRAME.OPEN_HTTP, id, {
          target,
          path,
          method: (init.method ?? 'GET').toUpperCase(),
          headers,
          hasBody,
        }),
        bulk,
      );
      if (hasBody) {
        void this.sendBody(id, stream.window, init.body!, bulk, init.onUploadProgress).catch(
          () => undefined,
        );
      }
    });
  }

  private async sendBody(
    id: number,
    window: SendWindow,
    body: BodyInit,
    bulk: boolean,
    onProgress?: (sent: number, total: number) => void,
  ) {
    let sent = 0;
    const sendPart = async (part: Uint8Array, total: number) => {
      for (let i = 0; i < part.length; i += TUNNEL_MAX_CHUNK) {
        const piece = part.subarray(i, i + TUNNEL_MAX_CHUNK);
        await window.take(piece.length);
        await this.send(encodeFrame(FRAME.DATA, id, piece), bulk);
        sent += piece.length;
        onProgress?.(sent, total);
      }
    };
    let total: number;
    if (typeof body === 'string') {
      const whole = new TextEncoder().encode(body);
      total = whole.length;
      await sendPart(whole, total);
    } else {
      const blob = body instanceof Blob ? body : await new Response(body).blob();
      total = blob.size;
      for (let at = 0; at < total; at += 256 * 1024)
        await sendPart(new Uint8Array(await blob.slice(at, at + 256 * 1024).arrayBuffer()), total);
    }
    await this.send(encodeFrame(FRAME.END, id), bulk);
    onProgress?.(total, total);
  }

  openSocket(socket: TunnelWebSocket, target: TunnelTarget, path: string, protocols: string[]) {
    if (this.over) {
      queueMicrotask(() => socket.handleFailure());
      return;
    }
    const stream: MuxStream = {
      window: new SendWindow(),
      onHead: (head) => {
        if (head.status === 101) socket.handleOpen(head.protocol ?? '');
        else socket.handleFailure();
      },
      onMessage: (flags, bytes) => {
        if (socket.takePiece(flags, bytes)) return;
        this.post(encodeFrame(FRAME.RESET, id), false);
        this.streams.delete(id);
        socket.handleFailure();
      },
      onClose: (code, reason) => socket.handleClose(code, reason),
      onFail: () => socket.handleFailure(),
    };
    let id: number;
    try {
      id = this.allocate(false, stream);
    } catch {
      queueMicrotask(() => socket.handleFailure());
      return;
    }
    const cookie = this.jar.header();
    socket.bind({
      sendMessage: async (bytes, binary) => {
        for (let at = 0; at === 0 || at < bytes.length; at += TUNNEL_MAX_CHUNK) {
          const piece = bytes.subarray(at, at + TUNNEL_MAX_CHUNK);
          const framed = encodeMessagePiece(piece, at + TUNNEL_MAX_CHUNK >= bytes.length, binary);
          await stream.window.take(framed.length);
          await this.send(encodeFrame(FRAME.MESSAGE, id, framed), false);
        }
      },
      report: (bytes) => this.post(encodeFrame(FRAME.CREDIT, id, encodeCredit(bytes)), false),
      close: (code, reason) => this.post(encodeJsonFrame(FRAME.CLOSE, id, { code, reason }), false),
    });
    this.post(
      encodeJsonFrame(FRAME.OPEN_WS, id, {
        target,
        path,
        protocols,
        headers: {
          ...(cookie ? { cookie } : {}),
          'user-agent': navigator.userAgent,
        },
      }),
      false,
    );
  }
}

interface SocketLink {
  sendMessage(bytes: Uint8Array<ArrayBuffer>, binary: boolean): Promise<void>;
  report(bytes: number): void;
  close(code: number | undefined, reason: string | undefined): void;
}

export class TunnelWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  binaryType: BinaryType = 'blob';
  protocol = '';
  readonly extensions = '';
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private link: SocketLink | null = null;
  private queue: Promise<void> = Promise.resolve();
  private parts: Uint8Array[] = [];
  private partsLength = 0;
  private unreported = 0;

  constructor(readonly url: string) {
    super();
  }

  bind(link: SocketLink) {
    this.link = link;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState === 0) throw new DOMException('Still connecting', 'InvalidStateError');
    if (this.readyState !== 1 || !this.link) return;
    const link = this.link;
    const task = async () => {
      if (typeof data === 'string') {
        const bytes = encoder.encode(data);
        await link.sendMessage(bytes, false);
        this.bufferedAmount -= bytes.length;
        return;
      }
      const bytes =
        data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : ArrayBuffer.isView(data)
            ? new Uint8Array(
                data.buffer.slice(
                  data.byteOffset,
                  data.byteOffset + data.byteLength,
                ) as ArrayBuffer,
              )
            : new Uint8Array(data as ArrayBuffer);
      await link.sendMessage(bytes, true);
      this.bufferedAmount -= bytes.length;
    };
    this.bufferedAmount +=
      typeof data === 'string'
        ? data.length
        : ((data as Blob).size ?? (data as ArrayBuffer).byteLength);
    this.queue = this.queue.then(task, task).catch(() => undefined);
  }

  close(code?: number, reason?: string) {
    if (this.readyState >= 2) return;
    const wasConnecting = this.readyState === 0;
    this.readyState = 2;
    const link = this.link;
    if (wasConnecting) link?.close(code, reason);
    else void this.queue.then(() => link?.close(code, reason));
  }

  handleOpen(protocol: string) {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.protocol = protocol;
    this.fire(new Event('open'), this.onopen);
  }

  takePiece(flags: number, bytes: Uint8Array): boolean {
    this.partsLength += bytes.length;
    if (this.partsLength > TUNNEL_MAX_WS_MESSAGE) return false;
    this.parts.push(bytes.slice());
    this.unreported += bytes.length + 1;
    if (flags & 1) {
      const whole = new Uint8Array(this.partsLength);
      let at = 0;
      for (const part of this.parts) {
        whole.set(part, at);
        at += part.length;
      }
      this.parts = [];
      this.partsLength = 0;
      if (this.readyState === 1) {
        const data =
          flags & 2
            ? this.binaryType === 'blob'
              ? new Blob([whole])
              : whole.buffer
            : decoder.decode(whole);
        this.fire(new MessageEvent('message', { data }), this.onmessage);
      }
    }
    if (this.unreported >= TUNNEL_CREDIT_STEP) {
      this.link?.report(this.unreported);
      this.unreported = 0;
    }
    return true;
  }

  handleClose(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire(new CloseEvent('close', { code, reason, wasClean: true }), this.onclose);
  }

  handleFailure() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire(new Event('error'), this.onerror);
    this.fire(new CloseEvent('close', { code: 1006, wasClean: false }), this.onclose);
  }

  private fire<E extends Event>(event: E, handler: ((ev: E) => void) | null) {
    handler?.(event);
    this.dispatchEvent(event);
  }
}
