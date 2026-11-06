import { createFirstOwner, FirstOwnerError } from '../auth/first-owner.js';
import { loadConfig } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { startServer } from '../main.js';
import { parentPort } from './parent-port.js';

const port = parentPort();
let running: Awaited<ReturnType<typeof startServer>> | null = null;

interface Secrets {
  sessionSecret: string;
  livekitKey: string;
  livekitSecret: string;
  gatewayToken: string;
  ownerSecret: string;
}

type Incoming =
  | { type: 'start'; env: NodeJS.ProcessEnv; secrets: Secrets }
  | {
      type: 'create-owner';
      id: number;
      displayName: string;
      avatar?: Uint8Array;
      banner?: Uint8Array;
    }
  | { type: 'stop' };

async function start(env: NodeJS.ProcessEnv, secrets: Secrets) {
  try {
    const settings = {
      ...env,
      SESSION_SECRET: secrets.sessionSecret,
      LIVEKIT_API_KEY: secrets.livekitKey,
      LIVEKIT_API_SECRET: secrets.livekitSecret,
    };
    running = await startServer({
      config: loadConfig(settings, {
        hosting: true,
        gatewayToken: secrets.gatewayToken,
        ownerSecret: secrets.ownerSecret,
      }),
    });
    const { joinRequests } = running.ctx;
    joinRequests.events.on('asked', ({ nickname }) =>
      port.postMessage({ type: 'join-request', nickname, waiting: joinRequests.list().length }),
    );
    const hasOwner = Boolean(
      await running.ctx.db.user.findFirst({ where: { role: 'OWNER' }, select: { id: true } }),
    );
    port.postMessage({ type: 'ready', hasOwner });
  } catch (err) {
    port.postMessage({ type: 'failed', message: (err as Error).message });
    process.exit(1);
  }
}

async function createOwner(message: Extract<Incoming, { type: 'create-owner' }>) {
  try {
    await createFirstOwner(running!.ctx.db, running!.ctx.log, {
      displayName: message.displayName,
      ...(message.avatar ? { avatar: message.avatar } : {}),
      ...(message.banner ? { banner: message.banner } : {}),
      withDefaultChannels: true,
    });
    port.postMessage({ type: 'owner', id: message.id, ok: true });
  } catch (err) {
    const words =
      err instanceof FirstOwnerError || err instanceof HttpError
        ? err.message
        : 'The owner could not be created.';
    port.postMessage({ type: 'owner', id: message.id, ok: false, error: words });
  }
}

port.on('message', ({ data }) => {
  const message = data as Incoming;
  if (message.type === 'start') void start(message.env, message.secrets);
  else if (message.type === 'create-owner') void createOwner(message);
  else if (message.type === 'stop') {
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    void (running?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  }
});
