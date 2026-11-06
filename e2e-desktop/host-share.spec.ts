import { chromium, expect, test } from '@playwright/test';
import { joinVoice } from '../e2e/helpers';
import {
  GUEST_URL,
  hostFirstRun,
  joinThroughHost,
  launch,
  newUserDir,
  removeDir,
} from './host-harness';

const OWNER = { displayName: 'Room Host' };
const TAB = { displayName: 'Tab' };

test('the host shares its screen from the app, and a guest in a tab decodes it', async () => {
  test.setTimeout(240_000);
  const dir = newUserDir('share');
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const host = await launch(dir);
  try {
    test.skip(
      (await host.app.evaluate(
        () => (globalThis as unknown as { __screenAccess: string }).__screenAccess,
      )) !== 'granted',
      'This Mac has not granted Screen Recording to this app.',
    );
    const code = await hostFirstRun(host, OWNER);
    await host.page.keyboard.press('Escape');
    const tab = await (await browser.newContext()).newPage();
    await tab.goto(GUEST_URL);
    await joinThroughHost(host.page, tab, code, TAB.displayName);
    await joinVoice(host.page, 'General Voice');
    await joinVoice(tab, 'General Voice');
    await host.page.getByRole('button', { name: 'Share your screen' }).click();
    await host.page.getByRole('button', { name: 'Start sharing' }).click();
    const remote = tab.getByTestId('share-video-remote');
    await expect(remote).toBeVisible({ timeout: 45_000 });
    const frames = await remote.evaluate(async (v: HTMLVideoElement) => {
      await new Promise((r) => setTimeout(r, 4_000));
      return v.getVideoPlaybackQuality().totalVideoFrames;
    });
    expect(frames, 'decoded screen-share frames').toBeGreaterThan(0);
  } finally {
    await browser.close().catch(() => undefined);
    await host.app.close().catch(() => undefined);
    removeDir(dir);
  }
});
