import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_FILE, REPO_ROOT, loadRepoEnv } from './lib/env.mjs';
import { waitForHttp } from './lib/net.mjs';
import { color, log, resolveBin, runInherit, startService } from './lib/proc.mjs';

const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');
const ELECTRON_DIR = join(DESKTOP_DIR, 'node_modules', 'electron');
const PROFILE_PATTERN = /^[a-z0-9_-]{1,32}$/;

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const services = [];
let shuttingDown = false;

function readProfile() {
  const arg = args.find((value) => value.startsWith('--profile='));
  if (!arg) return 'default';
  const value = arg.slice('--profile='.length).trim().toLowerCase();
  if (!PROFILE_PATTERN.test(value)) {
    log.fail(`--profile=${value}: use 1-32 characters from a-z, 0-9, "-" and "_".`);
    process.exit(1);
  }
  return value;
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const service of [...services].reverse()) await service.stop();
  process.exit(code);
}

async function ensureElectronBinary() {
  if (existsSync(join(ELECTRON_DIR, 'dist'))) return true;
  log.info('Electron binary is missing; downloading it…');
  const code = await runInherit(process.execPath, [join(ELECTRON_DIR, 'install.js')], {
    cwd: ELECTRON_DIR,
  });
  if (code !== 0 || !existsSync(join(ELECTRON_DIR, 'dist'))) {
    log.fail(
      'Could not download the Electron binary. Check your network and run `pnpm install` again.',
    );
    return false;
  }
  return true;
}

function electronExecutable() {
  const relative = readFileSync(join(ELECTRON_DIR, 'path.txt'), 'utf8').trim();
  return join(ELECTRON_DIR, 'dist', relative);
}

async function main() {
  if (!existsSync(ENV_FILE)) {
    log.fail('.env not found. Run `pnpm setup:local` first.');
    process.exit(1);
  }
  const env = loadRepoEnv();
  const profile = readProfile();
  const webUrl = `http://localhost:${env.WEB_PORT}`;

  const webUp = await waitForHttp(
    `http://127.0.0.1:${env.WEB_PORT}/`,
    1500,
    (res) => res.status < 500,
  );
  if (!webUp) {
    const webDir = join(REPO_ROOT, 'apps', 'web');
    services.push(
      startService('web', process.execPath, [resolveBin('vite', 'vite', webDir), '--strictPort'], {
        cwd: webDir,
      }),
    );
    if (!(await waitForHttp(`http://127.0.0.1:${env.WEB_PORT}/`, 30_000))) {
      log.fail(`The Vite dev server did not answer on ${webUrl}; see the [web] lines above.`);
      await shutdown(1);
    }
  }

  if (!(await ensureElectronBinary())) process.exit(1);

  const buildScript = join(DESKTOP_DIR, 'scripts', 'build.mjs');
  if (!flags.has('--no-build')) {
    const code = await runInherit(process.execPath, [buildScript, '--no-renderer'], {
      cwd: DESKTOP_DIR,
    });
    if (code !== 0) {
      log.fail('Bundling the desktop main process failed.');
      process.exit(1);
    }
    if (flags.has('--watch')) {
      services.push(
        startService('bundle', process.execPath, [buildScript, '--no-renderer', '--watch'], {
          cwd: DESKTOP_DIR,
        }),
      );
    }
  }

  const electron = startService(
    'desktop',
    electronExecutable(),
    [DESKTOP_DIR, `--profile=${profile}`],
    {
      cwd: DESKTOP_DIR,
      env: {
        HOSTILE_DESKTOP_RENDERER_URL: webUrl,
      },
    },
  );
  services.push(electron);

  console.log(`
${color(32, `Hostile desktop (profile "${profile}") is starting.`)}
  Renderer:  ${webUrl}   (the Vite dev server; reload the window after a change)
  Second user:  pnpm dev:desktop -- --profile=bob --no-build
  Stop:      Ctrl+C
`);

  const { code, signal } = await electron.exited;
  if (!shuttingDown) {
    log.info(`Electron exited (${signal ?? `code ${code}`}).`);
    await shutdown(code ?? 0);
  }
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
main().catch(async (err) => {
  log.fail(err?.stack ?? String(err));
  await shutdown(1);
});
