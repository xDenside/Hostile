import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { pngFile } from '../e2e/attachment-fixtures';
import { joinVoice } from '../e2e/helpers';
import {
  askBridge,
  GUEST_DIR,
  GUEST_URL,
  reachBridge,
  hostFirstRun,
  readCode,
  launch,
  listeningSockets,
  livekitConfig,
  newUserDir,
  processesOn,
  processTree,
  readAllLogs,
  removeDir,
  RENDERER_DIR,
  type Instance,
} from './host-harness';

const OWNER = { displayName: 'Olive Host' };

test('first run hosts a room: code shown, only the media port off loopback, no secret logged', async () => {
  test.setTimeout(240_000);
  const dir = newUserDir('first');
  let host: Instance | null = null;
  try {
    host = await launch(dir, { realMedia: true });
    const avatar = pngFile('me.png', 160, 160, 7);
    const banner = pngFile('wide.png', 680, 240, 8);
    await host.page.getByRole('button', { name: 'Host a room' }).click();
    await expect(host.page.getByLabel('Nickname')).toBeVisible();
    await host.page.getByTestId('upload-avatar').setInputFiles(avatar);
    await host.page.getByTestId('upload-banner').setInputFiles(banner);
    await host.page.getByLabel('Nickname').fill(OWNER.displayName);
    await host.page.waitForTimeout(700);
    await host.page.screenshot({ path: test.info().outputPath('first-run-card.png') });
    expect(await host.page.locator('input[type=password]').count()).toBe(0);
    await host.page.getByRole('button', { name: 'Create my room' }).click();
    const code = await readCode(host.page);
    expect(code).toMatch(/^[0-9A-Z-]{30,}$/);
    expect(await host.page.getByTestId('hosting-bridge').textContent()).not.toContain('Stopped');
    await expect(host.page.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
      { timeout: 30_000 },
    );
    await expect(host.page.getByTestId('hosting-media'))
      .toContainText('Running', { timeout: 30_000 })
      .catch((err: Error) => {
        const said = host!.logs.filter((line) => line.includes('media server'));
        throw new Error(`${err.message}\n${said.slice(-8).join('').slice(-1500)}`);
      });
    await expect(host.page.getByTestId('hosting-bridge')).toContainText('Running', {
      timeout: 30_000,
    });

    const asserted = () => execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' });
    const status = () =>
      host!.page.evaluate(() =>
        (
          window as unknown as {
            hostileDesktop: { hosting: { status(): Promise<{ awake: boolean }> } };
          }
        ).hostileDesktop.hosting.status(),
      );
    expect((await status()).awake).toBe(true);
    const pid = host.app.process().pid!;
    expect(asserted()).toContain(`pid ${pid}`);

    const bridge = await askBridge(host.app);
    test.info().annotations.push({ type: 'candidates', description: bridge.candidates.join('\n') });
    expect(bridge.microphone).toBe('NotAllowedError');
    const hosts = bridge.candidates.filter((c) => / typ host/.test(c));
    expect(hosts.length, 'candidates from this PC').toBeGreaterThan(0);
    expect(
      hosts.filter((c) => /\.local /.test(c)),
      'addresses hidden behind mDNS',
    ).toEqual([]);
    const asked = await host.app.evaluate(
      () => (globalThis as unknown as { __mediaAsked: string[] }).__mediaAsked,
    );
    expect(asked, 'requests to the system for a microphone').toEqual([]);

    const sockets = listeningSockets(processTree(pid));
    test.info().annotations.push({ type: 'lsof', description: sockets.join('\n') });
    console.log(`lsof while hosting:\n${sockets.join('\n')}`);
    const tcpOff = sockets.filter((l) => /\(LISTEN\)/.test(l) && !/127\.0\.0\.1:/.test(l));
    expect(tcpOff, 'TCP listeners off loopback').toEqual([]);
    const secrets = JSON.parse(readFileSync(join(dir, 'host', 'secrets.json'), 'utf8')) as Record<
      string,
      string | number
    >;
    const udpOff = sockets.filter(
      (l) => /UDP/.test(l) && !/127\.0\.0\.1:/.test(l) && !l.includes(`:${secrets.udpPort}`),
    );
    expect(udpOff, 'UDP sockets off loopback other than the media port').toEqual([]);
    expect(
      sockets.filter((l) => /UDP/.test(l) && !/livekit/i.test(l)),
      'UDP sockets of anything but LiveKit',
    ).toEqual([]);

    const browser = await chromium.launch();
    try {
      const guest = await browser.newPage();
      await guest.goto(GUEST_URL);
      const reached = await reachBridge(host.app, guest);
      test
        .info()
        .annotations.push({ type: 'guest', description: reached.guestCandidates.join('\n') });
      console.log(`candidates of a guest with no grant:\n${reached.guestCandidates.join('\n')}`);
      expect(reached.guestCandidates.filter((c) => / typ host/.test(c)).length).toBeGreaterThan(0);
      expect(
        reached.guestCandidates.filter((c) => / typ host/.test(c) && !/\.local /.test(c)),
        'a guest with no grant hides its address',
      ).toEqual([]);
      expect(reached.open).toBe(true);
      const during = listeningSockets(processTree(pid));
      console.log(`lsof with such a guest connected:\n${during.join('\n')}`);
      expect(
        during.filter((l) => /\(LISTEN\)/.test(l) && !/127\.0\.0\.1:/.test(l)),
        'TCP listeners off loopback with a guest connected',
      ).toEqual([]);
    } finally {
      await browser.close();
    }

    expect(statSync(join(dir, 'host', 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'host')).mode & 0o777).toBe(0o700);
    expect(statSync(livekitConfig(dir)).mode & 0o777).toBe(0o600);
    const everyLog = host.logs.join('') + readAllLogs(dir);
    for (const secret of [
      secrets.sessionSecret,
      secrets.livekitSecret,
      secrets.livekitKey,
      secrets.roomCode,
      secrets.ownerSecret,
    ]) {
      expect(everyLog.includes(String(secret)), 'a secret reached a log').toBe(false);
    }
    const commandLines = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' });
    for (const secret of [secrets.sessionSecret, secrets.livekitSecret, secrets.ownerSecret]) {
      expect(commandLines.includes(String(secret)), 'a secret on a command line').toBe(false);
    }

    await host.page.screenshot({ path: test.info().outputPath('hosting-tab.png') });
    const seen = await host.page.evaluate(
      () => JSON.stringify(localStorage) + document.body.innerHTML,
    );
    expect(seen.includes(String(secrets.ownerSecret))).toBe(false);
    expect(String(secrets.ownerSecret).length).toBeGreaterThanOrEqual(32);

    await host.app.close();
    host = await launch(dir, { realMedia: true });
    await expect(host.page.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
      {
        timeout: 90_000,
      },
    );
    await expect(host.page.getByRole('button', { name: 'Host a room' })).toHaveCount(0);
    await host.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(host.page.getByRole('button', { name: 'Hosting', exact: true })).toBeVisible();
    await host.page.getByRole('button', { name: 'Hosting', exact: true }).click();
    expect(await readCode(host.page)).toBe(code);
    await expect(host.page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(host.page.getByRole('button', { name: 'Leave', exact: true })).toHaveCount(0);
    await host.page.waitForTimeout(700);

    const stopButton = host.page.getByRole('button', { name: 'Stop hosting' });
    const newCodeButton = host.page.getByRole('button', { name: 'Make a new code' });
    const buttonBefore = (await newCodeButton.boundingBox())!;
    const stopBefore = await stopButton.boundingBox();
    await newCodeButton.click();
    const question = host.page.getByRole('group', { name: 'Cut everyone off?' });
    await host.page.waitForTimeout(300);
    expect(await stopButton.boundingBox()).toEqual(stopBefore);
    const box = (await question.boundingBox())!;
    expect(box.x + box.width).toBeCloseTo(buttonBefore.x + buttonBefore.width, 0);
    expect(box.y).toBeCloseTo(buttonBefore.y, 0);
    await question.getByRole('button', { name: 'Cancel' }).click();

    await host.page.getByRole('button', { name: 'Stop hosting' }).click();
    await host.page.getByRole('button', { name: 'Stop hosting' }).last().click();
    await expect(host.page.getByRole('button', { name: 'Host a room' })).toBeVisible({
      timeout: 30_000,
    });
    expect(asserted()).not.toContain(`pid ${pid}`);
  } finally {
    await host?.app.close().catch(() => undefined);
    removeDir(dir);
  }
});

test('a room whose data went away is set up again by its host, never asked to join as a guest', async () => {
  test.setTimeout(240_000);
  const dir = newUserDir('noowner');
  let host: Instance | null = null;
  try {
    host = await launch(dir);
    await hostFirstRun(host, OWNER);
    await host.app.close();
    host = null;
    renameSync(join(dir, 'host', 'data'), join(dir, 'host', 'data-moved'));

    host = await launch(dir);
    await expect(host.page.getByRole('form', { name: 'Create your room' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(host.page.getByRole('button', { name: 'Ask to join' })).toHaveCount(0);
    await host.page.getByRole('button', { name: 'Back' }).click();
    expect(await hostFirstRun(host, OWNER)).toBeTruthy();
  } finally {
    await host?.app.close().catch(() => undefined);
    removeDir(dir);
  }
});

test('the bridge page ships in the app and not on the guest site', () => {
  expect(existsSync(join(RENDERER_DIR, 'bridge.html'))).toBe(true);
  expect(existsSync(join(GUEST_DIR, 'bridge.html'))).toBe(false);
});

test('a run that began as a guest starts again on leaving, and then hosts with no mDNS responder', async () => {
  test.setTimeout(240_000);
  const dir = newUserDir('guestfirst');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, room: 'guest' }));
  let host: Instance | null = null;
  try {
    host = await launch(dir);
    const first = host.app.process();
    const refused = await host.page.evaluate(() =>
      (
        window as unknown as {
          hostileDesktop: { room: { host(owner: null): Promise<{ ok: boolean }> } };
        }
      ).hostileDesktop.room.host(null),
    );
    expect(refused.ok).toBe(false);

    const gone = new Promise((resolve) => first.once('exit', resolve));
    await host.page.getByRole('button', { name: 'Back', exact: true }).click();
    await gone;
    const again = () =>
      processesOn(dir).filter((p) => p.pid !== first.pid && !p.command.includes('--type='));
    await expect.poll(() => again().length, { timeout: 30_000 }).toBeGreaterThan(0);
    for (const { pid } of again()) process.kill(pid, 'SIGKILL');
    await expect.poll(() => processesOn(dir).length, { timeout: 20_000 }).toBe(0);

    host = await launch(dir);
    await hostFirstRun(host, OWNER);
    await expect(host.page.getByTestId('hosting-bridge')).toContainText('Running', {
      timeout: 60_000,
    });
    const sockets = listeningSockets(processTree(host.app.process().pid!));
    console.log(`lsof after a guest's run:\n${sockets.join('\n')}`);
    expect(
      sockets.filter((l) => /UDP/.test(l) && /:5353\b/.test(l)),
      'the mDNS responder',
    ).toEqual([]);
  } finally {
    await host?.app.close().catch(() => undefined);
    for (const { pid } of processesOn(dir)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    removeDir(dir);
  }
});

test('stopping the room during a call leaves no media server behind', async () => {
  test.setTimeout(240_000);
  const dir = newUserDir('stopcall');
  let host: Instance | null = null;
  try {
    host = await launch(dir);
    await hostFirstRun(host, OWNER);
    await expect(host.page.getByTestId('hosting-media')).toContainText('Running', {
      timeout: 60_000,
    });
    await host.page.keyboard.press('Escape');
    await joinVoice(host.page, 'General Voice');
    const config = livekitConfig(dir);
    expect(processesOn(config).length, 'the media server, running').toBeGreaterThan(0);

    await host.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await host.page.getByRole('button', { name: 'Hosting' }).click();
    await host.page.getByRole('button', { name: 'Stop hosting' }).click();
    await host.page.getByRole('button', { name: 'Stop hosting' }).last().click();
    await expect(host.page.getByRole('button', { name: 'Host a room' })).toBeVisible({
      timeout: 30_000,
    });
    expect(processesOn(config), 'media server left behind').toEqual([]);
    expect(existsSync(join(dir, 'host', 'livekit.pid'))).toBe(false);
  } finally {
    await host?.app.close().catch(() => undefined);
    removeDir(dir);
  }
});
