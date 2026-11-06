import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  closeModal,
  expectSendingAudio,
  fallBehindThreeTimes,
  joinVoice,
  keepFastEnhancerNodes,
  loudFailures,
  openDiagnostics,
  recordLoudFailures,
  signIn,
  startOnDefaultNoiseMode,
  USERS,
} from './helpers';

const opened: BrowserContext[] = [];

async function freshProfile(browser: Browser, ...scripts: (() => void)[]) {
  const context = await browser.newContext({ permissions: ['microphone'] });
  opened.push(context);
  startOnDefaultNoiseMode(context);
  await context.addInitScript(recordLoudFailures);
  for (const script of scripts) await context.addInitScript(script);
  const page = await context.newPage();
  await signIn(page, USERS.alice);
  return page;
}

function saved(processing: Record<string, unknown>) {
  return async (context: BrowserContext) =>
    context.addInitScript((value) => {
      if (!localStorage.getItem('hostile:voice-prefs'))
        localStorage.setItem('hostile:voice-prefs', value);
    }, JSON.stringify({ processing }));
}

function refuseFastEnhancer() {
  const Native = window.AudioWorkletNode;
  window.AudioWorkletNode = class extends Native {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      if (name === 'fastenhancer-processor') throw new Error('refused by the test');
      super(context, name, options);
    }
  };
}

function noAudioWorklet() {
  Object.defineProperty(window, 'AudioWorkletNode', { value: undefined, configurable: true });
}

async function openVoiceSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Voice & audio' }).click();
  const mode = page.getByTestId('noise-mode');
  await expect(mode).toBeVisible();
  return mode;
}

async function expectSuppression(page: Page, mode: string, failures: string | RegExp) {
  await openDiagnostics(page);
  await expect(page.getByTestId('diag-noise-suppression')).toHaveText(mode, { timeout: 20_000 });
  await expect(page.getByTestId('diag-noise-failures')).toHaveText(failures);
  await closeModal(page);
}

test.describe('noise suppression out of the box', () => {
  test.setTimeout(180_000);
  test.afterEach(async () => {
    for (const context of opened.splice(0)) await context.close().catch(() => undefined);
  });
  test.skip(
    process.env.E2E_LIVEKIT_AVAILABLE !== '1',
    'livekit-server is not available on this machine',
  );

  test('a new profile starts on Strong, and its call runs FastEnhancer', async ({ browser }) => {
    const page = await freshProfile(browser);
    const mode = await openVoiceSettings(page);
    await expect(mode).toHaveValue('strong');
    await expect(mode.locator('option:checked')).toHaveText('Strong (FastEnhancer)');
    await expect(mode.locator('option[value=standard]')).toHaveText('Standard (built-in)');
    await closeModal(page);

    await joinVoice(page, 'General Voice');
    await expectSuppression(page, 'strong (hostile-fastenhancer)', 'none');
    await expectSendingAudio(page);
    expect(await loudFailures(page)).toEqual([]);
  });

  test('a saved choice is kept, whether from before the change or made now', async ({
    browser,
  }) => {
    const context = await browser.newContext({ permissions: ['microphone'] });
    opened.push(context);
    startOnDefaultNoiseMode(context);
    await saved({ echoCancellation: true, noiseMode: 'standard', autoGainControl: true })(context);
    const page = await context.newPage();
    await signIn(page, USERS.alice);
    const mode = await openVoiceSettings(page);
    await expect(mode).toHaveValue('standard');
    await mode.selectOption('enhanced');
    await closeModal(page);

    await page.reload();
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
      timeout: 45_000,
    });
    await expect(await openVoiceSettings(page)).toHaveValue('enhanced');
    await closeModal(page);
    await joinVoice(page, 'General Voice');
    await expectSuppression(page, 'enhanced (hostile-rnnoise)', 'none');
  });

  test('when FastEnhancer cannot start as the default, the call goes to Standard without alarm', async ({
    browser,
  }) => {
    const page = await freshProfile(browser, refuseFastEnhancer);
    await joinVoice(page, 'General Voice');
    await expectSuppression(page, 'standard', /^strong: refused by the test$/);
    await expectSendingAudio(page);
    expect(await loudFailures(page)).toEqual([]);

    const mode = await openVoiceSettings(page);
    await expect(mode).toHaveValue('strong');
    await expect(
      page.getByText(
        'Strong noise suppression did not run on this device (refused by the test), so Standard (built-in) is on for now.',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(page.getByText(/could not start on this device/)).toHaveCount(0);
    await closeModal(page);
    await expect(page.getByTestId('voice-state')).toHaveText('Voice connected');
  });

  test('when the computer cannot keep up with FastEnhancer as the default, it changes quietly too', async ({
    browser,
  }) => {
    const page = await freshProfile(browser, keepFastEnhancerNodes);
    await joinVoice(page, 'General Voice');
    await expectSuppression(page, 'strong (hostile-fastenhancer)', 'none');
    await fallBehindThreeTimes(page);
    await expectSuppression(page, 'standard', 'strong: this computer could not keep up with it');
    await expectSendingAudio(page);
    expect(await loudFailures(page)).toEqual([]);
  });

  test('a Strong that was chosen and cannot start still says so plainly', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['microphone'] });
    opened.push(context);
    startOnDefaultNoiseMode(context);
    await context.addInitScript(recordLoudFailures);
    await context.addInitScript(refuseFastEnhancer);
    await saved({ noiseMode: 'strong', noiseModeChosen: true })(context);
    const page = await context.newPage();
    await signIn(page, USERS.alice);
    await joinVoice(page, 'General Voice');
    await expect.poll(async () => (await loudFailures(page)).length, { timeout: 20_000 }).toBe(1);
    await openVoiceSettings(page);
    await expect(
      page.getByText(/Strong noise suppression could not start on this device/),
    ).toBeVisible();
    await closeModal(page);
    await expectSuppression(page, 'standard', /^strong: refused by the test$/);
  });

  test('where no in-app suppressor can run, a new profile starts on Standard without a word', async ({
    browser,
  }) => {
    const page = await freshProfile(browser, noAudioWorklet);
    const mode = await openVoiceSettings(page);
    await expect(mode).toHaveValue('standard');
    await closeModal(page);
    await joinVoice(page, 'General Voice');
    await expectSuppression(page, 'standard', 'none');
    await expectSendingAudio(page);
    expect(await loudFailures(page)).toEqual([]);
  });
});
