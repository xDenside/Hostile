import { ErrorCode, MESSAGE_EMPTY_ERROR, type ApiErrorBody } from '@hostile/shared';
import type { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly extra: Partial<ApiErrorBody['error']> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

export const errors = {
  validation: (zodError: ZodError) =>
    new HttpError(400, ErrorCode.Validation, 'Some fields are invalid.', {
      issues: zodError.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }),
  unauthenticated: (message = 'This device is not part of the room.') =>
    new HttpError(401, ErrorCode.Unauthenticated, message),
  sessionExpired: () =>
    new HttpError(401, ErrorCode.SessionExpired, 'This device is no longer part of the room.'),
  accountDisabled: () =>
    new HttpError(403, ErrorCode.AccountDisabled, 'The host has removed you from this room.'),
  forbidden: (message = 'You do not have permission to do that.') =>
    new HttpError(403, ErrorCode.Forbidden, message),
  notFound: (what = 'Resource') => new HttpError(404, ErrorCode.NotFound, `${what} not found.`),
  conflict: (message: string) => new HttpError(409, ErrorCode.Conflict, message),
  csrf: () => new HttpError(403, ErrorCode.Csrf, 'Missing or invalid CSRF token. Reload the page.'),
  origin: () => new HttpError(403, ErrorCode.OriginNotAllowed, 'Request origin is not allowed.'),
  joinQueueFull: () =>
    new HttpError(429, ErrorCode.JoinQueueFull, 'Too many people are waiting. Try again shortly.', {
      retryAfterSec: 15,
    }),
  joinClosed: () =>
    new HttpError(
      403,
      ErrorCode.JoinClosed,
      'This room is not taking new people right now. Ask the host if you should be let in.',
    ),
  payloadTooLarge: (message: string) => new HttpError(413, ErrorCode.PayloadTooLarge, message),
  invalidImage: (status: 400 | 415, message: string) =>
    new HttpError(status, ErrorCode.Validation, message),
  invalidAttachment: (status: 400 | 415, message: string) =>
    new HttpError(status, ErrorCode.Validation, message),
  emptyMessage: () =>
    new HttpError(400, ErrorCode.Validation, 'Some fields are invalid.', {
      issues: [{ path: 'content', message: MESSAGE_EMPTY_ERROR }],
    }),
  attachmentsNotClaimable: () =>
    new HttpError(400, ErrorCode.AttachmentsNotClaimable, 'Some fields are invalid.', {
      issues: [
        {
          path: 'attachmentIds',
          message:
            'One of those attachments cannot go on this message. It has to be your own upload to this channel, not already on a message. Upload it again.',
        },
      ],
    }),
  replyTargetInvalid: () =>
    new HttpError(400, ErrorCode.Validation, 'Some fields are invalid.', {
      issues: [
        {
          path: 'replyToId',
          message: 'The message you are replying to is not in this channel.',
        },
      ],
    }),
  forwardSameChannel: () =>
    new HttpError(400, ErrorCode.Validation, 'Some fields are invalid.', {
      issues: [{ path: 'channelId', message: 'It is already in this channel. Choose another.' }],
    }),
  uploadsUnavailable: () =>
    new HttpError(
      503,
      ErrorCode.UploadsUnavailable,
      'The server cannot store files right now. Tell the owner.',
    ),
  diskFull: () =>
    new HttpError(
      507,
      ErrorCode.UploadsUnavailable,
      'The server is almost out of disk space, so it cannot take this file. Tell the owner.',
    ),
  uploadTooSlow: () =>
    new HttpError(
      408,
      ErrorCode.Validation,
      'That upload took too long. Try again on a faster connection.',
    ),
  mediaUnavailable: (message = 'Voice is not available right now.') =>
    new HttpError(503, ErrorCode.MediaUnavailable, message),
  rateLimited: (retryAfterSec: number) =>
    new HttpError(429, ErrorCode.RateLimited, 'Too many attempts. Try again shortly.', {
      retryAfterSec,
    }),
};
