import { EventEmitter } from 'node:events';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { FRAME, TUNNEL_MAX_CHUNK } from '../packages/shared/src/tunnel';

const BYPASS = 'x-tunnel-bypass';
const BODY_LOOKAHEAD = 64 * 1024;
const SITE = `http://localhost:${process.env.E2E_GUEST_PORT ?? 5291}`;

interface Asked {
  id: number;
  kind: 'http' | 'ws';
  path: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
}
type Answer =
  | { action: 'continue' }
  | { action: 'abort' }
  | { action: 'fulfill'; status: number; headers: [string, string][]; body: string };
type Observed =
  | { kind: 'request'; asked: Asked }
  | { kind: 'head'; id: number; status: number; headers: [string, string][] }
  | { kind: 'finished'; id: number; body: string }
  | { kind: 'failed'; id: number };

function installInPage({
  frameTypes,
  bypass,
  lookahead,
  chunk,
}: {
  frameTypes: typeof FRAME;
  bypass: string;
  lookahead: number;
  chunk: number;
}) {
  const w = window as unknown as {
    __tunnelAsk(asked: Asked): Promise<Answer>;
    __tunnelObserved(event: Observed): void;
    __tunnelOffline: boolean;
    __tunnelIntercept: boolean;
    __tunnelUploadLimit: number;
  };
  w.__tunnelOffline = false;
  w.__tunnelIntercept = false;
  w.__tunnelUploadLimit = -1;
  interface S {
    id: number;
    asked: boolean;
    state: 'asking' | 'pass' | 'drop';
    watching: boolean;
    held: ArrayBuffer[];
    body: Uint8Array[];
    size: number;
    open: { method?: string; path: string; headers?: Record<string, string> };
    kind: 'http' | 'ws';
    capture: Uint8Array[] | null;
    captured: number;
    send(data: ArrayBuffer): void;
    inject(frame: ArrayBuffer): void;
  }
  const streams = new Map<number, S>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const idOf = (b: Uint8Array) => ((b[1]! << 24) | (b[2]! << 16) | (b[3]! << 8) | b[4]!) >>> 0;
  const frame = (type: number, id: number, payload: Uint8Array = new Uint8Array(0)) => {
    const out = new Uint8Array(5 + payload.length);
    out[0] = type;
    out[1] = id >>> 24;
    out[2] = (id >>> 16) & 255;
    out[3] = (id >>> 8) & 255;
    out[4] = id & 255;
    out.set(payload, 5);
    return out.buffer;
  };
  const toBase64 = (parts: Uint8Array[]) => {
    let text = '';
    for (const part of parts) for (const byte of part) text += String.fromCharCode(byte);
    return btoa(text);
  };
  const reset = (s: S, message: string) => {
    s.state = 'drop';
    s.inject(frame(frameTypes.RESET, s.id, encoder.encode(JSON.stringify({ code: 'x', message }))));
  };
  const askedOf = (s: S, complete: boolean): Asked => ({
    id: s.id,
    kind: s.kind,
    path: s.open.path,
    method: s.open.method ?? 'GET',
    headers: s.open.headers ?? {},
    postData: complete && s.body.length ? decoder.decode(concat(s.body)) : null,
  });
  const announce = (s: S, complete: boolean) => {
    s.watching = false;
    w.__tunnelObserved({ kind: 'request', asked: askedOf(s, complete) });
  };
  const ask = (s: S, complete: boolean) => {
    s.asked = true;
    void w.__tunnelAsk(askedOf(s, complete)).then((answer) => {
      if (s.state !== 'asking') return;
      if (answer.action === 'continue') {
        s.state = 'pass';
        for (const held of s.held.splice(0)) s.send(held);
      } else if (answer.action === 'abort') {
        reset(s, 'Failed to fetch');
      } else {
        s.state = 'drop';
        s.inject(
          frame(
            frameTypes.HEAD,
            s.id,
            encoder.encode(JSON.stringify({ status: answer.status, headers: answer.headers })),
          ),
        );
        const bytes = Uint8Array.from(atob(answer.body), (c) => c.charCodeAt(0));
        for (let at = 0; at < bytes.length; at += chunk)
          s.inject(frame(frameTypes.DATA, s.id, bytes.subarray(at, at + chunk)));
        s.inject(frame(frameTypes.END, s.id));
      }
    });
  };
  const concat = (parts: Uint8Array[]) => {
    const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      whole.set(part, at);
      at += part.length;
    }
    return whole;
  };
  (w as unknown as { __tunnelCut(id: number): void }).__tunnelCut = (id) => {
    const s = streams.get(id);
    if (!s) return;
    if (s.state === 'pass') s.send(frame(frameTypes.RESET, id));
    s.state = 'drop';
    s.inject(frame(frameTypes.RESET, id, encoder.encode('{"message":"closed"}')));
  };

  const native = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (
    this: RTCPeerConnection,
    label: string,
    options?: RTCDataChannelInit,
  ) {
    const channel = native.call(this, label, options);
    if (!label.startsWith('hostile-')) return channel;
    const nativeSend = channel.send.bind(channel) as (data: ArrayBuffer) => void;
    const limited: ArrayBuffer[] = [];
    let budget = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastPump = 0;
    const pump = () => {
      timer = null;
      const limit = w.__tunnelUploadLimit;
      const now = performance.now();
      budget = Math.min(budget + (limit * (now - lastPump)) / 1000, Math.max(limit / 4, chunk * 2));
      lastPump = now;
      while (limited.length && (limit < 0 || budget >= limited[0]!.byteLength)) {
        const next = limited.shift()!;
        budget -= next.byteLength;
        if (channel.readyState === 'open') nativeSend(next);
      }
      if (limited.length) timer = setTimeout(pump, 20);
    };
    const send = (data: ArrayBuffer) => {
      if (!label.endsWith('bulk') || (w.__tunnelUploadLimit < 0 && !limited.length))
        return nativeSend(data);
      limited.push(data);
      if (timer === null) {
        lastPump = performance.now();
        timer = setTimeout(pump, 20);
      }
    };
    const inject = (data: ArrayBuffer) =>
      channel.dispatchEvent(new MessageEvent('message', { data }));
    channel.send = ((data: ArrayBuffer | Uint8Array) => {
      const buffer =
        data instanceof ArrayBuffer
          ? data
          : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      const b = new Uint8Array(buffer);
      const type = b[0]!;
      const id = idOf(b);
      if (type === frameTypes.OPEN_HTTP || type === frameTypes.OPEN_WS) {
        const open = JSON.parse(decoder.decode(b.subarray(5))) as S['open'] & { hasBody?: boolean };
        const s: S = {
          id,
          asked: false,
          state: 'asking',
          watching: false,
          held: [buffer],
          body: [],
          size: 0,
          open,
          kind: type === frameTypes.OPEN_WS ? 'ws' : 'http',
          capture: null,
          captured: 0,
          send,
          inject,
        };
        streams.set(id, s);
        if (open.headers?.[bypass]) {
          delete open.headers[bypass];
          s.state = 'pass';
          s.held = [];
          s.asked = true;
          send(frame(type, id, encoder.encode(JSON.stringify(open))));
          return;
        }
        if (w.__tunnelOffline) return reset(s, 'Failed to fetch');
        if (!w.__tunnelIntercept) {
          s.state = 'pass';
          s.held = [];
          send(buffer);
          if (s.kind === 'ws') return;
          if (open.hasBody) s.watching = true;
          else announce(s, true);
          return;
        }
        if (s.kind === 'ws' || !open.hasBody) ask(s, !open.hasBody);
        return;
      }
      const s = streams.get(id);
      if (s?.state === 'drop') return;
      if (s?.watching) {
        if (type === frameTypes.DATA) {
          s.body.push(b.slice(5));
          s.size += b.length - 5;
          if (s.size > lookahead) announce(s, false);
        } else if (type === frameTypes.END) {
          announce(s, true);
        }
      }
      if (s && type === frameTypes.RESET && s.kind === 'http')
        w.__tunnelObserved({ kind: 'failed', id });
      if (s?.state === 'asking') {
        if (type === frameTypes.RESET) {
          s.state = 'drop';
          return;
        }
        s.held.push(buffer);
        if (!s.asked && type === frameTypes.DATA) {
          s.body.push(b.subarray(5));
          s.size += b.length - 5;
          if (s.size > lookahead) ask(s, false);
        }
        if (!s.asked && type === frameTypes.END) ask(s, true);
        return;
      }
      send(buffer);
    }) as typeof channel.send;
    channel.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      const b = new Uint8Array(event.data);
      const id = idOf(b);
      const s = streams.get(id);
      if (!s) return;
      const type = b[0]!;
      if (type === frameTypes.HEAD && s.kind === 'http') {
        const head = JSON.parse(decoder.decode(b.subarray(5))) as {
          status: number;
          headers: [string, string][];
        };
        const contentType = head.headers.find(([n]) => n === 'content-type')?.[1] ?? '';
        if (/json|text/.test(contentType)) s.capture = [];
        w.__tunnelObserved({ kind: 'head', id, status: head.status, headers: head.headers });
      } else if (type === frameTypes.DATA && s.capture && s.captured < 4_000_000) {
        s.capture.push(b.slice(5));
        s.captured += b.length - 5;
      } else if (type === frameTypes.END || type === frameTypes.RESET) {
        if (type === frameTypes.END)
          w.__tunnelObserved({ kind: 'finished', id, body: toBase64(s.capture ?? []) });
        else if (s.kind === 'http') w.__tunnelObserved({ kind: 'failed', id });
        streams.delete(id);
      } else if (type === frameTypes.CLOSE) {
        streams.delete(id);
      }
    });
    return channel;
  } as typeof RTCPeerConnection.prototype.createDataChannel;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const fromSpec = /UtilityScript|eval at evaluate/.test(new Error().stack ?? '');
    if (!fromSpec || url.origin !== location.origin || !url.pathname.startsWith('/api/'))
      return nativeFetch(input as RequestInfo, init);
    return import('/src/tunnel/net.ts' as string).then(({ netFetch }: { netFetch: typeof fetch }) =>
      netFetch(url.pathname + url.search, init),
    );
  }) as typeof fetch;
}

function globToRegExp(glob: string) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else out += '[^/]*';
    } else if (c === '{') out += '(?:';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else out += c.replace(/[.+^$|()[\]\\?]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}
type Matcher = string | RegExp | ((url: URL) => boolean);
const matches = (matcher: Matcher, url: string) =>
  typeof matcher === 'string'
    ? globToRegExp(matcher).test(url)
    : matcher instanceof RegExp
      ? matcher.test(url)
      : matcher(new URL(url));

interface ApiResponse {
  url(): string;
  status(): number;
  ok(): boolean;
  statusText(): string;
  headers(): Record<string, string>;
  headersArray(): { name: string; value: string }[];
  body(): Promise<Buffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  dispose(): Promise<void>;
}

function apiResponse(
  url: string,
  status: number,
  headers: [string, string][],
  body: Buffer,
): ApiResponse {
  return {
    url: () => url,
    status: () => status,
    ok: () => status >= 200 && status < 300,
    statusText: () => '',
    headers: () => Object.fromEntries(headers),
    headersArray: () => headers.map(([name, value]) => ({ name, value })),
    body: async () => body,
    text: async () => body.toString('utf8'),
    json: async () => JSON.parse(body.toString('utf8')) as unknown,
    dispose: async () => undefined,
  };
}

interface RequestOptions {
  data?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  method?: string;
}

async function apiFetch(page: Page, method: string, url: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = { ...options.headers };
  let body: string | null = null;
  let isBinary = false;
  const data = options.data;
  if (Buffer.isBuffer(data)) {
    body = data.toString('base64');
    isBinary = true;
  } else if (typeof data === 'string') {
    body = data;
  } else if (data !== undefined) {
    body = JSON.stringify(data);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
      headers['Content-Type'] = 'application/json';
  }
  const search = options.params
    ? `?${new URLSearchParams(Object.entries(options.params).map(([k, v]) => [k, String(v)]))}`
    : '';
  const result = await page.evaluate(
    async ({ target, method, headers, body, isBinary, bypass }) => {
      const { useTunnel } = await import('/src/tunnel/state.ts' as string);
      const { netFetch } = await import('/src/tunnel/net.ts' as string);
      const started = Date.now();
      while (useTunnel.getState().phase !== 'connected') {
        if (Date.now() - started > 25_000) throw new Error('The tunnel did not connect.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const res: Response = await netFetch(target, {
        method,
        headers: { ...headers, [bypass]: '1' },
        ...(body === null
          ? {}
          : {
              body: isBinary ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : body,
            }),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      let text = '';
      for (let at = 0; at < bytes.length; at += 8192)
        text += String.fromCharCode(...bytes.subarray(at, at + 8192));
      return {
        status: res.status,
        headers: [...res.headers.entries()] as [string, string][],
        body: btoa(text),
      };
    },
    { target: url + search, method, headers, body, isBinary, bypass: BYPASS },
  );
  return apiResponse(
    new URL(url, SITE).href,
    result.status,
    result.headers,
    Buffer.from(result.body, 'base64'),
  );
}

function apiFacade(pageOf: () => Page) {
  const call = (method: string) => (url: string, options?: RequestOptions) =>
    apiFetch(pageOf(), method, url, options);
  return {
    get: call('GET'),
    post: call('POST'),
    put: call('PUT'),
    patch: call('PATCH'),
    delete: call('DELETE'),
    head: call('HEAD'),
    fetch: (url: string, options?: RequestOptions) =>
      apiFetch(pageOf(), options?.method ?? 'GET', url, options),
  };
}

class FakeRequest {
  constructor(
    private readonly asked: Asked,
    readonly response_: Promise<FakeResponse | null>,
  ) {}
  url = () => new URL(this.asked.path, SITE).href;
  method = () => this.asked.method;
  headers = () => this.asked.headers;
  allHeaders = async () => this.asked.headers;
  postData = () => this.asked.postData;
  postDataJSON = () =>
    this.asked.postData === null ? null : (JSON.parse(this.asked.postData) as unknown);
  resourceType = () => 'fetch';
  isNavigationRequest = () => false;
  response = () => this.response_;
  serviceWorker = () => null;
  failure = () => ({ errorText: 'net::ERR_FAILED' });
}

class FakeResponse {
  private settle!: (body: Buffer) => void;
  private readonly body_ = new Promise<Buffer>((resolve) => (this.settle = resolve));
  constructor(
    private readonly request_: FakeRequest,
    private readonly status_: number,
    private readonly headers_: [string, string][],
  ) {}
  finish(body: Buffer) {
    this.settle(body);
  }
  url = () => this.request_.url();
  status = () => this.status_;
  ok = () => this.status_ >= 200 && this.status_ < 300;
  statusText = () => '';
  headers = () => Object.fromEntries(this.headers_);
  allHeaders = async () => Object.fromEntries(this.headers_);
  request = () => this.request_;
  body = () => this.body_;
  text = async () => (await this.body_).toString('utf8');
  json = async () => JSON.parse((await this.body_).toString('utf8')) as unknown;
  finished = async () => {
    await this.body_;
    return null;
  };
}

const TUNNEL_EVENTS = new Set(['request', 'response', 'requestfinished', 'requestfailed']);

type RouteHandler = (route: unknown, request: FakeRequest) => unknown;
interface PageRoute {
  matcher: Matcher;
  handler: RouteHandler;
  times: number;
  held: Set<(answer: Answer | null) => void>;
}
type WsHandler = (ws: unknown) => unknown;

interface PageState {
  routes: PageRoute[];
  wsRoutes: { matcher: Matcher; handler: WsHandler }[];
  events: EventEmitter;
  live: Map<
    number,
    { request: FakeRequest; response?: FakeResponse; done(r: FakeResponse | null): void }
  >;
  sockets: Map<number, () => void>;
  intercepting: boolean;
}
const pageStates = new WeakMap<Page, PageState>();

function stateOf(page: Page) {
  let state = pageStates.get(page);
  if (!state) {
    state = {
      routes: [],
      wsRoutes: [],
      events: new EventEmitter(),
      live: new Map(),
      sockets: new Map(),
      intercepting: false,
    };
    state.events.setMaxListeners(100);
    pageStates.set(page, state);
    patchPage(page, state);
  }
  return state;
}

async function runRoute(
  page: Page,
  entry: PageRoute,
  request: FakeRequest,
): Promise<Answer | null> {
  return new Promise<Answer | null>((resolve) => {
    entry.held.add(resolve);
    const finish = (answer: Answer | null) => {
      entry.held.delete(resolve);
      resolve(answer);
    };
    const fulfill = async (options: {
      status?: number;
      body?: string | Buffer;
      json?: unknown;
      contentType?: string;
      headers?: Record<string, string>;
      response?: ApiResponse;
    }) => {
      const headers: Record<string, string> = {
        ...(options.response ? options.response.headers() : {}),
        ...(options.contentType ? { 'content-type': options.contentType } : {}),
        ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      };
      const lower: [string, string][] = Object.entries(headers).map(([n, v]) => [
        n.toLowerCase(),
        v,
      ]);
      const body =
        options.json !== undefined
          ? Buffer.from(JSON.stringify(options.json))
          : options.body !== undefined
            ? Buffer.from(options.body)
            : options.response
              ? await options.response.body()
              : Buffer.alloc(0);
      finish({
        action: 'fulfill',
        status: options.status ?? options.response?.status() ?? 200,
        headers: lower,
        body: body.toString('base64'),
      });
    };
    const route = {
      request: () => request,
      continue: async () => finish({ action: 'continue' }),
      abort: async () => finish({ action: 'abort' }),
      fallback: async () => finish(null),
      fulfill,
      fetch: (options?: RequestOptions) =>
        apiFetch(page, request.method(), request.url(), {
          ...(request.postData() === null ? {} : { data: request.postData() }),
          headers: request.headers(),
          ...options,
        }),
    };
    void Promise.resolve()
      .then(() => entry.handler(route, request))
      .catch((err: Error) => {
        console.error('[tunnel-mode] route handler failed:', err.message);
        finish({ action: 'continue' });
      });
  });
}

function observeRequest(state: PageState, asked: Asked) {
  let done: (r: FakeResponse | null) => void = () => undefined;
  const responded = new Promise<FakeResponse | null>((resolve) => (done = resolve));
  const request = new FakeRequest(asked, responded);
  state.live.set(asked.id, { request, done });
  state.events.emit('request', request);
  return request;
}

async function answerRequest(page: Page, state: PageState, asked: Asked): Promise<Answer> {
  const request = observeRequest(state, asked);
  const url = request.url();
  for (const entry of [...state.routes].reverse()) {
    if (!matches(entry.matcher, url)) continue;
    if (entry.times-- <= 0) continue;
    const answer = await runRoute(page, entry, request);
    if (answer) return answer;
  }
  return { action: 'continue' };
}

async function answerSocket(page: Page, state: PageState, asked: Asked): Promise<Answer> {
  const url = new URL(asked.path, SITE.replace(/^http/, 'ws')).href;
  const entry = [...state.wsRoutes].reverse().find((r) => matches(r.matcher, url));
  if (!entry) return { action: 'continue' };
  return new Promise<Answer>((resolve) => {
    const onClose: (() => void)[] = [];
    let open = false;
    const closed = () => {
      state.sockets.delete(asked.id);
      for (const listener of onClose.splice(0)) listener();
    };
    state.sockets.set(asked.id, closed);
    const ws = {
      url: () => url,
      connectToServer: () => {
        open = true;
        resolve({ action: 'continue' });
        return ws;
      },
      onClose: (listener: () => void) => onClose.push(listener),
      onMessage: () => undefined,
      send: () => undefined,
      close: async () => {
        if (open) {
          await page
            .evaluate(
              (id) => (window as never as Record<string, (n: number) => void>).__tunnelCut!(id),
              asked.id,
            )
            .catch(() => undefined);
        } else resolve({ action: 'abort' });
        closed();
      },
    };
    void Promise.resolve().then(() => entry.handler(ws));
  });
}

function patchPage(page: Page, state: PageState) {
  const native = {
    route: page.route.bind(page),
    unroute: page.unroute.bind(page),
    unrouteAll: page.unrouteAll.bind(page),
    waitForRequest: page.waitForRequest.bind(page),
    waitForResponse: page.waitForResponse.bind(page),
  };
  Object.defineProperty(page, 'request', {
    value: Object.assign(
      Object.create(page.request) as object,
      apiFacade(() => page),
    ),
  });
  const p = page as unknown as Record<string, unknown>;
  for (const name of ['on', 'addListener', 'once', 'off', 'removeListener'] as const) {
    const nativeListen = (page[name] as (...args: unknown[]) => unknown).bind(page);
    p[name] = (event: string, listener: (...args: unknown[]) => void) => {
      if (TUNNEL_EVENTS.has(event)) state.events[name](event, listener);
      return nativeListen(event, listener);
    };
  }
  const setIntercept = async () => {
    const on = state.routes.length > 0 || state.wsRoutes.length > 0;
    if (on === state.intercepting) return;
    state.intercepting = on;
    const apply = (value: boolean) => {
      (window as unknown as { __tunnelIntercept: boolean }).__tunnelIntercept = value;
    };
    await page.addInitScript(apply, on);
    await page.evaluate(apply, on).catch(() => undefined);
  };
  p.route = async (matcher: Matcher, handler: RouteHandler, options?: { times?: number }) => {
    state.routes.push({
      matcher,
      handler,
      times: options?.times ?? Number.POSITIVE_INFINITY,
      held: new Set(),
    });
    await setIntercept();
    await native.route(matcher as string, handler as never, options);
  };
  p.unroute = async (matcher: Matcher, handler?: RouteHandler) => {
    const gone = state.routes.filter(
      (r) => String(r.matcher) === String(matcher) && (!handler || r.handler === handler),
    );
    state.routes = state.routes.filter((r) => !gone.includes(r));
    if (!state.routes.length)
      for (const r of gone) for (const release of r.held) release({ action: 'continue' });
    await setIntercept();
    await native.unroute(matcher as string, handler as never);
  };
  p.unrouteAll = async (options?: { behavior?: 'wait' | 'ignoreErrors' | 'default' }) => {
    const gone = state.routes;
    state.routes = [];
    for (const r of gone) for (const release of r.held) release({ action: 'continue' });
    await setIntercept();
    await native.unrouteAll(options);
  };
  const waitFor =
    (
      event: 'request' | 'response',
      nativeWait: (m: never, o?: { timeout?: number }) => Promise<unknown>,
    ) =>
    (matcher: string | RegExp | ((r: never) => unknown), options?: { timeout?: number }) =>
      new Promise((resolve, reject) => {
        const timeout = options?.timeout ?? 30_000;
        const off = () => {
          state.events.off(event, on);
          clearTimeout(timer);
        };
        const on = async (seen: { url(): string }) => {
          const ok =
            typeof matcher === 'function'
              ? await (matcher as (r: unknown) => unknown)(seen)
              : matches(matcher, seen.url());
          if (ok) {
            off();
            resolve(seen);
          }
        };
        const timer = timeout
          ? setTimeout(() => {
              off();
              reject(new Error(`Timeout ${timeout}ms exceeded while waiting for a ${event}.`));
            }, timeout)
          : undefined;
        state.events.on(event, on);
        nativeWait(matcher as never, options)
          .then((seen) => {
            off();
            resolve(seen);
          })
          .catch(() => undefined);
      });
  p.waitForRequest = waitFor('request', native.waitForRequest as never);
  p.waitForResponse = waitFor('response', native.waitForResponse as never);
  p.routeWebSocket = async (matcher: Matcher, handler: WsHandler) => {
    state.wsRoutes.push({ matcher, handler });
    await setIntercept();
  };
}

function patchContext(context: BrowserContext) {
  const pageOf = () => {
    const page = context.pages().at(-1);
    if (!page) throw new Error('This context has no page to carry the request.');
    return page;
  };
  Object.defineProperty(context, 'request', {
    value: Object.assign(Object.create(context.request) as object, apiFacade(pageOf)),
  });
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    stateOf(page);
    return page;
  };
  const newCDPSession = context.newCDPSession.bind(context);
  context.newCDPSession = async (target) => {
    const session = await newCDPSession(target);
    const send = session.send.bind(session) as (m: string, p?: unknown) => Promise<unknown>;
    (session as unknown as { send: typeof send }).send = async (method, params) => {
      if (method === 'Network.emulateNetworkConditions') {
        await (target as Page).evaluate(
          (limit) => {
            (window as unknown as { __tunnelUploadLimit: number }).__tunnelUploadLimit = limit;
          },
          (params as { uploadThroughput?: number }).uploadThroughput ?? -1,
        );
      }
      return send(method, params);
    };
    return session;
  };
  const setOffline = context.setOffline.bind(context);
  context.setOffline = async (offline) => {
    await setOffline(offline);
    for (const page of context.pages()) {
      await page
        .evaluate((value) => {
          (window as unknown as { __tunnelOffline: boolean }).__tunnelOffline = value;
        }, offline)
        .catch(() => undefined);
    }
  };
  return Promise.all([
    context.exposeBinding('__tunnelAsk', async ({ page }, asked: Asked) => {
      const state = stateOf(page);
      return asked.kind === 'ws'
        ? answerSocket(page, state, asked)
        : answerRequest(page, state, asked);
    }),
    context.exposeBinding('__tunnelObserved', ({ page }, event: Observed) => {
      const state = stateOf(page);
      if (event.kind === 'request') {
        observeRequest(state, event.asked);
        return;
      }
      const live = state.live.get(event.id);
      if (!live) return;
      if (event.kind === 'head') {
        live.response = new FakeResponse(live.request, event.status, event.headers);
        live.done(live.response);
        state.events.emit('response', live.response);
      } else if (event.kind === 'finished') {
        live.response?.finish(Buffer.from(event.body, 'base64'));
        state.live.delete(event.id);
        state.events.emit('requestfinished', live.request);
      } else {
        live.done(null);
        live.response?.finish(Buffer.alloc(0));
        state.live.delete(event.id);
        state.events.emit('requestfailed', live.request);
      }
    }),
    context.addInitScript(installInPage, {
      frameTypes: FRAME,
      bypass: BYPASS,
      lookahead: BODY_LOOKAHEAD,
      chunk: TUNNEL_MAX_CHUNK,
    }),
  ]);
}

export function installTunnelMode() {
  const type = Object.getPrototypeOf(chromium) as { launch: typeof chromium.launch };
  const launch = type.launch;
  type.launch = async function (this: typeof chromium, ...args) {
    const browser = await launch.apply(this, args);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...contextArgs) => {
      const context = await newContext(...contextArgs);
      await patchContext(context);
      return context;
    };
    return browser;
  };
}
