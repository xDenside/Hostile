import express, { type Express } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pinoHttp } from 'pino-http';
import { LIMITS } from '@hostile/shared';
import { loggableUrl } from '../lib/logger.js';
import type { AppContext } from '../context.js';
import { errors } from '../lib/errors.js';
import { addressFromGatewayOnly } from './gateway-address.js';
import { authenticate, cors, csrfProtection, errorHandler, originGuard } from './middleware.js';
import { adminRoutes } from './routes/admin.js';
import { precompressedFiles } from './precompressed.js';
import { attachmentFileRoutes } from './routes/attachments.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chat.js';
import { deviceRoutes } from './routes/device.js';
import { joinPictureRoutes, joinRoutes } from './routes/join.js';
import { mediaRoutes } from './routes/media.js';
import { metaRoutes } from './routes/meta.js';
import { livekitWebhookRoute, voiceRoutes } from './routes/voice.js';

export function webCsp(ctx: AppContext): string {
  const livekit = ctx.config.livekit.publicUrl;
  const livekitHttp = livekit.replace(/^ws/, 'http');
  const connect = ["'self'", livekit, livekitHttp].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

const FILE_UPLOAD_PATHS = [
  /^\/auth\/profile\/media\/[^/]+\/?$/i,
  /^\/channels\/[^/]+\/attachments\/?$/i,
  /^\/join\/[^/]+\/picture\/?$/i,
];

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.trustProxy);
  if (ctx.config.gatewayToken) app.use(addressFromGatewayOnly(ctx.config.gatewayToken));

  app.use(
    pinoHttp({
      logger: ctx.log,
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug',
      serializers: {
        req: (req) => ({ method: req.method, url: loggableUrl(req.url) }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );

  app.use('/api/livekit', livekitWebhookRoute(ctx));

  app.use('/api/media', mediaRoutes(ctx));
  app.use('/api/join-pictures', joinPictureRoutes(ctx));
  const attachmentFiles = attachmentFileRoutes(ctx);
  app.use('/api/attachments', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return attachmentFiles(req, res, next);
    next();
  });

  app.use('/api', cors(ctx));
  const parseJson = express.json({ limit: LIMITS.jsonBodyBytes });
  app.use('/api', (req, res, next) => {
    if (FILE_UPLOAD_PATHS.some((path) => path.test(req.path))) return next();
    parseJson(req, res, next);
  });
  app.use('/api', originGuard(ctx));
  app.use('/api', authenticate(ctx));
  app.use('/api', csrfProtection(ctx));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', metaRoutes(ctx));
  app.use('/api/auth/device', deviceRoutes(ctx));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/join', joinRoutes(ctx));
  app.use('/api', chatRoutes(ctx));
  app.use('/api/voice', voiceRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api', (_req, _res, next) => next(errors.notFound('Endpoint')));

  if (ctx.config.serveWebDir) {
    const dir = resolve(ctx.config.serveWebDir);
    const index = join(dir, 'index.html');
    if (!existsSync(index)) throw new Error(`SERVE_WEB_DIR has no index.html: ${dir}`);
    const csp = webCsp(ctx);
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', csp);
      next();
    });
    app.use(precompressedFiles(dir));
    app.use(
      express.static(dir, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, path) => {
          if (/\/assets\//.test(path))
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(index);
    });
  }

  app.use(errorHandler(ctx));
  return app;
}
