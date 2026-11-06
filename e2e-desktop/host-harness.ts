import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron,
  expect,
  type BrowserContext,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { encodeJsonFrame, FRAME } from '../packages/shared/src/tunnel';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const MAIN = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main.cjs');
const BUILDS = join(REPO_ROOT, '.local', 'e2e-desktop');
export const RENDERER_DIR = join(BUILDS, 'renderer');
export const GUEST_DIR = join(BUILDS, 'guest');
export const RELAY_PORT = 5392;
export const GUEST_PORT = 5391;
export const GUEST_URL = `http://localhost:${GUEST_PORT}`;
export const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

export interface Instance {
  app: ElectronApplication;
  dir: string;
  logs: string[];
  page: Page;
}

export const newUserDir = (name: string) => mkdtempSync(join(tmpdir(), `hostile-${name}-`));

export async function launch(
  dir: string,
  options: { publicRelays?: boolean; realMedia?: boolean } = {},
): Promise<Instance> {
  const env = { ...process.env } as Record<string, string>;
  delete env.HOSTILE_TEST_RELAYS;
  delete env.HOSTILE_DESKTOP_RENDERER_DIR;
  const app = await _electron.launch({
    args: [
      MAIN,
      `--user-data-dir=${dir}`,
      '--use-mock-keychain',
      '--mute-audio',
      ...(options.publicRelays || options.realMedia ? [] : MEDIA_ARGS),
    ],
    env: options.publicRelays
      ? env
      : { ...env, HOSTILE_DESKTOP_RENDERER_DIR: RENDERER_DIR, HOSTILE_TEST_RELAYS: RELAY_URL },
  });
  const logs: string[] = [];
  app.on('window', (opened) => {
    if (!opened.url().includes('bridge.html')) return;
    opened.on('console', (message) => logs.push(`bridge console: ${message.text()}`));
    opened.on('pageerror', (error) => logs.push(`bridge error: ${String(error)}`));
    logs.push('bridge window seen');
  });
  const child = app.process();
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  const page = await app.firstWindow().catch(async (err: unknown) => {
    const others = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(dir));
    throw new Error(
      `${String(err)}\nno window. Output: ${logs.join('').slice(-1500)}\nOthers on this folder: ${others.join('\n').slice(0, 1500)}`,
    );
  });
  page.on('console', (message) => logs.push(`console: ${message.text()}`));
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ systemPreferences }) => {
    const asked: string[] = [];
    (globalThis as unknown as { __mediaAsked: string[] }).__mediaAsked = asked;
    (globalThis as unknown as { __screenAccess: string }).__screenAccess =
      systemPreferences.getMediaAccessStatus('screen');
    systemPreferences.getMediaAccessStatus = () => 'granted';
    systemPreferences.askForMediaAccess = async (kind) => {
      asked.push(kind);
      return true;
    };
  });
  return { app, dir, logs, page };
}

export async function askBridge(app: ElectronApplication) {
  return app.evaluate(async ({ webContents }) => {
    const bridge = webContents.getAllWebContents().find((w) => w.getURL().includes('bridge.html'));
    if (!bridge) throw new Error('no bridge window');
    return bridge.executeJavaScript(`(async () => {
      const microphone = await navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => { stream.getTracks().forEach((t) => t.stop()); return 'opened'; })
        .catch((err) => err.name);
      const pc = new RTCPeerConnection();
      pc.createDataChannel('probe');
      const found = [];
      pc.onicecandidate = (e) => { if (e.candidate) found.push(e.candidate.candidate); };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve) => {
        const done = setTimeout(resolve, 4000);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') { clearTimeout(done); resolve(); }
        };
      });
      pc.close();
      return { microphone, candidates: found };
    })()`) as Promise<{ microphone: string; candidates: string[] }>;
  });
}

export async function reachBridge(app: ElectronApplication, guest: Page) {
  const inBridge = (script: string) =>
    app.evaluate(async ({ webContents }, code) => {
      const bridge = webContents
        .getAllWebContents()
        .find((w) => w.getURL().includes('bridge.html'));
      if (!bridge) throw new Error('no bridge window');
      return bridge.executeJavaScript(code) as Promise<string>;
    }, script);
  const offer = await inBridge(`(async () => {
    const pc = new RTCPeerConnection();
    globalThis.__probe = pc;
    const channel = pc.createDataChannel('probe');
    globalThis.__probeOpen = new Promise((resolve) => {
      channel.onopen = () => resolve('open');
      setTimeout(() => resolve('timed out'), 20000);
    });
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      const done = setTimeout(resolve, 4000);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(done); resolve(); }
      };
    });
    return pc.localDescription.sdp;
  })()`);
  const answer = await guest.evaluate(async (sdp) => {
    const pc = new RTCPeerConnection();
    (globalThis as unknown as { __probe: RTCPeerConnection }).__probe = pc;
    const candidates: string[] = [];
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) candidates.push(e.candidate.candidate);
    };
    pc.ondatachannel = (e) => {
      (globalThis as unknown as { __channel: RTCDataChannel }).__channel = e.channel;
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 4000);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(done);
          resolve();
        }
      };
    });
    return { sdp: pc.localDescription!.sdp, candidates };
  }, offer);
  const state = await inBridge(`(async () => {
    await globalThis.__probe.setRemoteDescription({ type: 'answer', sdp: ${JSON.stringify(answer.sdp)} });
    return globalThis.__probeOpen;
  })()`);
  return { open: state === 'open', guestCandidates: answer.candidates };
}

export type ProbeStep =
  | { state: string }
  | { button: string }
  | { click: string }
  | { text: string }
  | { absent: string };
export function runPlainly(dir: string, steps: ProbeStep[]): Promise<string> {
  const electron = createRequire(join(REPO_ROOT, 'apps', 'desktop', 'package.json'))(
    'electron',
  ) as unknown as string;
  return new Promise((resolve, reject) => {
    const child = spawn(
      electron,
      [
        '-r',
        join(REPO_ROOT, 'e2e-desktop', 'plain-probe.cjs'),
        MAIN,
        `--user-data-dir=${dir}`,
        '--use-mock-keychain',
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          HOSTILE_DESKTOP_RENDERER_DIR: RENDERER_DIR,
          HOSTILE_TEST_RELAYS: RELAY_URL,
          PROBE_STEPS: JSON.stringify(steps),
        },
      },
    );
    let output = '';
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('exit', () =>
      resolve(/\[probe\] (.*)/.exec(output)?.[1] ?? `no report: ${output.slice(-500)}`),
    );
  });
}

export interface Pictures {
  avatar?: { name: string; mimeType: string; buffer: Buffer };
  banner?: { name: string; mimeType: string; buffer: Buffer };
}

async function choosePictures(page: Page, pictures: Pictures) {
  if (pictures.avatar) await page.getByTestId('upload-avatar').setInputFiles(pictures.avatar);
  if (pictures.banner) await page.getByTestId('upload-banner').setInputFiles(pictures.banner);
}

export async function hostFirstRun(
  instance: Instance,
  owner: { displayName: string },
  pictures: Pictures = {},
): Promise<string> {
  const { page } = instance;
  await page.getByRole('button', { name: 'Host a room' }).click();
  await page.getByLabel('Nickname').fill(owner.displayName);
  await choosePictures(page, pictures);
  await page.getByRole('button', { name: 'Create my room' }).click();
  return readCode(page);
}

export async function pasteCode(page: Page, code: string) {
  await page.getByLabel('Room code').fill(code);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByLabel('Nickname'))
    .toBeVisible({ timeout: 60_000 })
    .catch(async (err: Error) => {
      const screen = await page
        .locator('main')
        .innerText()
        .catch(() => 'nothing');
      throw new Error(`${err.message}\nOn the screen: ${screen}`);
    });
}

export async function askToJoin(page: Page, nickname: string, pictures: Pictures = {}) {
  await page.getByLabel('Nickname').fill(nickname);
  await choosePictures(page, pictures);
  await page.getByRole('button', { name: 'Ask to join' }).click();
  await expect(page.getByTestId('ask-waiting')).toBeVisible({ timeout: 20_000 });
}

export const askingCard = (host: Page, nickname: string) =>
  host.getByTestId('join-request').filter({ hasText: nickname });

export async function letIn(host: Page, nickname: string) {
  const row = askingCard(host, nickname);
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.getByRole('button', { name: 'Let in' }).click();
  await expect(row).toHaveCount(0, { timeout: 20_000 });
}

export async function turnAway(host: Page, nickname: string) {
  const row = askingCard(host, nickname);
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.getByRole('button', { name: 'Turn away' }).click();
  await expect(row).toHaveCount(0, { timeout: 20_000 });
}

export async function expectInTheRoom(page: Page) {
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
    timeout: 60_000,
  });
}

export async function joinThroughHost(
  host: Page,
  page: Page,
  code: string,
  nickname: string,
  pictures: Pictures = {},
) {
  await pasteCode(page, code);
  await askToJoin(page, nickname, pictures);
  await letIn(host, nickname);
  await expectInTheRoom(page);
}

export const hostApi = (host: Page) =>
  host.evaluate(async () => {
    const state = await (
      window as unknown as {
        hostileDesktop: { room: { get(): Promise<{ serverUrl: string | null }> } };
      }
    ).hostileDesktop.room.get();
    return state.serverUrl!;
  });

export async function readCode(page: Page): Promise<string> {
  const code = page.getByTestId('hosting-code').locator('[class*="secret"]');
  await expect(code).toBeVisible({ timeout: 90_000 });
  return (await code.textContent())!.trim();
}

export async function recordChannels(context: BrowserContext) {
  await context.addInitScript(() => {
    const native = RTCPeerConnection.prototype.createDataChannel;
    const channels: RTCDataChannel[] = [];
    (window as unknown as { __channels: RTCDataChannel[] }).__channels = channels;
    RTCPeerConnection.prototype.createDataChannel = function (label, options) {
      const channel = native.call(this, label, options);
      if (label.startsWith('hostile-')) channels.push(channel);
      return channel;
    };
  });
}

export function rawExchange(page: Page, frame: Uint8Array) {
  return page.evaluate(
    async (bytes) => {
      const w = window as unknown as { __channels: RTCDataChannel[] };
      const channel = w.__channels.filter((c) => c.label === 'hostile-control').at(-1)!;
      const answers: { type: number; id: number; json: string }[] = [];
      const listener = (e: MessageEvent<ArrayBuffer>) => {
        const b = new Uint8Array(e.data);
        const id = ((b[1]! << 24) | (b[2]! << 16) | (b[3]! << 8) | b[4]!) >>> 0;
        if (b[0] !== 5)
          answers.push({ type: b[0]!, id, json: new TextDecoder().decode(b.subarray(5)) });
      };
      channel.addEventListener('message', listener);
      channel.send(new Uint8Array(bytes));
      await new Promise((r) => setTimeout(r, 1500));
      channel.removeEventListener('message', listener);
      return { answers, state: channel.readyState };
    },
    [...frame],
  );
}

export async function rawStatus(
  page: Page,
  id: number,
  method: string,
  path: string,
  body?: unknown,
) {
  const frame = encodeJsonFrame(FRAME.OPEN_HTTP, id, {
    target: 'room',
    path,
    method,
    headers: { 'content-type': 'application/json' },
    hasBody: false,
  });
  void body;
  const { answers } = await rawExchange(page, frame);
  const head = answers.find((a) => a.type === FRAME.HEAD);
  const closed = answers.find((a) => a.id === id);
  if (!head) return closed ? -1 : 0;
  return (JSON.parse(head.json) as { status: number }).status;
}

export interface HostProcesses {
  server?: number;
  gateway?: number;
  livekit?: number;
  bridge?: number;
}

export function listeningSockets(pids: number[]): string[] {
  const list = pids.join(',');
  const lines: string[] = [];
  for (const args of [
    ['-nP', '-a', '-p', list, '-iTCP', '-sTCP:LISTEN'],
    ['-nP', '-a', '-p', list, '-iUDP'],
  ]) {
    try {
      lines.push(...execFileSync('lsof', args, { encoding: 'utf8' }).split('\n').slice(1));
    } catch {}
  }
  return lines.filter(Boolean);
}

export function processTree(root: number): number[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number) as [number, number]);
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) {
      if (found.has(ppid) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  return [...found];
}

export function livekitConfig(dir: string): string {
  const names = readdirSync(join(dir, 'host')).filter((name) =>
    /^livekit-[0-9a-f]{16}\.yaml$/.test(name),
  );
  expect(names, 'one media server config').toHaveLength(1);
  return join(dir, 'host', names[0]!);
}

export function processesOn(dir: string): { pid: number; command: string }[] {
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(dir))
    .map((line) => {
      const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line)!;
      return { pid: Number(pid), command: command! };
    });
}

export function readAllLogs(dir: string): string {
  let text = '';
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else if (/\.log$|LOG|\.old$/.test(entry) && stat.size < 5_000_000)
        text += readFileSync(path, 'latin1');
    }
  };
  walk(dir);
  return text;
}

export const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true });
