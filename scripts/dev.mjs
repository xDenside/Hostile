import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_FILE, REPO_ROOT, loadRepoEnv } from './lib/env.mjs';
import { findLivekitBinary, writeDevLivekitConfig } from './lib/livekit.mjs';
import { isTcpPortFree, isUdpPortFree, waitForHttp } from './lib/net.mjs';
import { color, log, resolveBin, startService } from './lib/proc.mjs';

const args = new Set(process.argv.slice(2));
const services = [];
let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('');
  log.info('Stopping…');
  for (const s of [...services].reverse()) await s.stop();
  log.ok('Stopped.');
  process.exit(code);
}

async function main() {
  if (!existsSync(ENV_FILE)) {
    log.fail('.env not found. Run `pnpm setup:local` first.');
    process.exit(1);
  }
  const env = loadRepoEnv();
  if (env.HOSTILE_ENV !== 'development') {
    log.fail(
      `HOSTILE_ENV=${env.HOSTILE_ENV} in .env; pnpm dev only runs the development configuration.`,
    );
    process.exit(1);
  }

  const bindHost = '127.0.0.1';
  const checks = [
    ['API', env.API_PORT, 'tcp'],
    ['web', env.WEB_PORT, 'tcp'],
    ...(args.has('--no-livekit')
      ? []
      : [
          ['LiveKit signalling', env.LIVEKIT_PORT, 'tcp'],
          ['LiveKit media', env.LIVEKIT_RTC_UDP_PORT, 'udp'],
        ]),
  ];
  let portProblem = false;
  for (const [name, port, proto] of checks) {
    const free =
      proto === 'udp' ? await isUdpPortFree(port, bindHost) : await isTcpPortFree(port, bindHost);
    if (!free) {
      log.fail(
        `${name} port ${port}/${proto} is already in use. Is another \`pnpm dev\` running? Change it in .env or stop the other process.`,
      );
      portProblem = true;
    }
  }
  if (portProblem) process.exit(1);

  if (!args.has('--no-livekit')) {
    const lk = findLivekitBinary(env);
    if (!lk || lk.missing) {
      log.warn('livekit-server not found: voice and screen sharing will be unavailable.');
      log.warn(
        'Install it (macOS: `brew install livekit`; Windows/Linux: `pnpm livekit:install`) or set LIVEKIT_BIN.',
      );
    } else {
      const configFile = writeDevLivekitConfig(env);
      const livekit = startService('livekit', lk.path, ['--config', configFile]);
      services.push(livekit);
      const up = await waitForHttp(`http://127.0.0.1:${env.LIVEKIT_PORT}/`, 20_000);
      if (!up) log.warn('LiveKit did not answer within 20 s; check the [livekit] lines above.');
      else
        log.ok(
          `LiveKit ${lk.version ?? ''} on ws://localhost:${env.LIVEKIT_PORT} (media UDP ${env.LIVEKIT_RTC_UDP_PORT})`,
        );
    }
  }

  const serverDir = join(REPO_ROOT, 'apps', 'server');
  const tsx = resolveBin('tsx', 'tsx', serverDir);
  const api = startService(
    'api',
    process.execPath,
    [tsx, 'watch', '--clear-screen=false', 'src/main.ts'],
    {
      cwd: serverDir,
      env: { LOG_PRETTY: env.LOG_PRETTY ?? 'true' },
    },
  );
  services.push(api);
  if (
    !(await waitForHttp(
      `http://127.0.0.1:${env.API_PORT}/api/health`,
      45_000,
      (r) => r.status < 500,
    ))
  ) {
    log.warn('API did not become healthy within 45 s; see the [api] lines above.');
  } else {
    log.ok(`API on http://127.0.0.1:${env.API_PORT}`);
  }

  if (!args.has('--no-web')) {
    const webDir = join(REPO_ROOT, 'apps', 'web');
    const vite = resolveBin('vite', 'vite', webDir);
    const web = startService('web', process.execPath, [vite, '--strictPort'], { cwd: webDir });
    services.push(web);
    await waitForHttp(`http://127.0.0.1:${env.WEB_PORT}/`, 30_000);
  }

  console.log(`
${color(32, 'Hostile is running.')}
  Browser:   http://localhost:${env.WEB_PORT}   (use a second browser profile or a private window for a second user)
  Desktop:   pnpm dev:desktop -- --profile=alice
  API:       http://127.0.0.1:${env.API_PORT}/api/health
  Stop:      Ctrl+C
`);

  for (const s of services) {
    s.exited.then(({ code, signal }) => {
      if (shuttingDown) return;
      log.warn(
        `${s.name} exited (${signal ?? `code ${code}`}). Other services keep running; restart pnpm dev to recover it.`,
      );
    });
  }
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
main().catch(async (err) => {
  log.fail(err?.stack ?? String(err));
  await shutdown(1);
});
