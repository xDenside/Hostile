import { net } from 'electron';
import { ErrorCode, isApiErrorBody, type ApiErrorBody } from '@hostile/shared';

export interface ApiFailure {
  status: number;
  error: ApiErrorBody['error'];
}

export type ApiResult<T> = { ok: true; value: T } | ({ ok: false } & ApiFailure);

const DEFAULT_TIMEOUT_MS = 15_000;

export async function apiRequest<T>(
  serverUrl: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = { method: 'GET' },
): Promise<ApiResult<T>> {
  let url: string;
  try {
    url = new URL(path, serverUrl).toString();
  } catch {
    return failure(0, `"${serverUrl}" is not a usable server address.`);
  }

  let response: Response;
  try {
    response = await net.fetch(url, {
      method: init.method,
      credentials: 'omit',
      cache: 'no-store',
      ...(init.body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return failure(
      0,
      timedOut
        ? 'The server did not respond in time.'
        : `Cannot reach the server at ${originOf(serverUrl)}.`,
    );
  }

  const text = await response.text().catch(() => '');
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    if (isApiErrorBody(body)) return { ok: false, status: response.status, error: body.error };
    return {
      ok: false,
      status: response.status,
      error: {
        code: response.status >= 500 ? ErrorCode.Internal : ErrorCode.Validation,
        message: `The server rejected the request (${response.status}).`,
      },
    };
  }
  return { ok: true, value: body as T };
}

function failure(status: number, message: string): ApiResult<never> {
  return { ok: false, status, error: { code: ErrorCode.Internal, message } };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
