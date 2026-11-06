import { isApiErrorBody, type ApiErrorBody } from '@hostile/shared';
import { netFetch } from '../tunnel/net';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiErrorBody['error']['issues'];
  readonly retryAfterSec: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: Partial<ApiErrorBody['error']> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = extra.issues;
    this.retryAfterSec = extra.retryAfterSec;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }

  get isTransient(): boolean {
    return (
      this.status === 0 ||
      this.status === 429 ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 504
    );
  }

  static from(status: number, body: unknown): ApiError {
    if (isApiErrorBody(body))
      return new ApiError(status, body.error.code, body.error.message, body.error);
    return new ApiError(
      status,
      status >= 500 ? 'internal_error' : 'unknown',
      `Request failed (${status}).`,
    );
  }
}

export async function requestJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  let res: Response;
  try {
    res = await netFetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const aborted =
      err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ApiError(
      0,
      'network_error',
      aborted ? 'The server did not respond in time.' : 'Cannot reach the server.',
    );
  }
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) throw ApiError.from(res.status, body);
  return body as T;
}
