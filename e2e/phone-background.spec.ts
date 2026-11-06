import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  closeModal,
  expectSendingAudio,
  fallBehindThreeTimes,
  joinVoice,
  keepFastEnhancerNodes,
  loudFailures,
  openDiagnostics,
  receivedLevel,
  recordLoudFailures,
  setNoiseMode,
  signIn,
  startOnDefaultNoiseMode,
  USERS,
} from './helpers';

const AGENTS = {
  iPhone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  iPad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  Android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
} as const;
type Phone = keyof typeof AGENTS;

const SILENT = 0.002;
const AUDIBLE = 0.01;

interface Speaker {
  webAudio: number;
  element: number;
  paths: number;
  contexts: string[];
}

interface PhonePage {
  background(options?: { everything?: boolean }): void;
  foreground(): void;
  unstick(): void;
  speaker(): Speaker;
  errors: string[];
}

function pretend(device: Phone | 'computer') {
  const webKit = device === 'iPhone' || device === 'iPad';
  const Native = window.AudioContext;
  let hidden = false;
  const stopped = new Set<AudioContext>();
  const made: AudioContext[] = [];
  const taps = new Map<AudioContext, AnalyserNode>();
  let refuseStuck = false;
  const nativeConnect = AudioNode.prototype.connect as (...args: unknown[]) => unknown;
  const nativeSuspend = Native.prototype.suspend;
  const nativeResume = Native.prototype.resume;

  class Tracked extends Native {
    constructor(options?: AudioContextOptions) {
      super(options);
      made.push(this);
    }
  }
  window.AudioContext = Tracked as unknown as typeof AudioContext;

  const stop = (ctx: AudioContext) => {
    if (ctx.state !== 'running') return;
    stopped.add(ctx);
    void nativeSuspend.call(ctx);
  };

  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const target = args[0];
    if (target instanceof AudioDestinationNode) {
      const ctx = target.context as AudioContext;
      let tap = taps.get(ctx);
      if (!tap) {
        tap = ctx.createAnalyser();
        tap.fftSize = 2048;
        taps.set(ctx, tap);
      }
      nativeConnect.call(this, tap);
      if (hidden && webKit) stop(ctx);
    }
    return nativeConnect.apply(this, args);
  } as typeof AudioNode.prototype.connect;

  Native.prototype.resume = function (this: AudioContext) {
    if (stopped.has(this)) return new Promise<void>(() => undefined);
    return nativeResume.call(this);
  };

  Object.defineProperty(document, 'visibilityState', {
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  Object.defineProperty(document, 'hidden', { get: () => hidden });

  if (device === 'iPhone') {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      get: () => 1,
      set: () => undefined,
    });
  }
  if (device === 'iPad') {
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 });
  }

  let probe: AudioContext | null = null;
  const elementTaps = new Map<HTMLMediaElement, { stream: unknown; analyser: AnalyserNode }>();
  const rms = (analyser: AnalyserNode) => {
    const frame = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(frame);
    return Math.sqrt(frame.reduce((sum, v) => sum + v * v, 0) / frame.length);
  };

  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

  (window as unknown as { __phone: PhonePage }).__phone = {
    errors,
    background(options) {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      for (const ctx of made) {
        if (options?.everything || (webKit && taps.has(ctx))) stop(ctx);
      }
      refuseStuck = !!options?.everything;
    },
    foreground() {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      if (!refuseStuck) {
        for (const ctx of stopped) void nativeResume.call(ctx);
        stopped.clear();
      }
    },
    unstick() {
      refuseStuck = false;
      for (const ctx of [...stopped]) {
        if (!hidden || !webKit || !taps.has(ctx)) stopped.delete(ctx);
      }
    },
    speaker() {
      probe ??= new Native();
      void nativeResume.call(probe);
      let webAudio = 0;
      for (const [ctx, tap] of taps) {
        if (ctx.state === 'running') webAudio = Math.max(webAudio, rms(tap));
      }
      let element = 0;
      for (const el of document.querySelectorAll<HTMLAudioElement>('#hostile-audio-sink audio')) {
        let tap = elementTaps.get(el);
        if (!tap || tap.stream !== el.srcObject) {
          const analyser = probe.createAnalyser();
          analyser.fftSize = 2048;
          if (el.srcObject) {
            const source = probe.createMediaStreamSource(el.srcObject as MediaStream);
            nativeConnect.call(source, analyser);
          }
          tap = { stream: el.srcObject, analyser };
          elementTaps.set(el, tap);
        }
        if (!el.paused && !el.muted && el.volume > 0) {
          element = Math.max(element, rms(tap.analyser) * el.volume);
        }
      }
      return {
        webAudio,
        element,
        paths: [webAudio, element].filter((level) => level > 0.002).length,
        contexts: made.map((c) => c.state as string),
      };
    },
  };
}

function silenceRnnoise() {
  const Native = window.AudioWorkletNode;
  const silenced = new WeakSet<AudioNode>();
  window.AudioWorkletNode = class extends Native {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options);
      if (name === '@sapphi-red/web-noise-suppressor/rnnoise') silenced.add(this);
    }
  };
  const connect = AudioNode.prototype.connect as (...args: unknown[]) => unknown;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    if (!silenced.has(this)) return connect.apply(this, args);
    const nothing = this.context.createGain();
    nothing.gain.value = 0;
    connect.call(this, nothing);
    return connect.apply(nothing, args);
  } as typeof AudioNode.prototype.connect;
}

const speaker = (page: Page) =>
  page.evaluate(() => (window as unknown as { __phone: PhonePage }).__phone.speaker());

async function loudness(page: Page) {
  let loudest = 0;
  let paths = 0;
  for (let i = 0; i < 8; i++) {
    const now = await speaker(page);
    loudest = Math.max(loudest, now.webAudio, now.element);
    paths = Math.max(paths, now.paths);
    await page.waitForTimeout(200);
  }
  return { loudest, paths };
}

const expectHeard = (page: Page, what: string) =>
  expect
    .poll(async () => (await loudness(page)).loudest, { message: what, timeout: 20_000 })
    .toBeGreaterThan(AUDIBLE);

const expectSilence = (page: Page, what: string) =>
  expect
    .poll(async () => (await loudness(page)).loudest, { message: what, timeout: 10_000 })
    .toBeLessThan(SILENT);

async function expectPlayedOnce(page: Page, what: string) {
  await expectHeard(page, what);
  expect((await loudness(page)).paths, `${what}: played once, not doubled`).toBe(1);
}

const backgrounded = (page: Page, options?: { everything?: boolean }) =>
  page.evaluate(
    (opts) => (window as unknown as { __phone: PhonePage }).__phone.background(opts),
    options,
  );
const returned = (page: Page) =>
  page.evaluate(() => (window as unknown as { __phone: PhonePage }).__phone.foreground());
const unstuck = (page: Page) =>
  page.evaluate(() => (window as unknown as { __phone: PhonePage }).__phone.unstick());

const opened: BrowserContext[] = [];

async function newContext(browser: Browser, options: Parameters<Browser['newContext']>[0]) {
  const context = await browser.newContext(options);
  opened.push(context);
  return context;
}

async function inACall(browser: Browser, phone: Phone, options?: { defaultNoiseMode?: boolean }) {
  const aliceContext = await newContext(browser, { permissions: ['microphone'] });
  const bobContext = await newContext(browser, {
    permissions: ['microphone'],
    userAgent: AGENTS[phone],
    ...(phone === 'iPad' && { screen: { width: 820, height: 1180 } }),
  });
  await bobContext.addInitScript(pretend, phone);
  if (options?.defaultNoiseMode) {
    startOnDefaultNoiseMode(bobContext);
    await bobContext.addInitScript(keepFastEnhancerNodes);
    await bobContext.addInitScript(recordLoudFailures);
  }
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await signIn(alice, USERS.alice);
  await signIn(bob, USERS.bob);
  return { alice, bob, aliceContext, bobContext };
}

async function join({ alice, bob }: { alice: Page; bob: Page }) {
  await joinVoice(alice, 'General Voice');
  await joinVoice(bob, 'General Voice');
  await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
  await alice.waitForFunction(() => !!document.querySelector('#hostile-audio-sink audio'), null, {
    timeout: 30_000,
  });
  await bob.waitForFunction(() => !!document.querySelector('#hostile-audio-sink audio'), null, {
    timeout: 30_000,
  });
  await expect.poll(() => receivedLevel(alice), { timeout: 20_000 }).toBeGreaterThan(AUDIBLE);
}

const aliceRow = (page: Page) =>
  page.getByRole('navigation', { name: 'Channels' }).getByRole('listitem').filter({
    hasText: 'Alice',
  });

test.describe('a phone in a call with its browser in the background', () => {
  test.setTimeout(240_000);
  test.afterEach(async () => {
    for (const context of opened.splice(0)) await context.close().catch(() => undefined);
  });
  test.skip(
    process.env.E2E_LIVEKIT_AVAILABLE !== '1',
    'livekit-server is not available on this machine',
  );

  for (const phone of Object.keys(AGENTS) as Phone[]) {
    test(`${phone}: both directions keep working, and the sound is still right on the return`, async ({
      browser,
    }) => {
      const call = await inACall(browser, phone);
      const { alice, bob } = call;
      await join(call);
      await expectPlayedOnce(bob, 'in the foreground');

      await backgrounded(bob);
      await bob.waitForTimeout(3000);
      await expectHeard(bob, 'the phone hears the others from the background');
      await expect.poll(() => receivedLevel(alice), { timeout: 20_000 }).toBeGreaterThan(AUDIBLE);
      await expect(bob.getByTestId('voice-state')).toHaveText('Voice connected');

      await returned(bob);
      await expectPlayedOnce(bob, 'after coming back');
      await expect.poll(() => receivedLevel(alice), { timeout: 20_000 }).toBeGreaterThan(AUDIBLE);
      await expect(bob.getByRole('button', { name: 'Enable audio' })).toHaveCount(0);

      expect(
        await bob.evaluate(() => (window as unknown as { __phone: PhonePage }).__phone.errors),
      ).toEqual([]);
      await call.aliceContext.close();
      await call.bobContext.close();
    });

    test(`${phone}: deafen and mute do what the screen says, in the background too`, async ({
      browser,
    }) => {
      const call = await inACall(browser, phone);
      const { alice, bob } = call;
      await join(call);
      await expectPlayedOnce(bob, 'before anything is changed');

      await bob.getByRole('button', { name: /^Deafen/ }).click();
      await expectSilence(bob, 'deafened');
      await backgrounded(bob);
      await bob.waitForTimeout(1500);
      await expectSilence(bob, 'deafened in the background');
      await returned(bob);
      await expectSilence(bob, 'deafened after coming back');

      await alice.getByRole('button', { name: 'Mute microphone' }).click();
      await expect(
        bob.getByTestId('participant-tile').filter({ hasText: 'Alice' }).getByLabel('Muted'),
      ).toBeVisible({ timeout: 20_000 });
      await alice.getByRole('button', { name: 'Unmute microphone' }).click();
      await expect(
        bob.getByTestId('participant-tile').filter({ hasText: 'Alice' }).getByLabel('Muted'),
      ).toHaveCount(0, { timeout: 20_000 });
      await expectSilence(bob, 'deafened while the other person unmuted');

      await bob.getByRole('button', { name: 'Undeafen' }).click();
      await expectPlayedOnce(bob, 'undeafened');

      await aliceRow(bob).click({ button: 'right' });
      const menu = bob.getByTestId('member-menu');
      await expect(menu).toBeVisible();
      const slider = menu.getByRole('slider', { name: 'User volume' });
      if (phone === 'iPhone') {
        await expect(slider).toHaveCount(0);
      } else {
        await expect(slider).toHaveAttribute('max', phone === 'iPad' ? '1' : '2');
        await slider.fill('0.5');
        await expect(menu.getByTestId('user-volume')).toContainText('50%');
        await expect
          .poll(async () => (await loudness(bob)).loudest, { timeout: 15_000 })
          .toBeGreaterThan(AUDIBLE / 4);
        await slider.fill('1');
      }
      await menu.getByRole('menuitem', { name: /^Mute .* for me$/ }).click();
      await expectSilence(bob, 'muted for me');
      await backgrounded(bob);
      await expectSilence(bob, 'muted for me in the background');
      await returned(bob);
      await bob.keyboard.press('Escape');
      await aliceRow(bob).click({ button: 'right' });
      await menu.getByRole('menuitem', { name: /^Unmute .* for me$/ }).click();
      await bob.keyboard.press('Escape');
      await expectPlayedOnce(bob, 'unmuted for me');

      await call.aliceContext.close();
      await call.bobContext.close();
    });
  }

  for (const phone of ['iPhone', 'Android'] as const) {
    test(`${phone}: a frozen page stays in the call, reconnects, and the sound comes back`, async ({
      browser,
    }) => {
      const call = await inACall(browser, phone);
      const { alice, bob, bobContext } = call;
      await join(call);
      await expectPlayedOnce(bob, 'before the freeze');

      const cdp = await bobContext.newCDPSession(bob);
      await cdp.send('Page.enable');
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      await alice.waitForTimeout(30_000);
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });

      await expect(bob.getByTestId('voice-state')).toHaveText('Voice connected', {
        timeout: 60_000,
      });
      await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
      await expectPlayedOnce(bob, 'after the freeze and the reconnect');
      await expect.poll(() => receivedLevel(alice), { timeout: 30_000 }).toBeGreaterThan(AUDIBLE);

      await call.aliceContext.close();
      await call.bobContext.close();
    });
  }

  test('Android: the output device can still be changed, and the voice follows', async ({
    browser,
  }) => {
    const call = await inACall(browser, 'Android');
    const { bob } = call;
    await join(call);
    await bob.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await bob.getByRole('button', { name: 'Voice & audio' }).click();
    const output = bob.getByRole('combobox', { name: 'Output' });
    const options = await output.locator('option').allTextContents();
    test.skip(options.length < 2, 'This browser offers a single output device.');
    await output.selectOption({ label: options.at(-1)! });
    await closeModal(bob);
    await expectPlayedOnce(bob, 'after changing the output device');
    await call.aliceContext.close();
    await call.bobContext.close();
  });

  for (const phone of ['iPhone', 'iPad'] as const) {
    test(`${phone}: a stream's volume goes no further than the device can honour`, async ({
      browser,
    }) => {
      const call = await inACall(browser, phone);
      const { alice, bob } = call;
      await join(call);
      await alice.evaluate(() => {
        const devices = navigator.mediaDevices;
        const capture = devices.getDisplayMedia.bind(devices);
        devices.getDisplayMedia = async (options) => {
          const stream = await capture({ ...options, audio: false });
          const ctx = new AudioContext();
          const destination = ctx.createMediaStreamDestination();
          const tone = ctx.createOscillator();
          tone.connect(destination);
          tone.start();
          for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
          return stream;
        };
      });
      await alice.getByRole('button', { name: 'Share your screen' }).click();
      await alice.getByRole('button', { name: 'Start sharing' }).click();
      const share = bob.getByTestId('share-tile-remote');
      await expect(share).toBeVisible({ timeout: 30_000 });
      await expect(share.getByText('video only')).toHaveCount(0, { timeout: 30_000 });

      const onTile = share.getByRole('slider', { name: /^Stream volume/ });
      await share.click({ button: 'right' });
      const shareMenu = bob.getByTestId('share-menu');
      await expect(shareMenu).toBeVisible();
      const inShareMenu = shareMenu.getByRole('slider', { name: 'Stream volume' });
      if (phone === 'iPhone') {
        await expect(onTile).toHaveCount(0);
        await expect(inShareMenu).toHaveCount(0);
        await expect(shareMenu.getByTestId('share-menu-ducking')).toHaveCount(0);
      } else {
        await expect(onTile).toHaveAttribute('max', '1');
        await expect(inShareMenu).toHaveAttribute('max', '1');
      }
      await bob.keyboard.press('Escape');
      await aliceRow(bob).click({ button: 'right' });
      const memberMenu = bob.getByTestId('member-menu');
      await expect(memberMenu).toBeVisible();
      const inMemberMenu = memberMenu.getByRole('slider', { name: 'Stream volume' });
      if (phone === 'iPhone') await expect(inMemberMenu).toHaveCount(0);
      else await expect(inMemberMenu).toHaveAttribute('max', '1');
      await bob.keyboard.press('Escape');

      await bob.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await bob.getByRole('button', { name: 'Voice & audio' }).click();
      await expect(bob.getByTestId('noise-mode')).toBeVisible();
      await expect(bob.getByTestId('stream-ducking')).toHaveCount(phone === 'iPhone' ? 0 : 1);
      await closeModal(bob);
      await call.aliceContext.close();
      await call.bobContext.close();
    });
  }

  test('iPhone: the noise suppressor keeps sending in the background, and is still there after', async ({
    browser,
  }) => {
    const call = await inACall(browser, 'iPhone');
    const { alice, bob } = call;
    await setNoiseMode(bob, 'enhanced');
    await join(call);

    await backgrounded(bob);
    const heard: number[] = [];
    for (let i = 0; i < 8; i++) heard.push(await receivedLevel(alice));
    expect(Math.min(...heard), 'no gap while in the background').toBeGreaterThan(SILENT);
    await returned(bob);
    await bob.waitForTimeout(4000);
    await expect.poll(() => receivedLevel(alice), { timeout: 20_000 }).toBeGreaterThan(AUDIBLE);
    await expect(bob.getByText(/noise suppression could not start/)).toHaveCount(0);
    await openDiagnostics(bob);
    await expect(bob.getByTestId('diag-noise-suppression')).toHaveText(
      'enhanced (hostile-rnnoise)',
    );
    await closeModal(bob);

    await call.aliceContext.close();
    await call.bobContext.close();
  });

  test('iPhone: Strong as the default holds on in the background, and gives way quietly in front', async ({
    browser,
  }) => {
    const call = await inACall(browser, 'iPhone', { defaultNoiseMode: true });
    const { alice, bob } = call;
    await joinVoice(alice, 'General Voice');
    await joinVoice(bob, 'General Voice');
    await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
    const suppression = async (mode: string, failures: string) => {
      await openDiagnostics(bob);
      await expect(bob.getByTestId('diag-noise-suppression')).toHaveText(mode, {
        timeout: 20_000,
      });
      await expect(bob.getByTestId('diag-noise-failures')).toHaveText(failures);
      await closeModal(bob);
    };
    await suppression('strong (hostile-fastenhancer)', 'none');

    await backgrounded(bob);
    await fallBehindThreeTimes(bob);
    await bob.waitForTimeout(3000);
    await expectSendingAudio(bob);
    await suppression('strong (hostile-fastenhancer)', 'none');
    await returned(bob);
    await suppression('strong (hostile-fastenhancer)', 'none');

    await fallBehindThreeTimes(bob);
    await suppression('standard', 'strong: this computer could not keep up with it');
    expect(await loudFailures(bob)).toEqual([]);
    await expect.poll(() => receivedLevel(alice), { timeout: 30_000 }).toBeGreaterThan(AUDIBLE);

    await call.aliceContext.close();
    await call.bobContext.close();
  });

  test('iPhone: a suppressor whose engine stays stopped is rebuilt on the return, unasked', async ({
    browser,
  }) => {
    const call = await inACall(browser, 'iPhone');
    const { alice, bob } = call;
    await setNoiseMode(bob, 'enhanced');
    await join(call);

    await backgrounded(bob, { everything: true });
    await bob.waitForTimeout(6000);
    await expect(bob.getByTestId('voice-state')).toHaveText('Voice connected');
    await returned(bob);

    await expect.poll(() => receivedLevel(alice), { timeout: 30_000 }).toBeGreaterThan(AUDIBLE);
    await expect(bob.getByText(/noise suppression could not start/)).toHaveCount(0);
    await openDiagnostics(bob);
    await expect(bob.getByTestId('diag-noise-suppression')).toHaveText(
      'enhanced (hostile-rnnoise)',
      { timeout: 30_000 },
    );
    await closeModal(bob);

    await call.aliceContext.close();
    await call.bobContext.close();
  });

  test('iPhone: a phone call that ends in the background lets the suppressor send again before the return', async ({
    browser,
  }) => {
    const call = await inACall(browser, 'iPhone');
    const { alice, bob } = call;
    await setNoiseMode(bob, 'enhanced');
    await join(call);

    await backgrounded(bob, { everything: true });
    await expect.poll(() => receivedLevel(alice), { timeout: 10_000 }).toBeLessThan(SILENT);
    await unstuck(bob);
    await expect
      .poll(() => receivedLevel(alice), { message: 'heard before coming back', timeout: 10_000 })
      .toBeGreaterThan(AUDIBLE);
    await returned(bob);
    await expect.poll(() => receivedLevel(alice), { timeout: 20_000 }).toBeGreaterThan(AUDIBLE);
    await openDiagnostics(bob);
    await expect(bob.getByTestId('diag-noise-suppression')).toHaveText(
      'enhanced (hostile-rnnoise)',
    );
    await closeModal(bob);

    await call.aliceContext.close();
    await call.bobContext.close();
  });

  test('iPhone: a suppressor that runs but lets nothing through gives way to standard', async ({
    browser,
  }) => {
    const call = await inACall(browser, 'iPhone');
    const { alice, bob, bobContext } = call;
    await bobContext.addInitScript(silenceRnnoise);
    await bob.reload();
    await setNoiseMode(bob, 'enhanced');
    await joinVoice(alice, 'General Voice');
    await joinVoice(bob, 'General Voice');
    await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });

    await expect(
      bob.getByText(/Enhanced noise suppression could not start \(it stopped passing audio/),
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => receivedLevel(alice), { timeout: 30_000 }).toBeGreaterThan(AUDIBLE);
    await openDiagnostics(bob);
    await expect(bob.getByTestId('diag-noise-suppression')).toHaveText('standard', {
      timeout: 20_000,
    });
    await closeModal(bob);

    await call.aliceContext.close();
    await call.bobContext.close();
  });

  test('iPhone: someone saved at 0% stays silent, and Unmute for me brings them back', async ({
    browser,
  }) => {
    const call = await inACall(browser, 'iPhone');
    const { bob } = call;
    await join(call);
    const tile = bob.getByTestId('participant-tile').filter({ hasText: 'Alice' });
    const menu = bob.getByTestId('member-menu');

    await aliceRow(bob).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /^Mute .* for me$/ }).click();
    await bob.keyboard.press('Escape');
    await bob.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.includes('voice-prefs:'))!;
      const prefs = JSON.parse(localStorage.getItem(key)!) as {
        localMutes: Record<string, boolean>;
        volumes: Record<string, number>;
      };
      const [aliceId] = Object.keys(prefs.localMutes);
      prefs.localMutes = {};
      prefs.volumes = { ...prefs.volumes, [aliceId!]: 0 };
      localStorage.setItem(key, JSON.stringify(prefs));
    });
    await bob.reload();
    await joinVoice(bob, 'General Voice');
    await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });
    await bob.waitForFunction(() => !!document.querySelector('#hostile-audio-sink audio'), null, {
      timeout: 30_000,
    });

    await expectSilence(bob, 'saved at 0%');
    await expect(tile).toContainText('muted for you');
    await aliceRow(bob).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /^Unmute .* for me$/ }).click();
    await bob.keyboard.press('Escape');
    await expectPlayedOnce(bob, 'unmuted for me');
    await expect(tile).not.toContainText('muted for you');
    expect(
      await bob.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.includes('voice-prefs:'))!;
        return Object.values(
          (JSON.parse(localStorage.getItem(key)!) as { volumes: object }).volumes,
        );
      }),
      'the 0 is forgotten, not left to come back',
    ).not.toContain(0);

    await call.aliceContext.close();
    await call.bobContext.close();
  });

  test('a computer keeps Web Audio, muted elements and volume above 100%', async ({ browser }) => {
    const aliceContext = await newContext(browser, { permissions: ['microphone'] });
    const bobContext = await newContext(browser, { permissions: ['microphone'] });
    await bobContext.addInitScript(pretend, 'computer' as const);
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);
    await join({ alice, bob });
    await expect.poll(async () => (await speaker(bob)).webAudio).toBeGreaterThan(AUDIBLE);
    expect((await speaker(bob)).element).toBe(0);
    await aliceRow(bob).click({ button: 'right' });
    await expect(
      bob.getByTestId('member-menu').getByRole('slider', { name: 'User volume' }),
    ).toHaveAttribute('max', '2');
    await aliceContext.close();
    await bobContext.close();
  });
});
