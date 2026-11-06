import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, loadRepoEnv } from './lib/env.mjs';
import { findLivekitBinary } from './lib/livekit.mjs';
import { log, resolveBin, runInherit } from './lib/proc.mjs';

const layers = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!layers.length) layers.push('unit', 'integration');
const extra = process.argv.slice(2).filter((a) => a.startsWith('-'));

async function run(layer) {
  const env = loadRepoEnv();
  const serverDir = join(REPO_ROOT, 'apps', 'server');
  const webDir = join(REPO_ROOT, 'apps', 'web');
  const vitest = (dir) => resolveBin('vitest', 'vitest', dir);

  switch (layer) {
    case 'unit': {
      log.info('Unit tests (pure logic, no services)');
      const sharedDir = join(REPO_ROOT, 'packages', 'shared');
      const shared = await runInherit(process.execPath, [vitest(sharedDir), 'run'], {
        cwd: sharedDir,
      });
      if (shared !== 0) return shared;
      const web = await runInherit(process.execPath, [vitest(webDir), 'run'], { cwd: webDir });
      if (web !== 0) return web;
      const server = await runInherit(
        process.execPath,
        [vitest(serverDir), 'run', '--project', 'unit'],
        { cwd: serverDir },
      );
      if (server !== 0) return server;
      const helpers = await runInherit(process.execPath, ['--test', 'scripts/lib/*.test.mjs'], {
        cwd: REPO_ROOT,
      });
      if (helpers !== 0) return helpers;
      return runInherit(
        process.execPath,
        [
          '--experimental-test-module-mocks',
          '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
          '--import',
          './scripts/ts-esm-resolve.mjs',
          '--test',
          'src/**/*.test.ts',
        ],
        { cwd: join(REPO_ROOT, 'apps', 'desktop') },
      );
    }
    case 'integration': {
      const lk = findLivekitBinary(env);
      if (!lk || lk.missing) {
        log.warn(
          'livekit-server not found: media integration tests will be skipped (reported as skipped, not passed).',
        );
      }
      log.info('Integration tests (real database on a throwaway data folder + real LiveKit)');
      return runInherit(process.execPath, [vitest(serverDir), 'run', '--project', 'integration'], {
        cwd: serverDir,
      });
    }
    case 'e2e': {
      log.info('End-to-end tests (real stack, two browser contexts, fake media devices)');
      return runInherit(
        process.execPath,
        [resolveBin('@playwright/test', 'playwright', REPO_ROOT), 'test', ...extra],
        {
          cwd: REPO_ROOT,
        },
      );
    }
    case 'e2e-engines': {
      log.info('End-to-end tests in Firefox and in Safari engine builds (no calls: see the suite)');
      const projects = extra.some((a) => a.startsWith('--project'))
        ? []
        : ['--project=firefox', '--project=webkit', '--project=iphone'];
      return runInherit(
        process.execPath,
        [resolveBin('@playwright/test', 'playwright', REPO_ROOT), 'test', ...projects, ...extra],
        { cwd: REPO_ROOT, env: { ...process.env, E2E_OTHER_ENGINES: '1' } },
      );
    }
    case 'e2e-desktop': {
      const vite = (args, buildEnv = {}) =>
        runInherit(process.execPath, [resolveBin('vite', 'vite', webDir), 'build', ...args], {
          cwd: webDir,
          env: { ...process.env, ...buildEnv },
        });
      const skipBuilds = process.env.E2E_DESKTOP_SKIP_BUILDS === '1';
      const notices = await runInherit(process.execPath, ['scripts/third-party-notices.mjs'], {
        cwd: REPO_ROOT,
      });
      if (notices !== 0) return notices;
      if (!skipBuilds || !existsSync(join(webDir, 'dist', 'index.html'))) {
        log.info('Building the web client for the desktop shell…');
        const built = await vite([]);
        if (built !== 0) return built;
      }
      if (!skipBuilds) {
        const builds = join(REPO_ROOT, '.local', 'e2e-desktop');
        const relays = { HOSTILE_TEST_RELAYS: 'ws://127.0.0.1:5392' };
        log.info('Building the renderer and the guest site for the host specs…');
        const renderer = await vite(
          ['--outDir', join(builds, 'renderer'), '--emptyOutDir', '--sourcemap', 'false'],
          relays,
        );
        if (renderer !== 0) return renderer;
        const site = await vite(
          ['--outDir', join(builds, 'guest'), '--emptyOutDir', '--sourcemap', 'false'],
          { ...relays, HOSTILE_GUEST: '1' },
        );
        if (site !== 0) return site;
      }
      log.info('Building the desktop main process and preload…');
      const desktopDir = join(REPO_ROOT, 'apps', 'desktop');
      const bundled = await runInherit(process.execPath, ['scripts/build.mjs'], {
        cwd: desktopDir,
      });
      if (bundled !== 0) return bundled;
      log.info('Desktop smoke test (real Electron main process)');
      return runInherit(
        process.execPath,
        [
          resolveBin('@playwright/test', 'playwright', REPO_ROOT),
          'test',
          '--config',
          'playwright.desktop.config.ts',
          ...extra,
        ],
        { cwd: REPO_ROOT },
      );
    }
    case 'e2e-packaged': {
      const app = join(REPO_ROOT, '.local', 'packaged-proof', 'mac-arm64', 'Hostile.app');
      if (process.platform !== 'darwin') {
        log.fail('The packaged-app proofs drive the macOS package only.');
        return 1;
      }
      if (process.env.E2E_PACKAGED_SKIP_BUILD !== '1' || !existsSync(app)) {
        log.info('Building the proof package…');
        const built = await runInherit(
          process.execPath,
          ['scripts/package-desktop.mjs', '--proof'],
          {
            cwd: REPO_ROOT,
          },
        );
        if (built !== 0) return built;
        log.warn(
          'apps/web/dist and apps/desktop/dist now hold the proof build: build a release package before handing one out.',
        );
      }
      if (!existsSync(join(REPO_ROOT, '.local', 'e2e-desktop', 'guest', 'index.html'))) {
        log.fail(
          'No guest site in .local/e2e-desktop/guest: run the e2e-desktop layer once first.',
        );
        return 1;
      }
      log.info('Packaged-app proofs (the proof package, driven over its DevTools port)');
      return runInherit(
        process.execPath,
        [
          resolveBin('@playwright/test', 'playwright', REPO_ROOT),
          'test',
          '--config',
          'playwright.packaged.config.ts',
          ...extra,
        ],
        { cwd: REPO_ROOT },
      );
    }
    default:
      log.fail(`Unknown test layer: ${layer}`);
      return 1;
  }
}

for (const layer of layers) {
  const code = await run(layer);
  if (code !== 0) process.exit(code);
}
log.ok('All requested test layers passed.');
