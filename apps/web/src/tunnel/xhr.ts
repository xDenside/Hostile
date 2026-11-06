import type { TunnelFetchInit } from './mux';
import { netFetch } from './net';

export class TunnelXhr {
  status = 0;
  responseText = '';
  readonly upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private method = 'GET';
  private url = '';
  private readonly headers: Record<string, string> = {};
  private readonly controller = new AbortController();
  private done = false;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: Blob) {
    const init: RequestInit & TunnelFetchInit = {
      method: this.method,
      headers: this.headers,
      body,
      signal: this.controller.signal,
      bulk: true,
      onUploadProgress: (loaded, total) =>
        this.upload.onprogress?.(
          new ProgressEvent('progress', { lengthComputable: true, loaded, total }),
        ),
    };
    netFetch(this.url, init)
      .then(async (res) => {
        this.status = res.status;
        this.responseText = await res.text();
        this.finish(this.onload);
      })
      .catch(() => {
        if (!this.controller.signal.aborted) this.finish(this.onerror);
      });
  }

  abort() {
    if (this.done) return;
    this.controller.abort(new DOMException('Canceled', 'AbortError'));
    this.finish(this.onabort);
  }

  private finish(handler: (() => void) | null) {
    if (this.done) return;
    this.done = true;
    handler?.();
  }
}
