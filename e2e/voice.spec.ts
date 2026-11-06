import { expect, test, type Page } from '@playwright/test';
import { closeModal, joinVoice, openDiagnostics, openTextChannel, signIn, USERS } from './helpers';

test.describe('voice and screen sharing', () => {
  test.setTimeout(240_000);
  test.skip(
    process.env.E2E_LIVEKIT_AVAILABLE !== '1',
    'livekit-server is not available on this machine',
  );

  test('two users exchange audio, share a screen, mute, deafen and leave cleanly', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext({ permissions: ['microphone'] });
    const bobContext = await browser.newContext({ permissions: ['microphone'] });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);

    await joinVoice(alice, 'General Voice');
    await joinVoice(bob, 'General Voice');

    await expect(alice.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
    await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });

    await openDiagnostics(alice);
    await openDiagnostics(bob);
    await expectIncomingAudio(alice);
    await expectIncomingAudio(bob);

    await expect(alice.getByTestId('diag-candidate')).not.toHaveText('not established');
    await closeModal(bob);

    await closeModal(alice);
    await startScreenShare(alice);
    await expect(bob.getByTestId('share-video-remote')).toBeVisible({ timeout: 30_000 });
    await expectIncomingVideo(bob);

    await alice.getByRole('button', { name: 'Stop sharing your screen' }).click();
    await expect(bob.getByTestId('share-video-remote')).toHaveCount(0, { timeout: 20_000 });
    await expect(alice.getByTestId('voice-state')).toHaveText('Voice connected');
    await expect(bob.getByTestId('voice-state')).toHaveText('Voice connected');

    const signal = alice.getByTestId('connection-signal');
    await expect(signal).toHaveAttribute('data-quality', /^(excellent|good|poor)$/, {
      timeout: 30_000,
    });
    await expect(signal).toHaveAttribute('aria-label', /^Connection: /);

    await alice.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(
      bob.getByTestId('participant-tile').filter({ hasText: 'Alice' }).getByLabel('Muted'),
    ).toBeVisible({
      timeout: 20_000,
    });
    await alice.getByRole('button', { name: 'Unmute microphone' }).click();

    await bob.getByRole('button', { name: /^Deafen/ }).click();
    await expect(bob.getByRole('button', { name: 'Undeafen' })).toBeVisible();
    await expect(bob.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    await expect(
      alice.getByTestId('participant-tile').filter({ hasText: 'Bob' }).getByLabel('Deafened'),
    ).toBeVisible({
      timeout: 20_000,
    });
    await bob.getByRole('button', { name: 'Undeafen' }).click();
    await expect(bob.getByRole('button', { name: 'Mute microphone' })).toBeVisible();

    await openTextChannel(alice, 'general');
    await expect(alice.getByTestId('voice-state')).toHaveText('Voice connected');
    await expect(alice.getByLabel('Message #general')).toBeVisible();

    await alice.getByRole('button', { name: 'Leave voice' }).click();
    await expect(alice.getByTestId('voice-state')).toHaveCount(0);
    await expect(bob.getByTestId('participant-tile')).toHaveCount(1, { timeout: 30_000 });

    await aliceContext.close();
    await bobContext.close();
  });

  test('moving to another channel while the microphone is still opening still publishes it', async ({
    browser,
  }) => {
    const bobContext = await browser.newContext({ permissions: ['microphone'] });
    const bob = await bobContext.newPage();
    await signIn(bob, USERS.bob);
    await joinVoice(bob, 'Gaming Voice');

    const aliceContext = await browser.newContext({ permissions: ['microphone'] });
    await aliceContext.addInitScript(() => {
      const devices = navigator.mediaDevices;
      const open = devices.getUserMedia.bind(devices);
      let slow = true;
      devices.getUserMedia = async (constraints) => {
        if (slow && constraints?.audio) {
          slow = false;
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        return open(constraints);
      };
    });
    const alice = await aliceContext.newPage();
    await signIn(alice, USERS.alice);
    await alice.getByRole('button', { name: /^General Voice/ }).click();
    await expect(alice.getByTestId('voice-state')).toHaveText('Voice connected', {
      timeout: 30_000,
    });
    await alice.getByRole('button', { name: /^Gaming Voice/ }).click();
    await expect(alice.getByTestId('voice-state')).toHaveText('Voice connected', {
      timeout: 30_000,
    });

    await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
    await openDiagnostics(bob);
    await expectIncomingAudio(bob);

    await aliceContext.close();
    await bobContext.close();
  });

  test('the same account joining twice moves the call to the newest window', async ({
    browser,
  }) => {
    const context = await browser.newContext({ permissions: ['microphone'] });
    const first = await context.newPage();
    await signIn(first, USERS.alice);
    await joinVoice(first, 'General Voice');

    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
      { timeout: 20_000 },
    );
    await joinVoice(second, 'General Voice');

    await expect(
      first.getByText(/joined voice from another window or device/i).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(second.getByTestId('voice-state')).toHaveText('Voice connected');

    await context.close();
  });
});

async function expectIncomingAudio(page: Page) {
  await expect(async () => {
    const rows = page.getByTestId('diag-remote');
    await expect(rows).not.toHaveCount(0);
    const row = rows.first();
    const bytes = Number((await row.getByTestId('diag-audio-bytes').textContent()) ?? '0');
    const samples = Number((await row.getByTestId('diag-audio-samples').textContent()) ?? '0');
    const level = Number((await row.getByTestId('diag-audio-level').textContent()) ?? '0');
    expect(bytes, 'inbound audio bytes').toBeGreaterThan(0);
    expect(samples, 'decoded audio samples').toBeGreaterThan(0);
    expect(level, 'speech level measured by the media server').toBeGreaterThan(0);
  }).toPass({ timeout: 45_000 });
}

async function expectIncomingVideo(page: Page) {
  await openDiagnostics(page);
  await expect(async () => {
    const frames = Number(
      (await page.getByTestId('diag-video-frames').first().textContent()) ?? '0',
    );
    expect(frames, 'decoded screen-share frames').toBeGreaterThan(0);
  }).toPass({ timeout: 45_000 });
  await closeModal(page);
}

async function startScreenShare(page: Page) {
  await page.getByRole('button', { name: 'Share your screen' }).click();
  await page.getByRole('button', { name: 'Start sharing' }).click();
  await expect(page.getByTestId('share-video-local')).toBeVisible({ timeout: 30_000 });
}
