import { createServer } from 'node:http';
import { loadLocalEnv } from './env.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { createBaseContext, type AppContext } from './context.js';
import { openDatabase } from './db.js';
import { createApp } from './http/app.js';
import { enforceRequestDeadlines } from './http/request-deadline.js';
import { createLogger } from './lib/logger.js';
import { VoiceService } from './media/voice-service.js';
import { RealtimeHub } from './realtime/hub.js';

export async function startServer(
  options: { port?: number; host?: string; config?: AppConfig } = {},
) {
  const config = options.config ?? loadConfig();
  const log = createLogger(config);
  const database = await openDatabase(config.dataDir);
  const { db } = database;
  if (database.applied.length) log.info({ applied: database.applied }, 'database migrated');
  const base = createBaseContext(config, db, log);
  const ctx = base as AppContext;
  ctx.voice = new VoiceService(config, db, log, () => ctx.realtime);

  const app = createApp(ctx);
  const server = createServer(app);
  const hub = new RealtimeHub(ctx, server);
  ctx.realtime = hub;
  ctx.joinRequests.events.on('changed', () =>
    ctx.realtime.toOwner('join:requests', { requests: ctx.joinRequests.list() }),
  );
  ctx.joinRequests.start();
  enforceRequestDeadlines(server);

  const port = options.port ?? config.port;
  const host = options.host ?? config.host;
  try {
    await ctx.attachments.start();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
  } catch (err) {
    await database.close();
    throw err;
  }
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  ctx.voice.start();
  log.info(
    {
      host,
      port: actualPort,
      env: config.env,
      livekit: config.livekit.configured ? config.livekit.publicUrl : 'not configured',
    },
    'Hostile API listening',
  );

  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      log.info('shutting down');
      ctx.joinRequests.stop();
      ctx.voice.stop();
      ctx.attachments.stop();
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ctx.limiter.close();
      await database.close();
    })());

  return { ctx, server, port: actualPort, stop };
}

const hostedByTheApp = 'parentPort' in process;
const isEntry =
  !hostedByTheApp &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('main.ts') ||
    process.argv[1]?.endsWith('main.js'));

if (isEntry) {
  loadLocalEnv();
  startServer()
    .then(({ stop, ctx }) => {
      const shutdown = (signal: string) => {
        ctx.log.info({ signal }, 'received signal');
        const timer = setTimeout(() => process.exit(1), 10_000);
        timer.unref();
        stop()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((err) => {
      if (err instanceof ConfigError) {
        console.error(`\n${err.message}\n\nFix the environment (see docs/SETUP.md) and restart.\n`);
      } else {
        console.error(err);
      }
      process.exit(1);
    });
}
