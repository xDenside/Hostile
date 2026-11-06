import { expect, test } from '@playwright/test';
import {
  closeModal,
  joinVoice,
  openDiagnostics,
  percentile,
  receivedEnvelope,
  setNoiseMode,
  signIn,
  USERS,
} from './helpers';

test.describe('in-app noise suppression against speech in noise', () => {
  test.setTimeout(240_000);
  test.skip(
    process.env.E2E_LIVEKIT_AVAILABLE !== '1',
    'livekit-server is not available on this machine',
  );

  test('drops the noise between words and keeps the words', async ({ browser }) => {
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
    await bob.waitForTimeout(8000);

    const measure = async () => {
      const series = await receivedEnvelope(bob, 10);
      return { floor: percentile(series, 0.1), speech: percentile(series, 0.9) };
    };

    const standard = await measure();
    await setNoiseMode(alice, 'enhanced');
    await bob.waitForTimeout(8000);
    const enhanced = await measure();

    await setNoiseMode(alice, 'strong');
    await openDiagnostics(alice);
    await expect(alice.getByTestId('diag-noise-suppression')).toHaveText(
      'strong (hostile-fastenhancer)',
      { timeout: 20_000 },
    );
    await closeModal(alice);
    await bob.waitForTimeout(8000);
    const strong = await measure();

    const report = (name: string, m: { floor: number; speech: number }) =>
      `${name} floor ${m.floor.toFixed(5)} speech ${m.speech.toFixed(5)} (speech ` +
      `${(m.speech / standard.speech).toFixed(3)} of standard, floor ` +
      `${(standard.floor / m.floor).toFixed(1)}x quieter)`;
    console.log(
      `speech in noise: standard floor ${standard.floor.toFixed(5)} speech ` +
        `${standard.speech.toFixed(5)}; ${report('enhanced', enhanced)}; ${report('strong', strong)}`,
    );

    expect(enhanced.floor, 'noise floor in the pauses').toBeLessThan(standard.floor / 5);
    expect(enhanced.speech, 'loudness of the speech itself').toBeGreaterThan(standard.speech * 0.8);
    const standardRatio = standard.speech / standard.floor;
    const enhancedRatio = enhanced.speech / enhanced.floor;
    expect(enhancedRatio, 'speech-to-noise ratio').toBeGreaterThan(standardRatio * 5);

    expect(strong.floor, 'strong: noise floor in the pauses').toBeLessThan(standard.floor / 50);
    expect(strong.speech, 'strong: loudness of the speech itself').toBeGreaterThan(
      standard.speech * 0.8,
    );
    expect(strong.speech / strong.floor, 'strong: speech-to-noise ratio').toBeGreaterThan(
      standardRatio * 50,
    );

    await aliceContext.close();
    await bobContext.close();
  });
});
