import { netFetch, siteBase } from './net';
import { useTunnel } from './state';

const CLAIM_MS = 5_000;
const READY_MS = 10_000;

interface FileRequest {
  type: 'hostile-file';
  path: string;
  method: string;
  headers: Record<string, string>;
}

let listening = false;
let installed: Promise<void> | null = null;

function listen(container: ServiceWorkerContainer) {
  if (listening) return;
  listening = true;
  container.addEventListener('message', (event: MessageEvent<FileRequest>) => {
    if (event.data?.type === 'hostile-file' && event.ports[0])
      void serve(event.data, event.ports[0]);
  });
  container.addEventListener('controllerchange', () => {
    if (container.controller) useTunnel.setState({ filesBlocked: false });
  });
}

function waitFor<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function install(container: ServiceWorkerContainer): Promise<void> {
  listen(container);
  const registered = await waitFor(
    container.register(`${siteBase()}/tunnel-sw.js`, { scope: `${siteBase()}/` }),
    READY_MS,
  );
  if (!registered) throw new Error('the file worker did not register in time');
  const registration = await waitFor(container.ready, READY_MS);
  if (!registration || container.controller) return;
  const stop = new AbortController();
  const claimed = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, CLAIM_MS);
    container.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true, signal: stop.signal },
    );
  });
  registration.active?.postMessage({ type: 'hostile-claim' });
  await claimed;
  stop.abort();
}

export async function registerFileWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    useTunnel.setState({ filesBlocked: true });
    return;
  }
  const container = navigator.serviceWorker;
  try {
    installed ??= install(container);
    await installed;
  } catch {
    installed = null;
  }
  useTunnel.setState({ filesBlocked: !container.controller });
}

async function serve(request: FileRequest, port: MessagePort) {
  try {
    const response = await netFetch(request.path, {
      method: request.method,
      headers: request.headers,
      bulk: true,
    });
    port.postMessage({
      kind: 'head',
      status: response.status,
      headers: [...response.headers.entries()],
    });
    const reader = response.body?.getReader();
    if (!reader) {
      port.postMessage({ kind: 'end' });
      return;
    }
    port.onmessage = (event: MessageEvent<string>) => {
      if (event.data === 'cancel') {
        void reader.cancel();
        return;
      }
      reader.read().then(
        ({ done, value }) => {
          if (done) port.postMessage({ kind: 'end' });
          else port.postMessage({ kind: 'chunk', value }, [value.buffer]);
        },
        () => port.postMessage({ kind: 'error' }),
      );
    };
  } catch {
    port.postMessage({ kind: 'error' });
  }
}
