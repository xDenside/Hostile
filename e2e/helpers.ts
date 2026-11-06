import { readFileSync } from 'node:fs';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { E2E_DEVICES_FILE, E2E_SESSION_COOKIE, E2E_WEB_URL } from './stack';

export interface Person {
  displayName: string;
}

export const USERS = {
  alice: { displayName: 'Alice (dev)' },
  bob: { displayName: 'Bob (dev)' },
} satisfies Record<string, Person>;

export const deviceOf = (who: Person): string => {
  const token = (JSON.parse(readFileSync(E2E_DEVICES_FILE, 'utf8')) as Record<string, string>)[
    who.displayName
  ];
  if (!token) throw new Error(`${who.displayName} has no device`);
  return token;
};

export async function putOnTunnelDevice(page: Page, token: string) {
  await page.evaluate(
    ({ token, cookie }) => {
      const hostKey = Object.keys(localStorage).find((key) =>
        key.startsWith('hostile:tunnel:host:'),
      );
      if (!hostKey) throw new Error('This page has reached no host');
      localStorage.setItem(
        `hostile:tunnel:jar:${localStorage.getItem(hostKey)}`,
        JSON.stringify({ [cookie]: { value: token, expiresAt: null } }),
      );
    },
    { token, cookie: E2E_SESSION_COOKIE },
  );
}

export const askButton = (page: Page) => page.getByRole('button', { name: 'Ask to join' });

export const PINNED_NOISE_MODE = 'standard';
const onDefaultNoiseMode = new WeakSet<BrowserContext>();
const pinnedNoiseMode = new WeakSet<BrowserContext>();

export function startOnDefaultNoiseMode(context: BrowserContext) {
  onDefaultNoiseMode.add(context);
}

export async function pinNoiseMode(page: Page) {
  const context = page.context();
  if (onDefaultNoiseMode.has(context) || pinnedNoiseMode.has(context)) return;
  pinnedNoiseMode.add(context);
  await context.addInitScript((noiseMode) => {
    try {
      if (localStorage.getItem('hostile:voice-prefs')) return;
      localStorage.setItem(
        'hostile:voice-prefs',
        JSON.stringify({
          processing: {
            echoCancellation: true,
            noiseMode,
            noiseModeChosen: true,
            autoGainControl: true,
          },
        }),
      );
    } catch {}
  }, PINNED_NOISE_MODE);
}

export function keepFastEnhancerNodes() {
  const Native = window.AudioWorkletNode;
  const nodes: AudioWorkletNode[] = [];
  (window as unknown as { __fastEnhancer: AudioWorkletNode[] }).__fastEnhancer = nodes;
  window.AudioWorkletNode = class extends Native {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options);
      if (name === 'fastenhancer-processor') nodes.push(this);
    }
  };
}

export function recordLoudFailures() {
  const seen: string[] = [];
  (window as unknown as { __loudFailures: string[] }).__loudFailures = seen;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const text = node.textContent ?? '';
        if (/noise suppression could not start/i.test(text)) seen.push(text);
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

export const loudFailures = (page: Page) =>
  page.evaluate(() => (window as unknown as { __loudFailures: string[] }).__loudFailures);

export async function fallBehindThreeTimes(page: Page) {
  await page.evaluate(() => {
    const nodes = (window as unknown as { __fastEnhancer: AudioWorkletNode[] }).__fastEnhancer;
    const node = nodes.at(-1)!;
    for (let i = 0; i < 3; i++) {
      for (const enabled of [true, false]) {
        node.port.dispatchEvent(
          new MessageEvent('message', { data: { type: 'auto_bypass', enabled } }),
        );
      }
    }
  });
}

export async function signIn(page: Page, who: Person) {
  await pinNoiseMode(page);
  const token = deviceOf(who);
  if (process.env.E2E_TUNNEL_MODE) {
    await page.goto('/');
    await expect(askButton(page).or(page.getByTestId('connection-state')).first()).toBeVisible({
      timeout: 45_000,
    });
    await putOnTunnelDevice(page, token);
    await page.reload();
  } else {
    await page.context().addCookies([
      {
        name: E2E_SESSION_COOKIE,
        value: token,
        url: new URL(page.url().startsWith('http') ? page.url() : E2E_WEB_URL).origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await page.goto('/');
  }
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
    timeout: 45_000,
  });
}

export async function askAndEnter(page: Page, nickname: string) {
  await pinNoiseMode(page);
  await page.goto('/');
  await page.getByLabel('Nickname').fill(nickname);
  await askButton(page).click();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
    timeout: 45_000,
  });
}

export function channelButton(page: Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^${name}\\b`) }).first();
}

export async function openTextChannel(page: Page, name: string) {
  await channelButton(page, name).click();
  await expect(page.getByRole('log')).toBeVisible();
}

export async function sendMessage(page: Page, channel: string, text: string) {
  const composer = page.getByLabel(`Message #${channel}`);
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

export async function joinVoice(page: Page, channelName: string, who = 'this page') {
  await page.getByRole('button', { name: new RegExp(`^${channelName}`) }).click();
  const join = page.getByRole('button', { name: new RegExp(`^Join ${channelName}`) });
  if (await join.isVisible().catch(() => false)) await join.click();
  try {
    await expect(page.getByTestId('voice-state')).toHaveText('Voice connected', {
      timeout: 30_000,
    });
  } catch (err) {
    const alerts = await page
      .getByRole('alert')
      .allInnerTexts()
      .catch(() => []);
    const state = await page
      .getByTestId('voice-state')
      .textContent({ timeout: 1_000 })
      .catch(() => null);
    throw new Error(
      `${who} did not get into the call. Call bar: ${state ?? 'gone'}. Alerts: ${
        alerts.length ? alerts.join(' | ') : 'none'
      }.\n${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export async function openDiagnostics(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Diagnostics' }).click();
  await expect(page.getByTestId('diag-voice-state')).toBeVisible();
}

export async function expectSendingAudio(page: Page) {
  await openDiagnostics(page);
  const sent = async () =>
    Number(((await page.getByTestId('diag-audio-sent').textContent()) ?? '').split(' ')[0]) || 0;
  const before = await sent();
  await expect.poll(sent, { timeout: 20_000 }).toBeGreaterThan(before);
  await closeModal(page);
}

export async function setMicrophone(page: Page, label: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Voice & audio' }).click();
  const control = page.getByRole('combobox', { name: 'Microphone' });
  await expect(control).toBeVisible();
  await control.selectOption({ label });
  await closeModal(page);
}

export async function setNoiseMode(page: Page, mode: 'off' | 'standard' | 'enhanced' | 'strong') {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Voice & audio' }).click();
  const control = page.getByTestId('noise-mode');
  await expect(control).toBeVisible();
  await control.selectOption(mode);
  await expect(control).toHaveValue(mode);
  await closeModal(page);
}

export const deleteQuestion = (page: Page) =>
  page.getByRole('dialog', { name: 'Delete this message?' });

export async function answerDelete(page: Page) {
  await deleteQuestion(page).getByRole('button', { name: 'Delete', exact: true }).click();
}

export async function closeModal(page: Page) {
  await page.getByRole('button', { name: 'Close' }).click();
}

export async function countSuppressorContexts(context: BrowserContext) {
  await context.addInitScript(() => {
    const Native = window.AudioContext;
    const built: AudioContext[] = [];
    (window as unknown as { __suppressorContexts: AudioContext[] }).__suppressorContexts = built;
    class Counted extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        if (options?.sampleRate === 48_000 && options.latencyHint === 'interactive') {
          built.push(this);
        }
      }
    }
    window.AudioContext = Counted as unknown as typeof AudioContext;
  });
}

export async function suppressorContexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __suppressorContexts?: AudioContext[] };
    return (w.__suppressorContexts ?? []).map((c) => c.state as string);
  });
}

async function receivedRms(
  page: Page,
  windows: number,
  gapMs: number,
  fftSize: number,
): Promise<number[]> {
  return page.evaluate(
    async ({ windows, gapMs, fftSize }) => {
      type Probe = {
        ctx: AudioContext;
        analyser: AnalyserNode;
        source: MediaStreamAudioSourceNode | null;
        streamId: string;
      };
      const w = window as unknown as { __levelProbe?: Probe };
      const incoming = () =>
        [...document.querySelectorAll<HTMLAudioElement>('#hostile-audio-sink audio')]
          .map((el) => el.srcObject)
          .find(
            (s): s is MediaStream =>
              s instanceof MediaStream &&
              s.getAudioTracks().some((track) => track.readyState === 'live'),
          );
      const waitMs = 45_000;
      const giveUpAt = Date.now() + waitMs;
      let stream = incoming();
      while (!stream) {
        if (Date.now() > giveUpAt) {
          const count = document.querySelectorAll('#hostile-audio-sink audio').length;
          throw new Error(
            `no incoming audio stream after ${waitMs / 1000} s: ${count} audio element(s) in #hostile-audio-sink, none with a live audio track`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
        stream = incoming();
      }
      if (!w.__levelProbe) {
        const ctx = new AudioContext();
        await ctx.resume();
        const analyser = ctx.createAnalyser();
        const silent = ctx.createGain();
        silent.gain.value = 0;
        analyser.connect(silent);
        silent.connect(ctx.destination);
        w.__levelProbe = { ctx, analyser, source: null, streamId: '' };
      }
      const probe = w.__levelProbe;
      probe.analyser.fftSize = fftSize;
      if (probe.streamId !== stream.id) {
        probe.source?.disconnect();
        probe.source = probe.ctx.createMediaStreamSource(stream);
        probe.source.connect(probe.analyser);
        probe.streamId = stream.id;
      }
      const samples = new Float32Array(probe.analyser.fftSize);
      const series: number[] = [];
      for (let i = 0; i < windows; i++) {
        await new Promise((r) => setTimeout(r, gapMs));
        probe.analyser.getFloatTimeDomainData(samples);
        series.push(Math.sqrt(samples.reduce((a, v) => a + v * v, 0) / samples.length));
      }
      return series;
    },
    { windows, gapMs, fftSize },
  );
}

export async function receivedLevel(page: Page): Promise<number> {
  const series = await receivedRms(page, 10, 100, 8192);
  return series.reduce((a, v) => a + v, 0) / series.length;
}

export async function receivedEnvelope(page: Page, seconds: number): Promise<number[]> {
  return receivedRms(page, seconds * 40, 25, 2048);
}

export function percentile(series: number[], fraction: number): number {
  const sorted = [...series].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[at]!;
}

type BlockState = {
  blocked: boolean;
  open: Set<import('@playwright/test').WebSocketRoute>;
  polls: number;
};

const isPoll = (r: import('@playwright/test').Request) =>
  r.method() === 'GET' && r.url().includes('/socket.io/') && r.url().includes('transport=polling');
const realtimeBlocks = new WeakMap<Page, BlockState>();

export async function installRealtimeBlocker(page: Page) {
  const state: BlockState = { blocked: false, open: new Set(), polls: 0 };
  realtimeBlocks.set(page, state);
  page.on('request', (r) => void (isPoll(r) && state.polls++));
  const done = (r: import('@playwright/test').Request) => {
    if (isPoll(r)) state.polls = Math.max(0, state.polls - 1);
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  await page.routeWebSocket('**/socket.io/**', (ws) => {
    if (state.blocked) {
      void ws.close();
      return;
    }
    state.open.add(ws);
    ws.onClose(() => state.open.delete(ws));
    ws.connectToServer();
  });
  await page.route('**/socket.io/**', (route) =>
    state.blocked ? route.abort() : route.continue(),
  );
}

export async function setRealtimeBlocked(page: Page, blocked: boolean) {
  const state = realtimeBlocks.get(page);
  if (!state) throw new Error('installRealtimeBlocker(page) must run before the page connects');
  if (!blocked) {
    state.blocked = false;
    return;
  }

  const upgraded = Date.now() + 10_000;
  while (Date.now() < upgraded && !(state.open.size > 0 && state.polls === 0)) {
    await page.waitForTimeout(100);
  }
  state.blocked = true;

  const deadline = Date.now() + 45_000;
  for (;;) {
    for (const ws of [...state.open]) await ws.close().catch(() => undefined);
    state.open.clear();
    const reported = await page
      .getByTestId('connection-state')
      .getAttribute('data-state')
      .catch(() => null);
    if (reported && reported !== 'connected') return;
    if (Date.now() > deadline) {
      throw new Error('the client never noticed that its realtime connection was blocked');
    }
    await page.waitForTimeout(250);
  }
}

export async function grantMedia(context: BrowserContext, origin: string) {
  await context.grantPermissions(['microphone'], { origin });
}
