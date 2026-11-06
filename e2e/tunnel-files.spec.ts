import { expect, test } from '@playwright/test';
import { pngFile, REAL_VIDEOS } from './attachment-fixtures';
import { openTextChannel, USERS } from './helpers';
import { joinAndSignIn, startTunnelHost, type TunnelHost } from './tunnel-harness';

const video = { name: 'clip.mp4', mimeType: 'video/mp4', buffer: REAL_VIDEOS.mp4.bytes };

test.describe('files through the tunnel', () => {
  test.setTimeout(180_000);
  let host: TunnelHost;
  test.beforeAll(async () => {
    host = await startTunnelHost();
  });
  test.afterAll(async () => {
    await host.stop();
  });

  test('an image and a video upload, display and seek for another guest', async ({ browser }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const webrtc = await alice.evaluate(() => typeof RTCPeerConnection);
    test.skip(webrtc !== 'function', 'this browser build has no WebRTC, so it cannot join at all');

    await joinAndSignIn(alice, host.code, USERS.alice);
    await joinAndSignIn(bob, host.code, USERS.bob);
    for (const page of [alice, bob]) {
      const list = page.getByRole('button', { name: 'Open channel list' });
      if (await list.isVisible()) await list.click();
      await openTextChannel(page, 'general');
    }

    await expect
      .poll(() => bob.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 })
      .toBe(true);

    await alice
      .locator('input[type=file]')
      .first()
      .setInputFiles(pngFile('through.png', 640, 360, 7));
    const composer = alice.getByLabel('Message #general');
    await composer.click();
    await composer.press('Enter');
    const image = bob.getByRole('log').locator('img[src*="/api/attachments/"]').last();
    await expect(image).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => image.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 20_000 })
      .toBe(640);

    await alice.locator('input[type=file]').first().setInputFiles(video);
    await composer.click();
    await composer.press('Enter');
    const player = bob.getByRole('log').locator('video').last();
    await expect(player).toBeVisible({ timeout: 30_000 });
    const result = await player.evaluate(
      (v: HTMLVideoElement) =>
        new Promise<{ duration: number; seeked: number; error: string | null }>((resolve) => {
          const stop = setTimeout(
            () =>
              resolve({ duration: v.duration, seeked: -1, error: v.error?.message ?? 'timed out' }),
            25_000,
          );
          const go = () => {
            v.addEventListener(
              'seeked',
              () => {
                clearTimeout(stop);
                resolve({ duration: v.duration, seeked: v.currentTime, error: null });
              },
              { once: true },
            );
            v.currentTime = v.duration / 2;
          };
          if (v.readyState >= 1) go();
          else {
            v.addEventListener('loadedmetadata', go, { once: true });
            v.load();
          }
        }),
    );
    expect(result.error).toBeNull();
    expect(result.duration).toBeGreaterThan(0);
    expect(result.seeked).toBeGreaterThan(0);

    const src = await player.evaluate((v: HTMLVideoElement) => v.currentSrc || v.src);
    const ranged = await bob.evaluate(async (url) => {
      const res = await fetch(url, { headers: { Range: 'bytes=2-9' } });
      const body = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, range: res.headers.get('content-range'), length: body.length };
    }, src);
    expect(ranged.status).toBe(206);
    expect(ranged.length).toBe(8);
    expect(ranged.range).toMatch(/^bytes 2-9\//);

    await aliceContext.close();
    await bobContext.close();
  });

  test('a guest whose browser refuses the file worker still joins, and is told why images do not show', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext({ serviceWorkers: 'block' });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const webrtc = await alice.evaluate(() => typeof RTCPeerConnection);
    test.skip(webrtc !== 'function', 'this browser build has no WebRTC, so it cannot join at all');

    await joinAndSignIn(alice, host.code, USERS.alice);
    await joinAndSignIn(bob, host.code, USERS.bob);
    for (const page of [alice, bob]) {
      const list = page.getByRole('button', { name: 'Open channel list' });
      if (await list.isVisible()) await list.click();
      await openTextChannel(page, 'general');
    }
    expect(await bob.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(false);

    await alice
      .locator('input[type=file]')
      .first()
      .setInputFiles([pngFile('first.png', 320, 200, 3), pngFile('second.png', 320, 200, 4)]);
    const composer = alice.getByLabel('Message #general');
    await composer.click();
    await composer.press('Enter');

    const card = bob.getByRole('log').getByTestId('attachment-card').last();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('2 images');
    await expect(card).toContainText('cannot be shown in this tab');

    await card.click({ button: 'right' });
    const items = bob.getByTestId('message-menu').getByRole('menuitem');
    await expect(items.first()).toBeVisible();
    const names = await items.allTextContents();
    for (const hidden of ['Save image', 'Copy image', 'Copy link', 'Copy links']) {
      expect(names).not.toContain(hidden);
    }
    expect(names).toContain('Reply');
    await bob.keyboard.press('Escape');

    await aliceContext.close();
    await bobContext.close();
  });
});
