const HEAD_LIMIT_MS = 20_000;
const FILES = /^\/api\/(media|attachments)\//;
const HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
const scopePath = new URL(self.registration.scope).pathname.replace(/\/$/, '');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type === 'hostile-claim') event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname.startsWith(`${scopePath}/`)
    ? url.pathname.slice(scopePath.length)
    : url.pathname;
  if (!FILES.test(path)) return;
  event.respondWith(answer(event, path + url.search));
});

const failed = (status) => new Response(null, { status });

async function pageFor(event) {
  const own = event.clientId ? await self.clients.get(event.clientId) : null;
  if (own) return own;
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all[0] ?? null;
}

async function answer(event, path) {
  const page = await pageFor(event);
  if (!page) return failed(503);
  const headers = {};
  for (const name of HEADERS) {
    const value = event.request.headers.get(name);
    if (value) headers[name] = value;
  }
  const { port1, port2 } = new MessageChannel();
  const first = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), HEAD_LIMIT_MS);
    port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      resolve(data);
    };
  });
  page.postMessage({ type: 'hostile-file', path, method: event.request.method, headers }, [port2]);
  const head = await first;
  if (!head || head.kind !== 'head') return failed(head ? 502 : 504);
  const responseHeaders = new Headers(head.headers);
  responseHeaders.set('Content-Security-Policy', "default-src 'none'; sandbox");
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  if ([101, 204, 205, 304].includes(head.status) || event.request.method === 'HEAD') {
    port1.postMessage('cancel');
    return new Response(null, { status: head.status, headers: responseHeaders });
  }
  const body = new ReadableStream(
    {
      pull: (controller) =>
        new Promise((resolve) => {
          port1.onmessage = ({ data }) => {
            if (data.kind === 'chunk') controller.enqueue(data.value);
            else if (data.kind === 'end') controller.close();
            else controller.error(new Error('The file was cut off.'));
            resolve();
          };
          port1.postMessage('pull');
        }),
      cancel: () => port1.postMessage('cancel'),
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: head.status, headers: responseHeaders });
}
