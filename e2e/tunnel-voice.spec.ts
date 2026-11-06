import { expect, test } from '@playwright/test';
import { joinVoice, receivedLevel, USERS } from './helpers';
import { joinAndSignIn, startTunnelHost, watchForLeaks, type TunnelHost } from './tunnel-harness';

test.describe('calls through the tunnel', () => {
  test.setTimeout(240_000);
  test.skip(process.env.E2E_LIVEKIT_AVAILABLE !== '1', 'livekit-server is not available');
  let host: TunnelHost;
  test.beforeAll(async () => {
    host = await startTunnelHost();
  });
  test.afterAll(async () => {
    await host.stop();
  });

  test('two guests talk and share a screen, with signalling over the data channel', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext({ permissions: ['microphone'] });
    const bobContext = await browser.newContext({ permissions: ['microphone'] });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const leaks = [alice, bob].map(watchForLeaks);
    const sockets: string[] = [];
    for (const page of [alice, bob]) page.on('websocket', (ws) => sockets.push(ws.url()));

    await joinAndSignIn(alice, host.code, USERS.alice);
    await joinAndSignIn(bob, host.code, USERS.bob);
    await joinVoice(alice, 'General Voice');
    await joinVoice(bob, 'General Voice');
    await expect(alice.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
    await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });

    await expect.poll(() => receivedLevel(bob), { timeout: 30_000 }).toBeGreaterThan(0.005);
    await expect.poll(() => receivedLevel(alice), { timeout: 30_000 }).toBeGreaterThan(0.005);

    await alice.getByRole('button', { name: 'Share your screen' }).click();
    await alice.getByRole('button', { name: 'Start sharing' }).click();
    await expect(alice.getByTestId('share-video-local')).toBeVisible({ timeout: 30_000 });
    await expect(bob.getByTestId('share-video-remote')).toBeVisible({ timeout: 30_000 });
    const frames = await bob
      .getByTestId('share-video-remote')
      .evaluate(async (v: HTMLVideoElement) => {
        await new Promise((r) => setTimeout(r, 4000));
        return v.getVideoPlaybackQuality().totalVideoFrames;
      });
    expect(frames, 'decoded screen-share frames').toBeGreaterThan(0);

    const direct = sockets.filter(
      (url) => !url.includes(':5292') && !url.includes('/@vite') && !url.includes(':5291'),
    );
    expect(direct, 'WebSockets that left the page for anything but the rendezvous').toEqual([]);
    expect(leaks.flat()).toEqual([]);
    await alice.getByRole('button', { name: 'Stop sharing your screen' }).click();
    await aliceContext.close();
    await bobContext.close();
  });
});
