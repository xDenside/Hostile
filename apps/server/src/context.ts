import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { JoinRequests } from './auth/join-requests.js';
import { SessionService } from './auth/sessions.js';
import { AttachmentStore } from './media/attachments.js';
import { RateLimiter } from './lib/rate-limit.js';
import { NullEmitter, type RealtimeEmitter } from './realtime/emitter.js';
import type { VoiceService } from './media/voice-service.js';

export interface AppContext {
  config: AppConfig;
  db: Db;
  log: Logger;
  sessions: SessionService;
  joinRequests: JoinRequests;
  limiter: RateLimiter;
  realtime: RealtimeEmitter;
  voice: VoiceService;
  attachments: AttachmentStore;
  startedAt: number;
}

export function createBaseContext(
  config: AppConfig,
  db: Db,
  log: Logger,
): Omit<AppContext, 'voice'> {
  return {
    config,
    db,
    log,
    sessions: new SessionService(db),
    joinRequests: new JoinRequests(),
    limiter: new RateLimiter(config.rateLimitDisabled),
    realtime: new NullEmitter(),
    attachments: new AttachmentStore(db, log, config.uploadsDir),
    startedAt: Date.now(),
  };
}
