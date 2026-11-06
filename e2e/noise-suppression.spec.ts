import { expect, test, type Page } from '@playwright/test';
import {
  closeModal,
  countSuppressorContexts,
  joinVoice,
  openDiagnostics,
  receivedLevel,
  setMicrophone,
  setNoiseMode,
  signIn,
  suppressorContexts,
  USERS,
} from './helpers';

test.describe('enhanced noise suppression', () => {
  test.setTimeout(300_000);
  test.skip(
    process.env.E2E_LIVEKIT_AVAILABLE !== '1',
    'livekit-server is not available on this machine',
  );

  test('is in the sending path, leaves a steady tone alone, and still obeys mute', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext({ permissions: ['microphone'] });
    const bobContext = await browser.newContext({ permissions: ['microphone'] });
    await countSuppressorContexts(aliceContext);
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
    await expect.poll(() => receivedLevel(bob), { timeout: 30_000 }).toBeGreaterThan(0.01);
    await bob.waitForTimeout(8000);

    await setNoiseMode(alice, 'off');
    await bob.waitForTimeout(8000);
    const off = await stableLevel(bob);

    await setNoiseMode(alice, 'enhanced');
    await bob.waitForTimeout(8000);
    const enhanced = await stableLevel(bob);

    await setNoiseMode(alice, 'standard');
    await bob.waitForTimeout(8000);
    const standard = await stableLevel(bob);

    console.log(
      `received level: off ${off.toFixed(5)}, standard ${standard.toFixed(5)}, ` +
        `enhanced ${enhanced.toFixed(5)} (enhanced/off ${(enhanced / off).toFixed(3)})`,
    );

    await setNoiseMode(alice, 'enhanced');
    await openDiagnostics(alice);
    await expect(alice.getByTestId('diag-noise-suppression')).toHaveText(
      'enhanced (hostile-rnnoise)',
      { timeout: 20_000 },
    );
    await closeModal(alice);

    const ratio = enhanced / off;
    expect(ratio, `enhanced ${enhanced} vs unsuppressed ${off}`).toBeGreaterThan(0.8);
    expect(ratio, `enhanced ${enhanced} vs unsuppressed ${off}`).toBeLessThan(1.25);
    expect(standard).toBeLessThan(off * 0.5);

    await openDiagnostics(bob);
    const samples = async () =>
      Number((await bob.getByTestId('diag-audio-samples').first().textContent()) ?? '0');
    const before = await samples();
    await expect.poll(samples, { timeout: 20_000 }).toBeGreaterThan(before);
    await closeModal(bob);
    await expect(alice.getByTestId('voice-state')).toHaveText('Voice connected');

    await alice.getByRole('button', { name: 'Mute microphone' }).click();
    await expect.poll(() => receivedLevel(bob), { timeout: 20_000 }).toBeLessThan(0.002);

    await setNoiseMode(alice, 'standard');
    await expect(alice.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    await expect(alice.getByTestId('voice-state')).toHaveText('Voice connected');
    expect(await receivedLevel(bob)).toBeLessThan(0.002);
    await setNoiseMode(alice, 'enhanced');
    await expect(alice.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    await expect(alice.getByTestId('voice-state')).toHaveText('Voice connected');
    await expect(
      bob.getByTestId('participant-tile').filter({ hasText: 'Alice' }).getByLabel('Muted'),
    ).toBeVisible({ timeout: 20_000 });
    expect(await receivedLevel(bob)).toBeLessThan(0.002);

    await alice.getByRole('button', { name: 'Unmute microphone' }).click();
    await expect.poll(() => receivedLevel(bob), { timeout: 30_000 }).toBeGreaterThan(0.005);

    await setMicrophone(alice, 'Fake Audio Input 2');
    await openDiagnostics(alice);
    await expect(alice.getByTestId('diag-noise-suppression')).toHaveText(
      'enhanced (hostile-rnnoise)',
      { timeout: 20_000 },
    );
    await closeModal(alice);
    await expect.poll(() => receivedLevel(bob), { timeout: 30_000 }).toBeGreaterThan(0.005);
    const afterSwitch = await stableLevel(bob);
    console.log(
      `received level after a device switch: ${afterSwitch.toFixed(5)} ` +
        `(${(afterSwitch / off).toFixed(3)} of unsuppressed)`,
    );
    expect(afterSwitch / off, 'still unhalved after the device switch').toBeGreaterThan(0.75);

    await alice.getByRole('button', { name: /^Deafen/ }).click();
    await expect.poll(() => receivedLevel(bob), { timeout: 20_000 }).toBeLessThan(0.002);
    await alice.getByRole('button', { name: 'Undeafen' }).click();
    await expect.poll(() => receivedLevel(bob), { timeout: 30_000 }).toBeGreaterThan(0.005);

    const contexts = await suppressorContexts(alice);
    console.log(`suppressor audio contexts: ${contexts.join(', ')}`);
    expect(contexts.filter((state) => state !== 'closed')).toHaveLength(1);

    await aliceContext.close();
    await bobContext.close();
  });

  test('rapid mode changes end in the state the interface shows', async ({ browser }) => {
    const aliceContext = await browser.newContext({ permissions: ['microphone'] });
    const bobContext = await browser.newContext({ permissions: ['microphone'] });
    await countSuppressorContexts(aliceContext);
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

    await alice.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await alice.getByRole('button', { name: 'Voice & audio' }).click();
    const mode = alice.getByTestId('noise-mode');
    await mode.selectOption('enhanced');
    await mode.selectOption('standard');
    await mode.selectOption('enhanced');
    await alice.getByRole('switch', { name: 'Automatic gain control' }).click();
    await expect(mode).toBeEnabled({ timeout: 30_000 });
    await expect(mode).toHaveValue('enhanced');
    await expect(alice.getByRole('switch', { name: 'Automatic gain control' })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    await alice.getByRole('button', { name: 'Diagnostics' }).click();
    await expect(alice.getByTestId('diag-noise-suppression')).toHaveText(
      'enhanced (hostile-rnnoise)',
      { timeout: 20_000 },
    );
    await closeModal(alice);
    const contexts = await suppressorContexts(alice);
    console.log(`suppressor audio contexts after rapid switching: ${contexts.join(', ')}`);
    expect(contexts.filter((state) => state !== 'closed')).toHaveLength(1);
    await expect.poll(() => receivedLevel(bob), { timeout: 30_000 }).toBeGreaterThan(0.005);
    await expect(alice.getByText(/Enhanced noise suppression could not start/i)).toHaveCount(0);

    await aliceContext.close();
    await bobContext.close();
  });

  test('leaving during a switch leaves no suppressor behind', async ({ browser }) => {
    const aliceContext = await browser.newContext({ permissions: ['microphone'] });
    await countSuppressorContexts(aliceContext);
    const alice = await aliceContext.newPage();
    const { promise: building, resolve: buildStarted } = Promise.withResolvers<void>();
    await alice.route('**/*rnnoise*.wasm*', async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      buildStarted();
      await new Promise((r) => setTimeout(r, 4000));
      return route.continue();
    });
    await signIn(alice, USERS.alice);
    await joinVoice(alice, 'General Voice');

    await alice.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await alice.getByRole('button', { name: 'Voice & audio' }).click();
    await alice.getByTestId('noise-mode').selectOption('enhanced');
    await closeModal(alice);
    await building;
    await alice.getByRole('button', { name: 'Leave voice' }).click();
    await expect(alice.getByTestId('voice-state')).toHaveCount(0, { timeout: 20_000 });

    await expect
      .poll(async () => (await suppressorContexts(alice)).join(','), { timeout: 30_000 })
      .toBe('closed');
    await expect(alice.getByText(/Enhanced noise suppression could not start/i)).toHaveCount(0);

    await aliceContext.close();
  });

  test('the microphone test runs the suppressor outside a call', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['microphone'] });
    await countSuppressorContexts(context);
    const page = await context.newPage();
    await signIn(page, USERS.alice);
    await setNoiseMode(page, 'enhanced');
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('button', { name: 'Voice & audio' }).click();
    for (const attempt of [1, 2]) {
      await page.getByRole('button', { name: 'Test microphone' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Picking up sound' })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(/Enhanced noise suppression could not start/i)).toHaveCount(0);
      await page.getByRole('button', { name: 'Stop test' }).click();
      await expect
        .poll(async () => (await suppressorContexts(page)).join(','), { timeout: 20_000 })
        .toBe(new Array(attempt).fill('closed').join(','));
    }
    await page.getByRole('button', { name: 'Test microphone' }).click();
    await closeModal(page);
    await expect
      .poll(async () => (await suppressorContexts(page)).filter((s) => s !== 'closed').length, {
        timeout: 20_000,
      })
      .toBe(0);
    await context.close();
  });

  test('says so and keeps the microphone alive when the suppressor cannot load', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext({ permissions: ['microphone'] });
    const bobContext = await browser.newContext({ permissions: ['microphone'] });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await alice.route('**/*rnnoise*.wasm*', (route) =>
      route.request().resourceType() === 'fetch' ? route.abort() : route.continue(),
    );
    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);
    await joinVoice(alice, 'General Voice');
    await joinVoice(bob, 'General Voice');
    await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
    await bob.getByRole('button', { name: 'Mute microphone' }).click();
    await bob.waitForFunction(() => !!document.querySelector('#hostile-audio-sink audio'), null, {
      timeout: 30_000,
    });

    await setNoiseMode(alice, 'enhanced');
    await expect(
      alice.getByText(/Enhanced noise suppression could not start/i).first(),
    ).toBeVisible({ timeout: 20_000 });
    await alice.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await alice.getByRole('button', { name: 'Voice & audio' }).click();
    await expect(alice.getByTestId('noise-mode')).toHaveValue('enhanced');
    await expect(
      alice.getByText(/Enhanced noise suppression could not start on this device/i),
    ).toBeVisible();
    await alice.getByRole('button', { name: 'Diagnostics' }).click();
    await expect(alice.getByTestId('diag-noise-suppression')).toHaveText('standard', {
      timeout: 20_000,
    });
    await closeModal(alice);

    await expect(alice.getByTestId('voice-state')).toHaveText('Voice connected');
    await expect.poll(() => receivedLevel(bob), { timeout: 30_000 }).toBeGreaterThan(0.01);

    await aliceContext.close();
    await bobContext.close();
  });
});

async function stableLevel(page: Page): Promise<number> {
  let sum = 0;
  for (let i = 0; i < 3; i++) sum += await receivedLevel(page);
  return sum / 3;
}
