import { join, resolve } from 'node:path';
import { z } from 'zod';
import { BRAND, DESKTOP_ORIGIN, isLoopbackHost } from '@hostile/shared';
import { DEFAULT_DATA_DIR } from './env.js';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const DEFAULT_COMMUNITY_NAME = BRAND.displayName;

const envSchema = z.object({
  HOSTILE_ENV: z.enum(['development', 'test', 'production']),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4191),
  PUBLIC_APP_URL: z.url(),
  ALLOWED_ORIGINS: csv,
  ALLOW_DESKTOP_ORIGIN: bool.default(true),
  DATA_DIR: z.string().default(''),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(600),
  LIVEKIT_API_KEY: z.string().default(''),
  LIVEKIT_API_SECRET: z.string().default(''),
  LIVEKIT_INTERNAL_URL: z.string().default(''),
  LIVEKIT_PUBLIC_URL: z.string().default(''),
  VOICE_TOKEN_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(300),
  VOICE_RECONCILE_INTERVAL_SEC: z.coerce.number().int().min(5).max(600).default(15),
  COMMUNITY_NAME: z.string().trim().min(1).max(64).default(DEFAULT_COMMUNITY_NAME),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),
  TRUST_PROXY: z.string().default('false'),
  SERVE_WEB_DIR: z.string().default(''),
  UPLOADS_DIR: z.string().default(''),
  RATE_LIMIT_DISABLED: bool.default(false),
  JOIN_AUTO_ADMIT: bool.default(false),
  OWNER_SECRET: z.string().default(''),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  env: RawEnv['HOSTILE_ENV'];
  isProduction: boolean;
  hosting: boolean;
  host: string;
  port: number;
  publicAppUrl: string;
  allowedOrigins: string[];
  dataDir: string;
  sessionSecret: string;
  accessTokenTtlSec: number;
  cookie: { name: string; secure: boolean };
  livekit: {
    configured: boolean;
    apiKey: string;
    apiSecret: string;
    internalUrl: string;
    publicUrl: string;
    tokenTtlSec: number;
    reconcileIntervalMs: number;
  };
  communityName: string;
  logLevel: RawEnv['LOG_LEVEL'];
  logPretty: boolean;
  trustProxy: boolean | number | string;
  gatewayToken: string | null;
  ownerSecret: string | null;
  joinAutoAdmit: boolean;
  serveWebDir: string;
  uploadsDir: string;
  rateLimitDisabled: boolean;
}

const KNOWN_DEV_VALUES = ['devkey', 'secret', 'change-me', 'changeme', 'dev-only', 'development'];

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function parseTrustProxy(v: string): boolean | number | string {
  if (v === 'false' || v === '') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export interface LoadConfigOptions {
  hosting?: boolean;
  gatewayToken?: string;
  ownerSecret?: string;
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const hosting = options.hosting === true;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const problems: string[] = [];
  const isProduction = e.HOSTILE_ENV === 'production';
  const publicAppOrigin = new URL(e.PUBLIC_APP_URL).origin;

  const livekitConfigured = Boolean(
    e.LIVEKIT_API_KEY && e.LIVEKIT_API_SECRET && e.LIVEKIT_INTERNAL_URL && e.LIVEKIT_PUBLIC_URL,
  );
  if (e.LIVEKIT_PUBLIC_URL && !/^wss?:\/\//.test(e.LIVEKIT_PUBLIC_URL)) {
    problems.push('LIVEKIT_PUBLIC_URL must start with ws:// or wss://');
  }
  if (/[\s;,'"]/.test(e.LIVEKIT_PUBLIC_URL)) {
    problems.push('LIVEKIT_PUBLIC_URL must not contain whitespace, ";", "," or quotes');
  }
  if (e.LIVEKIT_INTERNAL_URL && !/^(https?|wss?):\/\//.test(e.LIVEKIT_INTERNAL_URL)) {
    problems.push('LIVEKIT_INTERNAL_URL must start with http(s):// or ws(s)://');
  }
  if (e.LIVEKIT_API_SECRET && e.LIVEKIT_API_SECRET.length < 32) {
    problems.push('LIVEKIT_API_SECRET must be at least 32 characters');
  }

  const allowedOrigins = new Set<string>([publicAppOrigin]);
  for (const o of e.ALLOWED_ORIGINS) {
    try {
      const origin = o === DESKTOP_ORIGIN ? o : new URL(o).origin;
      allowedOrigins.add(origin);
    } catch {
      problems.push(`ALLOWED_ORIGINS entry is not a valid origin: ${o}`);
    }
  }
  if (e.ALLOW_DESKTOP_ORIGIN) allowedOrigins.add(DESKTOP_ORIGIN);

  if (hosting) {
    if (!isProduction) problems.push('A hosted room runs with HOSTILE_ENV=production');
    if (!isLoopbackHost(e.API_HOST)) problems.push('A hosted room listens on loopback only');
    const loopback = (url: string) => {
      const host = hostOf(url.replace(/^ws/, 'http'));
      return host !== null && isLoopbackHost(host);
    };
    if (!loopback(e.PUBLIC_APP_URL))
      problems.push('PUBLIC_APP_URL must be on loopback when hosting');
    if (!loopback(e.LIVEKIT_PUBLIC_URL) || !loopback(e.LIVEKIT_INTERNAL_URL))
      problems.push('LiveKit must be on loopback when hosting');
    if (e.TRUST_PROXY !== 'loopback') problems.push('TRUST_PROXY must be loopback when hosting');
    if (!options.gatewayToken || options.gatewayToken.length < 32)
      problems.push('A hosted room needs a gateway token of at least 32 characters');
    if (!options.ownerSecret || options.ownerSecret.length < 32)
      problems.push('A hosted room needs an owner secret of at least 32 characters');
  }

  if (isProduction) {
    if (!e.DATA_DIR) problems.push('DATA_DIR must be set in production');
    if (!livekitConfigured)
      problems.push('LiveKit must be fully configured in production (LIVEKIT_* variables)');
    if (!hosting)
      problems.push(
        'HOSTILE_ENV=production only runs inside the host app: a server of its own has no room code, so nothing would keep anyone out',
      );
    for (const [name, value] of [
      ['SESSION_SECRET', e.SESSION_SECRET],
      ['LIVEKIT_API_KEY', e.LIVEKIT_API_KEY],
      ['LIVEKIT_API_SECRET', e.LIVEKIT_API_SECRET],
    ] as const) {
      const lower = value.toLowerCase();
      if (
        KNOWN_DEV_VALUES.some(
          (d) => lower === d || lower.includes('change-me') || lower.includes('dev-only'),
        )
      ) {
        problems.push(`${name} still has a development/placeholder value`);
      }
    }
    if (e.RATE_LIMIT_DISABLED) problems.push('RATE_LIMIT_DISABLED is not allowed in production');
    if (e.JOIN_AUTO_ADMIT) problems.push('JOIN_AUTO_ADMIT is not allowed in production');
    if (e.OWNER_SECRET) problems.push('OWNER_SECRET is not allowed in production');
    for (const o of allowedOrigins) {
      const allowedWhenHosting = hosting && hostOf(o) !== null && isLoopbackHost(hostOf(o)!);
      if (o.startsWith('http://') && !allowedWhenHosting)
        problems.push(`Allowed origin ${o} is not https in production`);
    }
  } else if (!isLoopbackHost(e.API_HOST)) {
    problems.push(
      `API_HOST=${e.API_HOST} is not a loopback address. Development and test stay on loopback.`,
    );
  }

  if (problems.length) throw new ConfigError(problems);

  const dataDir = resolve(e.DATA_DIR || DEFAULT_DATA_DIR);

  return {
    env: e.HOSTILE_ENV,
    isProduction,
    hosting,
    host: e.API_HOST,
    port: e.API_PORT,
    publicAppUrl: publicAppOrigin,
    allowedOrigins: [...allowedOrigins],
    dataDir,
    sessionSecret: e.SESSION_SECRET,
    accessTokenTtlSec: e.ACCESS_TOKEN_TTL_SEC,
    cookie: {
      name: isProduction ? `__Host-${BRAND.slug}_session` : `${BRAND.slug}_session`,
      secure: isProduction,
    },
    livekit: {
      configured: livekitConfigured,
      apiKey: e.LIVEKIT_API_KEY,
      apiSecret: e.LIVEKIT_API_SECRET,
      internalUrl: e.LIVEKIT_INTERNAL_URL.replace(/^ws/, 'http'),
      publicUrl: e.LIVEKIT_PUBLIC_URL,
      tokenTtlSec: e.VOICE_TOKEN_TTL_SEC,
      reconcileIntervalMs: e.VOICE_RECONCILE_INTERVAL_SEC * 1000,
    },
    communityName: e.COMMUNITY_NAME,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    gatewayToken: options.gatewayToken ?? null,
    ownerSecret: options.ownerSecret ?? (e.OWNER_SECRET || null),
    joinAutoAdmit: e.JOIN_AUTO_ADMIT,
    serveWebDir: e.SERVE_WEB_DIR,
    uploadsDir: resolve(e.UPLOADS_DIR || join(dataDir, 'uploads')),
    rateLimitDisabled: e.RATE_LIMIT_DISABLED,
  };
}
