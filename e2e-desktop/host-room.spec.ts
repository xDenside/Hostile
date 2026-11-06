import { execFileSync } from 'node:child_process';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { pngFile, REAL_VIDEOS } from '../e2e/attachment-fixtures';
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
  expectInTheRoom,
  hostFirstRun,
  joinThroughHost,
  launch,
  newUserDir,
  processTree,
  readCode,
  removeDir,
  runPlainly,
  type Instance,
} from './host-harness';

const OWNER = { displayName: 'Room Host' };
const TAB = { displayName: 'Tab Guest' };
const APP = { displayName: 'App Guest' };

const DOWN_MS = 90_000;

interface HostingStatusLike {
  code: string;
  guests: number;
  parts: Record<string, { state: string; restarts?: number }>;
}
const hostingStatus = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { hostileDesktop: { hosting: { status(): Promise<unknown> } } }
    ).hostileDesktop.hosting.status(),
  ) as Promise<HostingStatusLike>;
const hostPids = (host: Instance) =>
  processTree(host.app.process().pid!).map((pid) => ({
    pid,
    command: execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(),
  }));

test.describe.serial('a room hosted in the real app, with a tab guest and an app guest', () => {
  test.setTimeout(300_000);
  const hostDir = newUserDir('host');
  const guestDir = newUserDir('guest');
  let host: Instance;
  let appGuest: Instance;
  let browser: Browser;
  let tab: Page;
  const tabLogs: string[] = [];
  let code = '';

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    browser = await chromium.launch({
      channel: 'chromium',
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    host = await launch(hostDir);
    code = await hostFirstRun(host, OWNER);
    appGuest = await launch(guestDir);
    const context = await browser.newContext();
    await context
      .grantPermissions(['clipboard-read'], { origin: GUEST_URL })
      .catch(() => undefined);
    tab = await context.newPage();
    tab.on('console', (message) => tabLogs.push(`tab console: ${message.text()}`));
    await tab.goto(GUEST_URL);
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await appGuest?.app.close().catch(() => undefined);
    await host?.app.close().catch(() => undefined);
    removeDir(hostDir);
    removeDir(guestDir);
  });

  test('proof 2: a tab and an app each ask and are let in, with live chat, presence and typing', async () => {
    await host.page.keyboard.press('Escape');
    await joinThroughHost(host.page, tab, code, TAB.displayName);
    await appGuest.page.getByRole('button', { name: 'Join with a code' }).click();
    await joinThroughHost(host.page, appGuest.page, code, APP.displayName);
    expect(appGuest.page.url()).toMatch(/^hostile:\/\/hostile\//);

    for (const page of [host.page, tab, appGuest.page]) await openTextChannel(page, 'general');
    await sendMessage(host.page, 'general', 'from the host');
    await sendMessage(tab, 'general', 'from the tab');
    await sendMessage(appGuest.page, 'general', 'from the app guest');
    for (const page of [host.page, tab, appGuest.page]) {
      for (const text of ['from the host', 'from the tab', 'from the app guest']) {
        await expect(page.getByRole('log').getByText(text)).toBeVisible({ timeout: 20_000 });
      }
    }
    for (const page of [host.page, tab, appGuest.page]) {
      for (const name of [OWNER.displayName, TAB.displayName, APP.displayName]) {
        await expect(page.getByRole('complementary').getByText(name).first()).toBeVisible({
          timeout: 20_000,
        });
      }
    }
    await host.page.waitForTimeout(6_000);
    const pairs: [Page, Page, RegExp][] = [
      [tab, host.page, /Tab Guest/],
      [host.page, appGuest.page, /Room Host/],
      [appGuest.page, tab, /App Guest/],
    ];
    for (const [from, to, name] of pairs) {
      const typing = from
        .getByLabel('Message #general')
        .pressSequentially('still typing along, and typing, and typing, and typing', {
          delay: 120,
        });
      await expect(to.getByText(/is typing/)).toContainText(name, { timeout: 12_000 });
      await typing;
      await from.getByLabel('Message #general').fill('');
      await to.waitForTimeout(3_500);
    }
    await expect.poll(() => hostingStatus(host.page).then((s) => s.guests)).toBe(2);
  });

  test('proof 3: files and pictures in all three, with video seeking', async () => {
    await expect
      .poll(() => appGuest.page.evaluate(() => !!navigator.serviceWorker.controller), {
        timeout: 20_000,
      })
      .toBe(true);
    const sent: [Page, string][] = [
      [host.page, 'from-host.png'],
      [tab, 'from-tab.png'],
      [appGuest.page, 'from-app.png'],
    ];
    let seed = 11;
    for (const [page, name] of sent) {
      await page
        .locator('input[type=file]')
        .first()
        .setInputFiles(pngFile(name, 320, 200, seed++));
      await page.getByLabel('Message #general').press('Enter');
      await page.waitForTimeout(1_000);
    }
    for (const page of [host.page, tab, appGuest.page]) {
      for (const [, name] of sent) {
        const image = page.getByRole('log').getByRole('img', { name });
        await expect(image).toBeVisible({ timeout: 45_000 });
        await expect
          .poll(() => image.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 30_000 })
          .toBeGreaterThan(0);
      }
    }
    await tab
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: REAL_VIDEOS.mp4.bytes });
    await tab.getByLabel('Message #general').press('Enter');
    for (const page of [host.page, tab, appGuest.page]) {
      const player = page.getByRole('log').locator('video').last();
      await expect(player).toBeVisible({ timeout: 60_000 });
      const result = await player.evaluate(
        (v: HTMLVideoElement) =>
          new Promise<{ seeked: number; played: boolean; error: string | null }>((resolve) => {
            const timer = setTimeout(
              () => resolve({ seeked: -1, played: false, error: v.error?.message ?? 'timed out' }),
              30_000,
            );
            v.muted = true;
            v.addEventListener(
              'loadedmetadata',
              () => {
                v.addEventListener(
                  'seeked',
                  () => {
                    const seeked = v.currentTime;
                    v.addEventListener('timeupdate', () => {
                      if (v.currentTime <= seeked) return;
                      clearTimeout(timer);
                      v.pause();
                      resolve({ seeked, played: true, error: null });
                    });
                    v.play().catch((err: unknown) => {
                      clearTimeout(timer);
                      resolve({ seeked, played: false, error: String(err) });
                    });
                  },
                  { once: true },
                );
                v.currentTime = v.duration / 2;
              },
              { once: true },
            );
            v.load();
          }),
      );
      expect(result.error).toBeNull();
      expect(result.seeked).toBeGreaterThan(0);
      expect(result.played).toBe(true);
    }
  });

  test('proof 3 and pictures in the app: avatars and banners show in all three', async () => {
    let seed = 40;
    const people: [Page, string][] = [
      [host.page, OWNER.displayName],
      [tab, TAB.displayName],
      [appGuest.page, APP.displayName],
    ];
    for (const [page] of people) {
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await page.getByRole('button', { name: 'Profile', exact: true }).click();
      await page
        .getByTestId('upload-avatar')
        .setInputFiles(pngFile('avatar.png', 256, 256, seed++));
      await expect(page.getByTestId('profile-preview').locator('img').first()).toBeVisible({
        timeout: 30_000,
      });
      await page
        .getByTestId('upload-banner')
        .setInputFiles(pngFile('banner.png', 680, 240, seed++));
      await expect(page.getByTestId('profile-preview').locator('img')).toHaveCount(2, {
        timeout: 30_000,
      });
      await closeModal(page);
    }
    for (const [page] of people) {
      for (const [, name] of people) {
        await page.getByRole('complementary').getByText(name).first().click();
        const card = page.getByTestId('profile-card');
        await expect(card).toBeVisible();
        const images = card.locator('img');
        await expect(images).toHaveCount(2, { timeout: 20_000 });
        for (const image of await images.all()) {
          await expect
            .poll(() => image.evaluate((i: HTMLImageElement) => i.naturalWidth), {
              timeout: 30_000,
            })
            .toBeGreaterThan(0);
        }
        await page.keyboard.press('Escape');
        await expect(card).toBeHidden();
      }
    }
    await host.page.getByRole('complementary').getByText(TAB.displayName).first().click();
    await host.page.waitForTimeout(500);
    await host.page.screenshot({ path: test.info().outputPath('host-window-card.png') });
    await host.page.keyboard.press('Escape');
    await appGuest.page.getByRole('complementary').getByText(OWNER.displayName).first().click();
    await appGuest.page.waitForTimeout(500);
    await appGuest.page.screenshot({ path: test.info().outputPath('app-guest-card.png') });
    await appGuest.page.keyboard.press('Escape');
    for (const page of [tab, appGuest.page]) {
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
      await page.getByRole('button', { name: 'Third-party notices' }).click();
      await expect(page.getByTestId('notices-text')).toContainText('Apache License');
      await closeModal(page);
    }
  });

  test('proof 4: a call and a screen share among the three, with audio energy both ways', async () => {
    await joinVoice(host.page, 'General Voice');
    await openDiagnostics(host.page);
    await expect(host.page.getByTestId('diag-noise-suppression')).toHaveText(
      'strong (hostile-fastenhancer)',
      { timeout: 20_000 },
    );
    await expect(host.page.getByTestId('diag-noise-failures')).toHaveText('none');
    await closeModal(host.page);
    for (const page of [host.page, tab, appGuest.page]) await setNoiseMode(page, PINNED_NOISE_MODE);
    try {
      await joinVoice(tab, 'General Voice', 'the tab guest');
      await joinVoice(appGuest.page, 'General Voice', 'the app guest');
    } catch (err) {
      const media = [...tabLogs, ...host.logs, ...appGuest.logs]
        .join('\n')
        .split('\n')
        .filter((line) => /media server|livekit|\bice\b|webrtc|voice|connection/i.test(line))
        .slice(-40)
        .join('\n');
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\nTab, host and app guest media lines:\n${media || 'none'}`,
        { cause: err },
      );
    }
    for (const page of [host.page, tab, appGuest.page]) {
      await expect(page.getByTestId('participant-tile')).toHaveCount(3, { timeout: 45_000 });
    }
    for (const page of [host.page, tab, appGuest.page]) {
      await expect.poll(() => receivedLevel(page), { timeout: 45_000 }).toBeGreaterThan(0.005);
    }
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
        .getByRole('button', { name: /Leave|Disconnect/ })
        .first()
        .click();
    }
  });

  test('host-room 7: a new code stops the old one, and the new one works', async () => {
    await host.page.getByRole('button', { name: 'Settings' }).click();
    await host.page.getByRole('button', { name: 'Hosting' }).click();
    const old = await readCode(host.page);
    await host.page.getByRole('button', { name: 'Make a new code' }).click();
    await host.page.getByRole('button', { name: 'Make a new code' }).last().click();
    await expect(host.page.getByTestId('hosting-code').locator('[class*="secret"]')).not.toHaveText(
      old,
      { timeout: 10_000 },
    );
    const fresh = await readCode(host.page);
    const stranger = await browser.newContext().then((c) => c.newPage());
    await stranger.goto(GUEST_URL);
    await stranger.getByLabel('Room code').fill(old);
    await stranger.getByRole('button', { name: 'Connect' }).click();
    await expect(stranger.getByTestId('join-failed')).toHaveAttribute('data-step', 'finding-host', {
      timeout: 40_000,
    });
    await stranger.getByRole('button', { name: 'Use a different code' }).click();
    await stranger.getByLabel('Room code').fill(fresh);
    await stranger.getByRole('button', { name: 'Connect' }).click();
    await expect(stranger.getByLabel('Nickname')).toBeVisible({ timeout: 45_000 });
    await stranger.context().close();
    await expect(tab.getByText(/whether the code changed/).first()).toBeVisible({
      timeout: 60_000,
    });
    code = fresh;
    for (const page of [tab, appGuest.page]) {
      await page.reload();
      await page.getByRole('button', { name: 'Use a different code' }).click({ timeout: 45_000 });
      await page.getByLabel('Room code').fill(fresh);
      await page.getByRole('button', { name: 'Connect' }).click();
      await expectInTheRoom(page);
      await expect(page.getByLabel('Nickname')).toHaveCount(0);
    }
    await expect(host.page.getByTestId('join-request')).toHaveCount(0);
  });

  test('proof 5: LiveKit and the server killed with -9 come back, and the Hosting group says so', async () => {
    const live = hostPids(host);
    const livekit = live.find((p) => p.command.includes('livekit-server --config'));
    expect(livekit, 'LiveKit runs under the app').toBeTruthy();
    process.kill(livekit!.pid, 'SIGKILL');
    await expect(host.page.getByTestId('hosting-media')).toContainText('restarted once', {
      timeout: 30_000,
    });
    await expect(host.page.getByTestId('hosting-media')).toContainText('Running', {
      timeout: 30_000,
    });
    const server = hostPids(host).find((p) => p.command.includes('Hostile room server'));
    const serverPid =
      server?.pid ??
      (await host.app.evaluate(
        ({ app }) =>
          app.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'Hostile room server')
            ?.pid,
      ));
    expect(serverPid, 'the room server runs in a utility process').toBeTruthy();
    process.kill(serverPid!, 'SIGKILL');
    await expect(host.page.getByTestId('hosting-server')).toContainText('restarted once', {
      timeout: 30_000,
    });
    await expect(host.page.getByTestId('hosting-server')).toContainText('Running', {
      timeout: DOWN_MS,
    });
    await expect(host.page.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
      { timeout: DOWN_MS },
    );
    await expect(tab.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
      timeout: DOWN_MS,
    });
    await host.page.keyboard.press('Escape');
    for (const page of [host.page, tab, appGuest.page]) await openTextChannel(page, 'general');
    await sendMessage(host.page, 'general', 'after the kills');
    await expect(tab.getByRole('log').getByText('after the kills')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('proof 5: quit and reopen keeps the code and the data, and guests return by themselves', async () => {
    await host.app.close();
    await expect(tab.getByTestId('connection-state')).not.toHaveAttribute(
      'data-state',
      'connected',
      {
        timeout: 30_000,
      },
    );
    await expect(tab.getByTestId('connection-state')).toContainText('Host away', {
      timeout: 60_000,
    });
    await expect(tab.getByText('The host is away.')).toBeVisible();
    await tab.screenshot({ path: test.info().outputPath('tab-host-away.png') });
    host = await launch(hostDir);
    await expect(host.page.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
      { timeout: DOWN_MS },
    );
    expect((await hostingStatus(host.page)).code).toBe(code);
    await expect(host.page.getByRole('log').getByText('after the kills')).toBeVisible({
      timeout: 30_000,
    });
    for (const page of [tab, appGuest.page]) {
      await expect(page.getByTestId('connection-state')).toHaveAttribute(
        'data-state',
        'connected',
        { timeout: DOWN_MS },
      );
    }
    await sendMessage(tab, 'general', 'back again');
    for (const page of [host.page, appGuest.page]) {
      await expect(page.getByRole('log').getByText('back again')).toBeVisible({
        timeout: 30_000,
      });
    }
  });

  test('proof 5: kill -9 of the main process leaves nothing behind, and the next start works', async () => {
    const pid = host.app.process().pid!;
    const children = processTree(pid).filter((p) => p !== pid);
    const livekit = hostPids(host).find((p) => p.command.includes('livekit-server --config'))!;
    process.kill(pid, 'SIGKILL');
    const alive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(() => alive(livekit.pid), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => children.filter(alive), { timeout: 15_000 }).toEqual([]);
    host = await launch(hostDir);
    await expect(host.page.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
      { timeout: DOWN_MS },
    );
    expect((await hostingStatus(host.page)).code).toBe(code);
    await expect(tab.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
      timeout: DOWN_MS,
    });
  });

  test('someone who joined in the app goes straight back to that room, and can leave it', async () => {
    await appGuest.app.close();
    const back = await runPlainly(guestDir, [
      { state: 'connected' },
      { click: 'Settings' },
      { click: 'Room' },
      { click: 'Leave' },
      { click: 'Leave' },
      { button: 'no such button' },
    ]);
    expect(back).toBe('started again');
    expect(await runPlainly(guestDir, [{ button: 'Join with a code' }])).toBe('done');
  });
});
