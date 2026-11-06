import { netFetch, siteBase } from './net';

const CLAIM_MS = 5_000;

interface FileRequest {
  type: 'hostile-file';
  path: string;
  method: string;
  headers: Record<string, string>;
}

let installed: Promise<void> | null = null;

export function registerFileWorker(): Promise<void> {
  installed ??= (async () => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent<FileRequest>) => {
      if (event.data?.type === 'hostile-file' && event.ports[0])
        void serve(event.data, event.ports[0]);
    });
    await navigator.serviceWorker.register(`${siteBase()}/tunnel-sw.js`, {
      scope: `${siteBase()}/`,
    });
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLAIM_MS);
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  })();
  return installed;
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
