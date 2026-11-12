import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { powerSaveBlocker, utilityProcess, type UtilityProcess } from 'electron';
import type { HostingPart, HostingStatus, HostOwnerProfile } from '@hostile/shared';
import { log, messageOf } from '../log.js';
import { bridgeSession, installBridgePermissions, openBridgeWindow } from './bridge-window.js';
import { findLivekitProgram, reapLeftoverLivekit, startLivekit } from './livekit-process.js';
import type { LivekitProcess } from './livekit-process.js';
import { freeLoopbackPort, freeUdpPort, udpPortIsFree } from './ports.js';
import type { Asking } from './notify.js';
import { createHostSecretStore, type HostSecretStore } from './secrets.js';
import { HOST_TRUST_PROXY, hostServerEnv, type HostPorts } from './server-env.js';

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 5 * 60_000;
const RESTART_DELAY_MS = 1_000;
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 12_000;
const MEDIA_SLOW_MS = 20_000;
const MEDIA_GIVE_UP_MS = 90_000;

export interface HostService {
  prepare(): Promise<HostPorts>;
  start(): Promise<void>;
  createOwner(input: HostOwnerProfile): Promise<{ ok: true } | { ok: false; error: string }>;
  hasOwner(): boolean;
  ownerSecret(): string | null;
  status(): HostingStatus;
  newCode(): Promise<string>;
  stop(): Promise<void>;
  running(): boolean;
  portsNow(): HostPorts | null;
  pids(): { server?: number; gateway?: number; livekit?: number; bridge?: number };
}

type PartName = 'server' | 'gateway' | 'media' | 'bridge';

interface Restarts {
  at: number[];
  total: number;
}

const DIST_HOST = () => join(__dirname, 'host');

function utility(file: string, serviceName: string): UtilityProcess {
  return utilityProcess.fork(join(DIST_HOST(), file), [], {
    serviceName,
    stdio: 'pipe',
    env: { NODE_ENV: 'production' },
  });
}

export function createHostService(
  userDataDir: string,
  onStatus: (status: HostingStatus) => void,
  options: { stunServers?: string[] } = {},
  onJoinRequest: (asking: Asking) => void = () => undefined,
): HostService {
  const hostDir = join(userDataDir, 'host');
  let secrets: HostSecretStore | null = null;
  let ports: HostPorts | null = null;
  let gatewaySecret = '';
  let roomToken = '';
  let server: UtilityProcess | null = null;
  let gateway: UtilityProcess | null = null;
  let media: LivekitProcess | null = null;
  let bridge: ReturnType<typeof openBridgeWindow> | null = null;
  let blocker: number | null = null;
  let starting: Promise<void> | null = null;
  let mayOpenBridge = false;
  let stopping: Promise<void> | null = null;
  let active = false;
  let ownerExists = false;
  let guests = 0;
  let nextOwnerRequest = 1;
  const ownerRequests = new Map<
    number,
    (result: { ok: true } | { ok: false; error: string }) => void
  >();
  const parts: Record<PartName, HostingPart> = {
    server: { state: 'stopped' },
    gateway: { state: 'stopped' },
    media: { state: 'stopped' },
    bridge: { state: 'stopped' },
  };
  const restarts: Record<PartName, Restarts> = {
    server: { at: [], total: 0 },
    gateway: { at: [], total: 0 },
    media: { at: [], total: 0 },
    bridge: { at: [], total: 0 },
  };

  const status = (): HostingStatus => ({
    active,
    code: active ? (secrets?.get().roomCode ?? null) : null,
    guests,
    awake: blocker !== null && powerSaveBlocker.isStarted(blocker),
    parts: {
      server: { ...parts.server },
      gateway: { ...parts.gateway },
      media: { ...parts.media },
      bridge: { ...parts.bridge },
    },
  });
  const changed = () => onStatus(status());
  const set = (name: PartName, part: HostingPart) => {
    parts[name] = { ...part, ...(restarts[name].total ? { restarts: restarts[name].total } : {}) };
    changed();
  };

  const mayRestart = (name: PartName) => {
    const now = Date.now();
    const record = restarts[name];
    record.at = record.at.filter((at) => now - at < RESTART_WINDOW_MS);
    if (record.at.length >= MAX_RESTARTS) return false;
    record.at.push(now);
    record.total += 1;
    return true;
  };

  const afterDeath = (name: PartName, restart: () => void, detail?: string) => {
    if (!active || stopping) return;
    if (!mayRestart(name)) {
      log.error(`${name} of the hosted room keeps stopping; not restarting it again`);
      set(name, { state: 'failed' });
      return;
    }
    log.warn(`${name} of the hosted room stopped; restarting it`);
    set(name, { state: 'restarting', ...(detail ? { detail } : {}) });
    setTimeout(() => {
      if (active && !stopping) restart();
    }, RESTART_DELAY_MS);
  };

  const pipeOutput = (name: string, child: UtilityProcess) => {
    const write = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) log.warn(`${name}: ${line.slice(0, 500)}`);
      }
    };
    child.stdout?.on('data', write);
    child.stderr?.on('data', write);
  };

  const startServer = () =>
    new Promise<void>((resolve, reject) => {
      const child = utility('server.mjs', 'Hostile room server');
      server = child;
      pipeOutput('room server', child);
      set('server', { state: 'starting' });
      let settled = false;
      const hung = setTimeout(() => {
        log.error('the room server did not start in time');
        child.kill();
      }, START_TIMEOUT_MS);
      child.on('spawn', () => {
        const current = secrets!.get();
        child.postMessage({
          type: 'start',
          env: hostServerEnv(join(hostDir, 'data'), ports!),
          secrets: {
            sessionSecret: current.sessionSecret,
            livekitKey: current.livekitKey,
            livekitSecret: current.livekitSecret,
            gatewayToken: roomToken,
            ownerSecret: current.ownerSecret,
          },
        });
      });
      child.on('message', (message: { type?: string } & Record<string, unknown>) => {
        if (message.type === 'ready') {
          clearTimeout(hung);
          ownerExists = message.hasOwner === true;
          settled = true;
          set('server', { state: 'running' });
          resolve();
        } else if (message.type === 'failed') {
          log.error(`the room server could not start: ${String(message.message).slice(0, 500)}`);
          settled = true;
          reject(new Error(String(message.message)));
        } else if (message.type === 'join-request') {
          onJoinRequest({
            nickname: String(message.nickname),
            waiting: Number(message.waiting) || 1,
          });
        } else if (message.type === 'owner') {
          const answer = ownerRequests.get(message.id as number);
          ownerRequests.delete(message.id as number);
          if (message.ok === true) ownerExists = true;
          answer?.(
            message.ok === true ? { ok: true } : { ok: false, error: String(message.error) },
          );
        }
      });
      child.on('exit', () => {
        clearTimeout(hung);
        if (server === child) server = null;
        for (const answer of ownerRequests.values()) {
          answer({ ok: false, error: 'The room server stopped.' });
        }
        ownerRequests.clear();
        if (!settled) {
          settled = true;
          return reject(new Error('The room server stopped while starting.'));
        }
        afterDeath('server', () => void startServer().catch(() => undefined));
      });
    });

  const startGateway = () =>
    new Promise<void>((resolve, reject) => {
      const child = utility('gateway.mjs', 'Hostile tunnel gateway');
      gateway = child;
      pipeOutput('gateway', child);
      set('gateway', { state: 'starting' });
      let settled = false;
      child.on('spawn', () => {
        child.postMessage({
          type: 'start',
          options: {
            roomUrl: `http://127.0.0.1:${ports!.api}`,
            livekitUrl: `http://127.0.0.1:${ports!.livekit}`,
            origin: `http://127.0.0.1:${ports!.api}`,
            secret: gatewaySecret,
            port: ports!.gateway,
            roomTrustProxy: HOST_TRUST_PROXY,
            roomToken,
          },
        });
      });
      child.on('message', (message: { type?: string; guests?: number; message?: string }) => {
        if (message.type === 'ready') {
          settled = true;
          set('gateway', { state: 'running' });
          resolve();
        } else if (message.type === 'guests') {
          if (message.guests !== guests) {
            guests = message.guests ?? 0;
            changed();
          }
        } else if (message.type === 'failed') {
          log.error(`the gateway could not start: ${String(message.message).slice(0, 500)}`);
          settled = true;
          reject(new Error(String(message.message)));
        }
      });
      child.on('exit', () => {
        if (gateway === child) gateway = null;
        guests = 0;
        if (!settled) {
          settled = true;
          return reject(new Error('The gateway stopped while starting.'));
        }
        afterDeath('gateway', () => void startGateway().catch(() => undefined));
      });
    });

  const startMedia = async () => {
    const program = findLivekitProgram();
    if (!program) {
      log.error('the media server program was not found; calls will not work');
      set('media', { state: 'failed', detail: 'missing' });
      return;
    }
    set('media', { state: 'starting' });
    reapLeftoverLivekit(hostDir);
    const current = secrets!.get();
    let udpPort = current.udpPort;
    if (udpPort === null || !(await udpPortIsFree(udpPort))) {
      if (udpPort !== null) log.warn('the media port in use until now is taken; choosing another');
      udpPort = await freeUdpPort();
      secrets!.setUdpPort(udpPort);
    }
    const started = startLivekit(program, hostDir, {
      port: ports!.livekit,
      udpPort,
      key: current.livekitKey,
      secret: current.livekitSecret,
      apiPort: ports!.api,
      ...(options.stunServers ? { stunServers: options.stunServers } : {}),
    });
    media = started;
    started.child.on('exit', () => {
      if (media === started) media = null;
      afterDeath(
        'media',
        () =>
          void startMedia().catch((err: unknown) => {
            log.error(`media server: ${messageOf(err)}`);
            set('media', { state: 'failed' });
          }),
        notReady.has(started) ? 'not-ready' : undefined,
      );
    });
    started.child.on('error', (err) => log.error(`media server: ${messageOf(err)}`));
    await waitForMedia(started);
  };

  const notReady = new WeakSet<LivekitProcess>();

  const waitForMedia = async (started: LivekitProcess) => {
    const began = Date.now();
    let last: string;
    let saidSlow = false;
    while (media === started) {
      try {
        const answer = await fetch(`http://127.0.0.1:${ports!.livekit}/`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (answer.ok) {
          set('media', { state: 'running' });
          return;
        }
        last = `${answer.status} ${(await answer.text()).split('\n')[0]!.slice(0, 80)}`;
      } catch {
        last = 'no answer';
      }
      const waited = Date.now() - began;
      if (!saidSlow && waited > MEDIA_SLOW_MS) {
        saidSlow = true;
        log.warn(
          `the media server is not ready after ${MEDIA_SLOW_MS / 1000} s (it says: ${last}); still waiting`,
        );
        set('media', { state: 'starting', detail: 'slow' });
      }
      if (waited > MEDIA_GIVE_UP_MS) {
        log.error(
          `the media server is not ready after ${MEDIA_GIVE_UP_MS / 1000} s (it says: ${last}); starting it again`,
        );
        notReady.add(started);
        started.kill();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };

  const openBridge = () => {
    set('bridge', { state: 'starting' });
    const current = secrets!.get();
    bridge = openBridgeWindow(
      {
        code: current.roomCode,
        gatewayUrl: `ws://127.0.0.1:${ports!.gateway}`,
        gatewaySecret,
        identity: {
          privateKey: current.identityPrivateKey,
          publicKey: current.identityPublicKey,
          salt: current.codeSalt,
        },
      },
      (report) => {
        if (report.room === 'open') set('bridge', { state: 'running' });
        else if (report.room === 'failed') set('bridge', { state: 'failed' });
      },
      (reason) => {
        log.warn(`the bridge window went away: ${reason}`);
        bridge = null;
        afterDeath('bridge', openBridge);
      },
    );
  };

  const prepare = async () => {
    if (stopping) await stopping;
    secrets ??= createHostSecretStore(hostDir);
    if (!ports) {
      ports = {
        api: await freeLoopbackPort(),
        livekit: await freeLoopbackPort(),
        gateway: await freeLoopbackPort(),
      };
      gatewaySecret = randomBytes(32).toString('base64url');
      roomToken = randomBytes(32).toString('base64url');
    }
    return ports;
  };

  const start = async (): Promise<void> => {
    if (stopping) await stopping;
    if (active && !starting) return;
    starting ??= (async () => {
      await prepare();
      installBridgePermissions(bridgeSession());
      active = true;
      for (const record of Object.values(restarts)) {
        record.at = [];
        record.total = 0;
      }
      blocker = powerSaveBlocker.start('prevent-app-suspension');
      set('bridge', { state: 'starting' });
      const mediaSettled = Promise.race([
        startMedia(),
        new Promise<void>((resolve) => setTimeout(resolve, MEDIA_SLOW_MS)),
      ]);
      await startServer();
      await startGateway();
      void mediaSettled
        .catch((err: unknown) => log.error(`media server: ${messageOf(err)}`))
        .finally(() => {
          mayOpenBridge = true;
          if (active && !stopping && !bridge) openBridge();
        });
    })()
      .catch(async (err: unknown) => {
        active = false;
        await stopChildren();
        throw err;
      })
      .finally(() => {
        starting = null;
      });
    return starting;
  };

  const ended = (child: UtilityProcess | null, message: unknown) =>
    new Promise<void>((resolve) => {
      if (!child?.pid) return resolve();
      const force = setTimeout(() => child.kill(), STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.postMessage(message);
    });

  const stopChildren = async () => {
    mayOpenBridge = false;
    ownerExists = false;
    bridge?.close();
    bridge = null;
    const gatewayChild = gateway;
    const serverChild = server;
    const mediaChild = media;
    gateway = null;
    server = null;
    media = null;
    const mediaEnded = new Promise<void>((resolve) => {
      if (!mediaChild) return resolve();
      const force = setTimeout(() => mediaChild.kill(), 5_000);
      mediaChild.child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      mediaChild.stop();
    });
    await Promise.all([
      ended(gatewayChild, { type: 'stop' }),
      mediaEnded,
      ended(serverChild, { type: 'stop' }),
    ]);
    if (blocker !== null) powerSaveBlocker.stop(blocker);
    blocker = null;
    guests = 0;
    for (const name of Object.keys(parts) as PartName[]) parts[name] = { state: 'stopped' };
    changed();
  };

  return {
    prepare,
    start,
    createOwner: (input) =>
      new Promise((resolve) => {
        if (!server) return resolve({ ok: false, error: 'The room server is not running.' });
        const id = nextOwnerRequest++;
        ownerRequests.set(id, resolve);
        server.postMessage({
          type: 'create-owner',
          id,
          displayName: input.displayName,
          ...(input.avatar ? { avatar: new Uint8Array(input.avatar) } : {}),
          ...(input.banner ? { banner: new Uint8Array(input.banner) } : {}),
        });
      }),
    hasOwner: () => ownerExists,
    ownerSecret: () => secrets?.get().ownerSecret ?? null,
    status,
    async newCode() {
      const code = secrets!.newRoomCode();
      bridge?.close();
      bridge = null;
      if (active && mayOpenBridge) openBridge();
      changed();
      return code;
    },
    stop: () => {
      if (!active) return Promise.resolve();
      stopping ??= (async () => {
        try {
          await starting?.catch(() => undefined);
        } finally {
          await stopChildren();
          active = false;
          ports = null;
          changed();
          stopping = null;
        }
      })();
      return stopping;
    },
    running: () => active,
    portsNow: () => ports,
    pids: () => ({
      ...(server?.pid ? { server: server.pid } : {}),
      ...(gateway?.pid ? { gateway: gateway.pid } : {}),
      ...(media?.child.pid ? { livekit: media.child.pid } : {}),
      ...(bridge && !bridge.window.isDestroyed()
        ? { bridge: bridge.window.webContents.getOSProcessId() }
        : {}),
    }),
  };
}
