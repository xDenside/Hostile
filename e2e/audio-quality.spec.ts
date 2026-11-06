import { expect, test } from '@playwright/test';
import { joinVoice, receivedLevel, signIn, USERS } from './helpers';

test('received voice is a clean copy of what was sent', async ({ browser }) => {
  test.setTimeout(180_000);
  test.skip(
    process.env.E2E_LIVEKIT_AVAILABLE !== '1',
    'livekit-server is not available on this machine',
  );
  const aliceContext = await browser.newContext({ permissions: ['microphone'] });
  const bobContext = await browser.newContext({ permissions: ['microphone'] });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await signIn(alice, USERS.alice);
  await signIn(bob, USERS.bob);
  await joinVoice(alice, 'General Voice');
  await joinVoice(bob, 'General Voice');
  await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
  await bob.getByRole('button', { name: 'Mute microphone' }).click();
  await bob.waitForFunction(() => !!document.querySelector('#hostile-audio-sink audio'), null, {
    timeout: 30_000,
  });

  const received = await bob.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const elements = [...document.querySelectorAll<HTMLAudioElement>('#hostile-audio-sink audio')];
    const el = elements[0]!;
    const ctx = new AudioContext();
    await ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 16384;
    analyser.smoothingTimeConstant = 0;
    const silent = ctx.createGain();
    silent.gain.value = 0;
    ctx.createMediaStreamSource(el.srcObject as MediaStream).connect(analyser);
    analyser.connect(silent);
    silent.connect(ctx.destination);
    await sleep(3000);

    const binHz = ctx.sampleRate / analyser.fftSize;
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    const peaks: number[] = [];
    const purity: number[] = [];
    for (let i = 0; i < 30; i++) {
      analyser.getFloatFrequencyData(spectrum);
      let peakBin = 0;
      let peakPower = -Infinity;
      let total = 0;
      for (let b = Math.floor(80 / binHz); b < Math.floor(8000 / binHz); b++) {
        const power = 10 ** (spectrum[b]! / 10);
        total += power;
        if (power > peakPower) {
          peakPower = power;
          peakBin = b;
        }
      }
      let nearPeak = 0;
      const width = Math.ceil(25 / binHz);
      for (let b = peakBin - width; b <= peakBin + width; b++) {
        nearPeak += 10 ** (spectrum[b]! / 10);
      }
      peaks.push(peakBin * binHz);
      purity.push(nearPeak / total);
      await sleep(100);
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const peakMean = mean(peaks);
    return {
      elements: elements.length,
      elementMuted: el.muted,
      binHz,
      peakHz: peakMean,
      peakDriftHz: Math.sqrt(mean(peaks.map((v) => (v - peakMean) ** 2))),
      purity: mean(purity),
    };
  });

  expect(received.elements).toBe(1);
  expect(received.elementMuted).toBe(true);
  expect(Math.abs(received.peakHz - 440)).toBeLessThanOrEqual(received.binHz * 1.5);
  expect(received.peakDriftHz).toBeLessThan(3);
  expect(received.purity).toBeGreaterThan(0.95);

  await aliceContext.close();
  await bobContext.close();
});

test('a muted microphone sends silence, and the icons follow mute and unmute', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  test.skip(
    process.env.E2E_LIVEKIT_AVAILABLE !== '1',
    'livekit-server is not available on this machine',
  );
  const aliceContext = await browser.newContext({ permissions: ['microphone'] });
  const bobContext = await browser.newContext({ permissions: ['microphone'] });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await signIn(alice, USERS.alice);
  await signIn(bob, USERS.bob);
  await joinVoice(alice, 'General Voice');
  await joinVoice(bob, 'General Voice');
  await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
  for (const page of [alice, bob]) {
    await page.waitForFunction(() => !!document.querySelector('#hostile-audio-sink audio'), null, {
      timeout: 30_000,
    });
  }
  const SILENT = 0.002;
  const AUDIBLE = 0.01;

  await expect.poll(() => receivedLevel(bob), { timeout: 20_000 }).toBeGreaterThan(AUDIBLE);
  await expect.poll(() => receivedLevel(alice), { timeout: 20_000 }).toBeGreaterThan(AUDIBLE);

  await bob.getByRole('button', { name: 'Mute microphone' }).click();
  await expect.poll(() => receivedLevel(alice), { timeout: 20_000 }).toBeLessThan(SILENT);
  expect(await receivedLevel(bob)).toBeGreaterThan(AUDIBLE);

  const aliceSidebar = alice.getByRole('navigation', { name: 'Channels' });
  const bobSidebar = bob.getByRole('navigation', { name: 'Channels' });
  const row = (sidebar: typeof aliceSidebar, name: string) =>
    sidebar.getByRole('listitem').filter({ hasText: name });
  await expect(row(aliceSidebar, 'Bob').getByLabel('Muted')).toBeVisible({ timeout: 10_000 });
  await expect(row(bobSidebar, 'Bob').getByLabel('Muted')).toBeVisible({ timeout: 10_000 });

  await bob.getByRole('button', { name: 'Unmute microphone' }).click();
  const PROMPT = { timeout: 1_500 };
  await expect(row(bobSidebar, 'Bob').getByLabel('Muted')).toHaveCount(0, PROMPT);
  await expect(row(aliceSidebar, 'Bob').getByLabel('Muted')).toHaveCount(0, PROMPT);
  await expect(
    alice.getByTestId('participant-tile').filter({ hasText: 'Bob' }).getByLabel('Muted'),
  ).toHaveCount(0, PROMPT);
  await expect.poll(() => receivedLevel(alice), { timeout: 20_000 }).toBeGreaterThan(AUDIBLE);

  await bob.getByRole('button', { name: /^Deafen/ }).click();
  await expect.poll(() => receivedLevel(alice), { timeout: 20_000 }).toBeLessThan(SILENT);

  await aliceContext.close();
  await bobContext.close();
});
