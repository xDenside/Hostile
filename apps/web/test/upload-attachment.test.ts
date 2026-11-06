import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/http';

const recover = vi.hoisted(() => vi.fn());

vi.mock('../src/platform', () => ({
  platform: () => ({
    kind: 'web',
    apiBase: () => 'https://chat.example',
    authHeaders: () => ({ 'X-CSRF-Token': 'token' }),
    recoverFromUnauthorized: recover,
  }),
}));

const { UPLOAD_CUT_OFF, UPLOAD_STALLED, UploadCanceled, uploadAttachment } =
  await import('../src/api/client');

class FakeXhr {
  static all: FakeXhr[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = '';
  aborted = false;
  upload: { onprogress?: (e: Partial<ProgressEvent>) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;

  constructor() {
    FakeXhr.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

const file = new Blob(['bytes'], { type: 'image/png' });
const attachment = { id: 'a1', url: '/api/attachments/a1' };

beforeEach(() => {
  FakeXhr.all = [];
  recover.mockReset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('uploading one file', () => {
  it('sends the raw file with the credentials, the name and the measured size', async () => {
    const upload = uploadAttachment(
      'chan/1',
      file,
      { name: 'my photo #1.png', width: 640.4, height: 360 },
      () => undefined,
    );
    const xhr = FakeXhr.all[0]!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(
      'https://chat.example/api/channels/chan%2F1/attachments?name=my%20photo%20%231.png&width=640&height=360',
    );
    expect(xhr.headers).toEqual({ 'Content-Type': 'image/png', 'X-CSRF-Token': 'token' });
    expect(xhr.body).toBe(file);
    xhr.answer(201, { attachment });
    await expect(upload.promise).resolves.toEqual(attachment);
  });

  it('leaves out what it does not know', () => {
    uploadAttachment('c', new Blob(['x']), { width: null, height: null }, () => undefined);
    const xhr = FakeXhr.all[0]!;
    expect(xhr.url).toBe('https://chat.example/api/channels/c/attachments');
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('reports whole percents of what has gone out', () => {
    const seen: number[] = [];
    uploadAttachment('c', file, {}, (p) => seen.push(p));
    const send = FakeXhr.all[0]!.upload.onprogress!;
    send({ lengthComputable: true, loaded: 1, total: 3 });
    send({ lengthComputable: false, loaded: 2, total: 0 });
    send({ lengthComputable: true, loaded: 3, total: 3 });
    expect(seen).toEqual([33, 100]);
  });

  it('passes on the server refusal with its own words and code', async () => {
    const upload = uploadAttachment('c', file, {}, () => undefined);
    FakeXhr.all[0]!.answer(413, {
      error: { code: 'payload_too_large', message: 'That video is too large.' },
    });
    const err = await upload.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 413,
      code: 'payload_too_large',
      message: 'That video is too large.',
    });
  });

  it('copes with an answer that is not JSON, such as a proxy error page', async () => {
    const upload = uploadAttachment('c', file, {}, () => undefined);
    FakeXhr.all[0]!.answer(502, '<html>Bad gateway</html>');
    await expect(upload.promise).rejects.toMatchObject({ status: 502 });
  });

  it('says a lost connection in its own words', async () => {
    const upload = uploadAttachment('c', file, {}, () => undefined);
    FakeXhr.all[0]!.onerror!();
    await expect(upload.promise).rejects.toMatchObject({ status: 0, message: UPLOAD_CUT_OFF });
  });

  it('tells a cancel apart from a failure', async () => {
    const upload = uploadAttachment('c', file, {}, () => undefined);
    upload.abort();
    expect(FakeXhr.all[0]!.aborted).toBe(true);
    await expect(upload.promise).rejects.toBeInstanceOf(UploadCanceled);
  });

  it('gives up on a stall, and only on a stall', async () => {
    vi.useFakeTimers();
    const upload = uploadAttachment('c', file, {}, () => undefined);
    const xhr = FakeXhr.all[0]!;
    const rejected = expect(upload.promise).rejects.toMatchObject({
      status: 0,
      message: UPLOAD_STALLED,
    });
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100_000);
      xhr.upload.onprogress!({ lengthComputable: true, loaded: i, total: 100 });
    }
    expect(xhr.aborted).toBe(false);
    vi.advanceTimersByTime(150_000);
    expect(xhr.aborted).toBe(true);
    await rejected;
  });

  it('gets the same one chance to refresh credentials as any other request', async () => {
    recover.mockResolvedValue(true);
    const upload = uploadAttachment('c', file, {}, () => undefined);
    FakeXhr.all[0]!.answer(401, { error: { code: 'unauthorized', message: 'Sign in.' } });
    await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    FakeXhr.all[1]!.answer(201, { attachment });
    await expect(upload.promise).resolves.toEqual(attachment);
  });

  it('does not try again when the credentials could not be refreshed', async () => {
    recover.mockResolvedValue(false);
    const upload = uploadAttachment('c', file, {}, () => undefined);
    FakeXhr.all[0]!.answer(401, { error: { code: 'unauthorized', message: 'Sign in.' } });
    await expect(upload.promise).rejects.toMatchObject({ status: 401 });
    expect(FakeXhr.all).toHaveLength(1);
  });
});
