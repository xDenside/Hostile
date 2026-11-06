import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { AppContext } from '../../src/context.js';
import { startServer } from '../../src/main.js';
import { integrationConfig, type IntegrationConfig } from './provided.js';
import { randomSecret } from './repo-scripts.js';
import { assertTestDataDir, TRUNCATE_ALL_SQL } from './test-database.js';

export const TEST_OWNER_SECRET = 'integration-owner-secret-with-enough-length';

export const TEST_APP_ORIGIN = 'http://localhost:5380';
export const VOICE_TOKEN_TTL_SEC = 300;
export const ACCESS_TOKEN_TTL_SEC = 600;

export interface StartApiOptions {
  rateLimit?: boolean;
  livekit?: boolean;
  env?: Record<string, string>;
}

export interface TestApi {
  ctx: AppContext;
  server: Server;
  port: number;
  baseUrl: string;
  uploadsDir: string;
  livekit: IntegrationConfig['livekit'];
  http(): ReturnType<typeof request>;
  stop(): Promise<void>;
}

export async function startTestApi(options: StartApiOptions = {}): Promise<TestApi> {
  const config = integrationConfig();
  assertTestDataDir(config.dataDir);
  const lk = config.livekit;
  const ownUploadsDir = options.env?.UPLOADS_DIR
    ? null
    : mkdtempSync(join(tmpdir(), 'hostile-uploads-'));
  const uploadsDir = options.env?.UPLOADS_DIR ?? ownUploadsDir!;

  Object.assign(process.env, {
    HOSTILE_ENV: 'test',
    API_HOST: '127.0.0.1',
    PUBLIC_APP_URL: TEST_APP_ORIGIN,
    ALLOWED_ORIGINS: '',
    ALLOW_DESKTOP_ORIGIN: 'true',
    DATA_DIR: config.dataDir,
    SESSION_SECRET: randomSecret(32),
    ACCESS_TOKEN_TTL_SEC: String(ACCESS_TOKEN_TTL_SEC),
    VOICE_TOKEN_TTL_SEC: String(VOICE_TOKEN_TTL_SEC),
    VOICE_RECONCILE_INTERVAL_SEC: '600',
    LOG_LEVEL: process.env.INTEGRATION_VERBOSE ? 'debug' : 'silent',
    LOG_PRETTY: 'false',
    TRUST_PROXY: 'false',
    SERVE_WEB_DIR: '',
    UPLOADS_DIR: uploadsDir,
    RATE_LIMIT_DISABLED: options.rateLimit ? 'false' : 'true',
    OWNER_SECRET: TEST_OWNER_SECRET,
    COMMUNITY_NAME: 'Integration Room',
    LIVEKIT_API_KEY: options.livekit ? lk.apiKey : '',
    LIVEKIT_API_SECRET: options.livekit ? lk.apiSecret : '',
    LIVEKIT_INTERNAL_URL: options.livekit ? lk.internalUrl : '',
    LIVEKIT_PUBLIC_URL: options.livekit ? lk.publicUrl : '',
    ...options.env,
  });

  const started = await startServer({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${started.port}`;
  return {
    ctx: started.ctx,
    server: started.server,
    port: started.port,
    baseUrl,
    uploadsDir,
    livekit: lk,
    http: () => request(baseUrl),
    stop: async () => {
      await started.stop();
      if (ownUploadsDir) rmSync(ownUploadsDir, { recursive: true, force: true });
    },
  };
}

export async function resetDatabase(ctx: AppContext): Promise<void> {
  await ctx.db.$executeRawUnsafe(TRUNCATE_ALL_SQL);
}

export async function waitFor<T>(
  description: string,
  probe: () => T | Promise<T>,
  timeoutMs = 5_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const because = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}${because}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const quietFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
