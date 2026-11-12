export const ErrorCode = {
  Validation: 'validation_error',
  Unauthenticated: 'unauthenticated',
  SessionExpired: 'session_expired',
  AccountDisabled: 'account_disabled',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Conflict: 'conflict',
  RateLimited: 'rate_limited',
  Csrf: 'csrf_failed',
  OriginNotAllowed: 'origin_not_allowed',
  JoinQueueFull: 'join_queue_full',
  JoinClosed: 'join_closed',
  PayloadTooLarge: 'payload_too_large',
  MediaUnavailable: 'media_unavailable',
  UploadsUnavailable: 'uploads_unavailable',
  AttachmentsNotClaimable: 'attachments_not_claimable',
  Internal: 'internal_error',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    issues?: { path: string; message: string }[];
    retryAfterSec?: number;
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') return false;
  const err = (value as { error?: unknown }).error;
  return !!err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string';
}
