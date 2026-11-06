import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { png } from '../e2e/attachment-fixtures';
import {
  closeModal,
  joinVoice,
  openDiagnostics,
  openTextChannel,
  PINNED_NOISE_MODE,
  receivedLevel,
  sendMessage,
  setNoiseMode,
} from '../e2e/helpers';
import {
  GUEST_URL,
  REPO_ROOT,
  askToJoin,
  expectInTheRoom,
  joinThroughHost,
  newUserDir,
  pasteCode,
  processTree,
  processesOn,
  readCode,
  removeDir,
  turnAway,
} from '../e2e-desktop/host-harness';

const APP = join(REPO_ROOT, '.local', 'packaged-proof', 'mac-arm64', 'Hostile.app');
const BINARY = join(APP, 'Contents', 'MacOS', 'Hostile');
const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const MEASURE = process.env.E2E_MEASURE_MEMORY === '1';

interface Packaged {
  dir: string;
  child: ChildProcess | null;
  pid: number;
  browser: Browser;
  page: Page;
  logs: string[];
}

async function appPage(browser: Browser): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().startsWith('hostile://hostile/') && !p.url().includes('bridge'));
        return !!found;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await found!.waitForLoadState('domcontentloaded');
  return found!;
}

const mainPidOn = (dir: string) =>
  processesOn(dir).find((p) => p.command.startsWith(BINARY) && !p.command.includes('--type='))?.pid;

async function devtoolsPort(dir: string, after: number): Promise<number> {
  const file = join(dir, 'DevToolsActivePort');
  let port = 0;
  await expect
    .poll(
      () => {
        if (!existsSync(file)) return 0;
        const [line] = readFileSync(file, 'utf8').split('\n');
        const value = Number(line);
        port = value && value !== after ? value : 0;
        return port;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  return port;
}

async function attach(
  dir: string,
  child: ChildProcess | null,
  logs: string[],
  oldPort = 0,
): Promise<Packaged> {
  const port = await devtoolsPort(dir, oldPort);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await appPage(browser);
  page.on('console', (m) => logs.push(`console: ${m.text()}`));
  let pid = 0;
  await expect.poll(() => (pid = mainPidOn(dir) ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  return { dir, child, pid, browser, page, logs };
}

async function launchPackaged(dir: string, more: Record<string, string> = {}): Promise<Packaged> {
  const env = { ...process.env } as Record<string, string>;
  for (const name of Object.keys(env)) if (name.startsWith('HOSTILE_')) delete env[name];
  Object.assign(env, more);
  rmSync(join(dir, 'DevToolsActivePort'), { force: true });
  const child = spawn(
    BINARY,
    [
      `--user-data-dir=${dir}`,
      '--use-mock-keychain',
      '--remote-debugging-port=0',
      '--mute-audio',
      ...MEDIA_ARGS,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env },
  );
  const logs: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  return attach(dir, child, logs);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function quit(app: Packaged) {
  const tree = processTree(app.pid);
  await app.browser.close().catch(() => undefined);
  if (alive(app.pid)) process.kill(app.pid, 'SIGTERM');
  await expect.poll(() => tree.filter(alive).length, { timeout: 30_000 }).toBe(0);
  expect(processesOn(app.dir)).toEqual([]);
}

function memoryOf(root: number) {
  const pids = processTree(root);
  const rows = execFileSync('ps', ['-o', 'pid=,rss=,command=', '-p', pids.join(',')], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((line) => {
      const [, pid, rss, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)!;
      return { pid: Number(pid), rssMB: Number(rss) / 1024, command: command! };
    });
  const now = new Map<number, number>();
  const units: Record<string, number> = { B: 1 / 2 ** 20, K: 1 / 1024, M: 1, G: 1024 };
  const top = execFileSync(
    'top',
    ['-l', '1', '-stats', 'pid,mem', ...pids.flatMap((pid) => ['-pid', String(pid)])],
    { encoding: 'utf8' },
  );
  for (const [, pid, amount, unit] of top.matchAll(/^(\d+)\s+([\d.]+)([BKMG])\+?\s*$/gm))
    now.set(Number(pid), Number(amount) * units[unit!]!);
  const named = (command: string) => {
    if (/^(\/bin\/)?sh /.test(command)) return 'LiveKit watcher';
    if (command.includes('livekit-server')) return 'LiveKit';
    const type = /--type=(\S+)/.exec(command)?.[1];
    if (!type) return 'Main';
    if (type === 'utility') return /--utility-sub-type=(\S+)/.exec(command)?.[1] ?? 'utility';
    return type;
  };
  const processes = rows.map((r) => ({
    name: named(r.command),
    rssMB: Math.round(r.rssMB),
    footprintMB: Math.round(now.get(r.pid) ?? 0),
  }));
  const sum = (key: 'rssMB' | 'footprintMB') => processes.reduce((total, p) => total + p[key], 0);
  return {
    processes,
    rssMB: sum('rssMB'),
    footprintMB: sum('footprintMB'),
  };
}

function report(label: string, value: unknown) {
  const line = `[packaged] ${label}: ${JSON.stringify(value)}`;
  console.log(line);
  test.info().annotations.push({ type: label, description: JSON.stringify(value) });
}

const hostingStatus = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        hostileDesktop: {
          hosting: {
            status(): Promise<{
              active: boolean;
              code: string | null;
              guests: number;
              parts: Record<string, { state: string }>;
            }>;
          };
        };
      }
    ).hostileDesktop.hosting.status(),
  );

const NODE_SERVICE = 'node.mojom.NodeService';

test.describe('the packaged app, against code put into it from outside', () => {
  test.skip(process.platform !== 'darwin', 'Only the macOS package is built and driven here.');

  test('takes no library from DYLD_INSERT_LIBRARIES, in itself or in any helper', async () => {
    const dir = newUserDir('pkg-inject');
    const files = newUserDir('pkg-marker');
    const marker = join(files, 'loaded.txt');
    const said = () => (existsSync(marker) ? readFileSync(marker, 'utf8') : '');
    let app: Packaged | null = null;
    try {
      writeFileSync(
        join(files, 'marker.c'),
        '#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\n' +
          '__attribute__((constructor)) static void marker(void) {\n' +
          '  const char *path = getenv("MARKER_FILE");\n' +
          '  FILE *f = path ? fopen(path, "a") : NULL;\n' +
          '  if (f) { fprintf(f, "loaded into %d\\n", getpid()); fclose(f); }\n}\n',
      );
      writeFileSync(join(files, 'probe.c'), 'int main(void) { return 0; }\n');
      const library = join(files, 'marker.dylib');
      execFileSync('cc', ['-dynamiclib', '-o', library, join(files, 'marker.c')]);
      execFileSync('cc', ['-o', join(files, 'probe'), join(files, 'probe.c')]);
      const more = { DYLD_INSERT_LIBRARIES: library, MARKER_FILE: marker };
      execFileSync(join(files, 'probe'), { env: { ...process.env, ...more } });
      expect(said()).toContain('loaded into');
      rmSync(marker);

      app = await launchPackaged(dir, more);
      await expect(app.page.getByRole('button', { name: 'Host a room' })).toBeVisible();
      expect(processTree(app.pid).length).toBeGreaterThanOrEqual(4);
      expect(said()).toBe('');
      await quit(app);
      app = null;
    } finally {
      if (app) for (const { pid } of processesOn(dir)) process.kill(pid, 'SIGKILL');
      removeDir(dir);
      removeDir(files);
    }
  });
});

test.describe.serial('the packaged app, hosting for real', () => {
  test.setTimeout(300_000);
  test.skip(process.platform !== 'darwin', 'Only the macOS package is built and driven here.');
  const hostDir = newUserDir('pkg-host');
  const guestDir = newUserDir('pkg-guest');
  const files = newUserDir('pkg-files');
  let host: Packaged;
  let appGuest: Packaged;
  let browser: Browser;
  let tab: Page;
  let code = '';

  const picture = (name: string, w: number, h: number, seed: number) => {
    const path = join(files, name);
    writeFileSync(path, png(w, h, seed));
    return path;
  };

  test.beforeAll(() => {
    expect(existsSync(BINARY), `${APP} is missing: run pnpm package:desktop -- --proof`).toBe(true);
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    for (const app of [appGuest, host]) {
      if (!app) continue;
      await app.browser.close().catch(() => undefined);
      for (const { pid } of processesOn(app.dir)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
    for (const dir of [hostDir, guestDir, files]) removeDir(dir);
  });

  test('a first run gives a nickname, pictures and a code, from inside the app', async () => {
    host = await launchPackaged(hostDir);
    const { page } = host;
    await page.getByRole('button', { name: 'Host a room' }).click();
    await page.getByLabel('Nickname').fill('Packaged Host');
    await page.getByTestId('upload-avatar').setInputFiles(picture('avatar.png', 256, 256, 3));
    await page.getByTestId('upload-banner').setInputFiles(picture('banner.png', 680, 240, 4));
    let peakRss = 0;
    const sampler = setInterval(() => {
      try {
        peakRss = Math.max(peakRss, memoryOfRss(host.pid));
      } catch {}
    }, 250);
    await page.getByRole('button', { name: 'Create my room' }).click();
    code = await readCode(page);
    await expect(page.getByTestId('hosting-media')).toContainText('Running', { timeout: 60_000 });
    await expect(page.getByTestId('hosting-bridge')).toContainText('Running', { timeout: 30_000 });
    clearInterval(sampler);
    if (MEASURE) report('first run, peak', { peakRssMB: peakRss, ...memoryOf(host.pid) });

    const tree = processTree(host.pid).map((pid) =>
      execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(),
    );
    const livekit = tree.find((c) => c.includes('livekit-server') && !c.startsWith('/bin/sh'));
    expect(livekit).toContain(`${APP}/Contents/Resources/bin/livekit-server`);
    expect(
      execFileSync('file', [`${APP}/Contents/Resources/bin/livekit-server`], { encoding: 'utf8' }),
    ).toContain('arm64');
    expect(tree.filter((c) => c.includes(NODE_SERVICE))).toHaveLength(2);
    expect(readdirSync(join(hostDir, 'host', 'data')).length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /general/ }).first()).toBeVisible();
  });

  test('a tab guest and a second packaged app ask and are let in, with chat and a file', async () => {
    browser = await chromium.launch({ channel: 'chromium', args: MEDIA_ARGS });
    tab = await (await browser.newContext()).newPage();
    await tab.goto(GUEST_URL);
    if (MEASURE) {
      await host.page.waitForTimeout(20_000);
      report('idle hosting, no guests, 20 s after the first run', memoryOf(host.pid));
      await host.page.waitForTimeout(40_000);
      report('idle hosting, no guests, 60 s after the first run', memoryOf(host.pid));
    }
    await joinThroughHost(host.page, tab, code, 'Tab Guest');
    await expect
      .poll(
        () =>
          tab
            .getByRole('complementary')
            .locator('img')
            .evaluateAll(
              (all) => all.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length,
            ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    appGuest = await launchPackaged(guestDir);
    await appGuest.page.getByRole('button', { name: 'Join with a code' }).click();
    await joinThroughHost(host.page, appGuest.page, code, 'App Guest');
    expect(appGuest.page.url()).toMatch(/^hostile:\/\/hostile\//);
    await host.page.keyboard.press('Escape');

    for (const page of [host.page, tab, appGuest.page]) await openTextChannel(page, 'general');
    await sendMessage(host.page, 'general', 'from the packaged host');
    await sendMessage(tab, 'general', 'from the tab');
    await sendMessage(appGuest.page, 'general', 'from the packaged guest');
    for (const page of [host.page, tab, appGuest.page]) {
      for (const text of ['from the packaged host', 'from the tab', 'from the packaged guest']) {
        await expect(page.getByRole('log').getByText(text)).toBeVisible({ timeout: 20_000 });
      }
    }
    await tab
      .locator('input[type=file]')
      .first()
      .setInputFiles(picture('from-tab.png', 320, 200, 9));
    await tab.getByLabel('Message #general').press('Enter');
    for (const page of [host.page, tab, appGuest.page]) {
      const image = page.getByRole('log').getByRole('img', { name: 'from-tab.png' });
      await expect(image).toBeVisible({ timeout: 45_000 });
      await expect
        .poll(() => image.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 30_000 })
        .toBeGreaterThan(0);
    }
    await expect.poll(() => hostingStatus(host.page).then((s) => s.guests)).toBe(2);
    if (MEASURE) {
      await host.page.waitForTimeout(10_000);
      report('two guests in chat', memoryOf(host.pid));
      report('the app guest, in chat', memoryOf(appGuest.pid));
    }
  });

  test('a call with audio energy both ways, and a screen share from the tab', async () => {
    await joinVoice(host.page, 'General Voice');
    await openDiagnostics(host.page);
    await expect(host.page.getByTestId('diag-noise-suppression')).toHaveText(
      'strong (hostile-fastenhancer)',
      { timeout: 20_000 },
    );
    await expect(host.page.getByTestId('diag-noise-failures')).toHaveText('none');
    await closeModal(host.page);
    for (const page of [host.page, tab, appGuest.page]) await setNoiseMode(page, PINNED_NOISE_MODE);
    for (const page of [tab, appGuest.page]) await joinVoice(page, 'General Voice');
    for (const page of [host.page, tab, appGuest.page]) {
      await expect(page.getByTestId('participant-tile')).toHaveCount(3, { timeout: 45_000 });
    }
    const levels: number[] = [];
    for (const page of [host.page, tab, appGuest.page]) {
      await expect
        .poll(async () => levels[levels.push(await receivedLevel(page)) - 1], { timeout: 45_000 })
        .toBeGreaterThan(0.005);
    }
    report('received audio levels, last of each: host, tab, app guest', levels.slice(-3));
    await tab.getByRole('button', { name: 'Share your screen' }).click();
    await tab.getByRole('button', { name: 'Start sharing' }).click();
    for (const page of [host.page, appGuest.page]) {
      const remote = page.getByTestId('share-video-remote');
      await expect(remote).toBeVisible({ timeout: 45_000 });
      const frames = await remote.evaluate(async (v: HTMLVideoElement) => {
        await new Promise((r) => setTimeout(r, 4_000));
        return v.getVideoPlaybackQuality().totalVideoFrames;
      });
      expect(frames, 'decoded screen-share frames').toBeGreaterThan(0);
    }
    await tab.getByRole('button', { name: 'Stop sharing your screen' }).click();
    for (const page of [host.page, tab, appGuest.page]) {
      await page
        .getByRole('button', { name: /^Leave|Disconnect/ })
        .first()
        .click();
    }
  });

  test('a guest turned away is told so, and a returning guest comes straight in', async () => {
    const stranger = await (await browser.newContext()).newPage();
    await stranger.goto(GUEST_URL);
    await pasteCode(stranger, code);
    await askToJoin(stranger, 'Packaged Stranger');
    await turnAway(host.page, 'Packaged Stranger');
    await expect(stranger.getByTestId('ask-turned-away')).toContainText('turned this request away');
    await stranger.context().close();

    const again = await tab.context().newPage();
    await tab.close();
    tab = again;
    await tab.goto(GUEST_URL);
    await expectInTheRoom(tab);
    await expect(tab.getByLabel('Nickname')).toHaveCount(0);
  });

  test('a restart as owner: quit, start again, and it opens straight back on the room', async () => {
    const before = await devtoolsPort(hostDir, 0);
    await quit(host);
    host = await launchPackaged(hostDir);
    await expect(host.page.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
      { timeout: 60_000 },
    );
    expect(await devtoolsPort(hostDir, before)).not.toBe(before);
    await expect
      .poll(() => hostingStatus(host.page).then((s) => [s.active, s.code]), { timeout: 60_000 })
      .toEqual([true, code]);
    await expect(host.page.getByRole('button', { name: 'Host a room' })).toHaveCount(0);
    for (const page of [tab, appGuest.page]) await expectInTheRoom(page);
  });

  test('a guest in the app restarts straight into the room, and leaving starts it again, able to host', async () => {
    await quit(appGuest);
    const oldPort = Number(
      readFileSync(join(guestDir, 'DevToolsActivePort'), 'utf8').split('\n')[0],
    );
    appGuest = await launchPackaged(guestDir);
    await expectInTheRoom(appGuest.page);
    await expect(appGuest.page.getByLabel('Nickname')).toHaveCount(0);

    const firstPid = appGuest.pid;
    await appGuest.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await appGuest.page.getByRole('button', { name: 'Room', exact: true }).click();
    await appGuest.page.getByRole('button', { name: 'Leave', exact: true }).click();
    await appGuest.page.getByRole('button', { name: 'Leave', exact: true }).last().click();
    await expect
      .poll(() => mainPidOn(guestDir) ?? firstPid, { timeout: 60_000 })
      .not.toBe(firstPid);
    await appGuest.browser.close().catch(() => undefined);
    appGuest = await attach(guestDir, null, [], oldPort);
    const argv = execFileSync('ps', ['-p', String(appGuest.pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
    report('the relaunched process', argv.replace(guestDir, '<folder>'));
    await appGuest.page.getByRole('button', { name: 'Host a room' }).click();
    await appGuest.page.getByLabel('Nickname').fill('Former Guest');
    await appGuest.page.getByRole('button', { name: 'Create my room' }).click();
    const theirs = await readCode(appGuest.page);
    expect(theirs).not.toBe(code);
    await expect(appGuest.page.getByTestId('hosting-media')).toContainText('Running', {
      timeout: 60_000,
    });
  });

  test('Stop hosting leaves no process of the room behind, and quitting leaves nothing at all', async () => {
    for (const app of [host, appGuest]) {
      const { page } = app;
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await page.getByRole('button', { name: 'Hosting', exact: true }).click();
      await page.getByRole('button', { name: 'Stop hosting' }).click();
      await page.getByRole('button', { name: 'Stop hosting' }).last().click();
      await expect(page.getByRole('button', { name: 'Host a room' })).toBeVisible({
        timeout: 30_000,
      });
      const left = () =>
        processTree(app.pid).map((pid) =>
          execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(),
        );
      await expect
        .poll(
          () => left().filter((c) => c.includes(NODE_SERVICE) || c.includes('livekit')).length,
          { timeout: 30_000 },
        )
        .toBe(0);
      await expect
        .poll(
          () =>
            app.browser
              .contexts()
              .flatMap((c) => c.pages())
              .filter((p) => p.url().includes('bridge')).length,
        )
        .toBe(0);
      await quit(app);
    }
    expect(processesOn(hostDir)).toEqual([]);
    expect(processesOn(guestDir)).toEqual([]);
  });
});

function memoryOfRss(root: number): number {
  const out = execFileSync('ps', ['-o', 'rss=', '-p', processTree(root).join(',')], {
    encoding: 'utf8',
  });
  return Math.round(
    out
      .trim()
      .split('\n')
      .reduce((total, line) => total + Number(line.trim()), 0) / 1024,
  );
}
