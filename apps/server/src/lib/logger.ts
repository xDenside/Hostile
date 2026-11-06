import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'secret',
  'ownerSecret',
  'ticket',
  'token',
  'refreshToken',
  'accessToken',
  '*.secret',
  '*.ticket',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
];

export function loggableUrl(url: unknown): string {
  return String(url)
    .split('?')[0]!
    .replace(/^(\/api\/(?:join|join-pictures)\/)[^/]+/, '$1[redacted]');
}

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'logPretty'>): Logger {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(config.logPretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  });
}
