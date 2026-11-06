import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/\/e2e-desktop\/$/, '');
const mainEntry = join(repoRoot, 'apps', 'desktop', 'dist', 'main.cjs');

let app: ElectronApplication;
let profileDir: string;

test.beforeAll(async () => {
  profileDir = mkdtempSync(join(tmpdir(), 'hostile-desktop-test-'));
  app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${profileDir}`, '--profile=e2e', '--mute-audio'],
  });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(profileDir, { recursive: true, force: true });
});

test('the desktop shell opens the packaged renderer with a hardened configuration', async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  expect(window.url()).toMatch(/^hostile:\/\/hostile\//);

  const prefs = await app.evaluate(async ({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    const prefs = (
      win!.webContents as unknown as {
        getLastWebPreferences(): Record<string, unknown> | null;
      }
    ).getLastWebPreferences();
    return {
      contextIsolation: prefs?.contextIsolation,
      sandbox: prefs?.sandbox,
      nodeIntegration: prefs?.nodeIntegration,
      webSecurity: prefs?.webSecurity,
      webviewTag: prefs?.webviewTag,
      nodeIntegrationInSubFrames: prefs?.nodeIntegrationInSubFrames,
    };
  });
  expect(prefs.contextIsolation).not.toBe(false);
  expect(prefs.sandbox).not.toBe(false);
  expect(prefs.nodeIntegration).not.toBe(true);
  expect(prefs.nodeIntegrationInSubFrames).not.toBe(true);
  expect(prefs.webSecurity).not.toBe(false);
  expect(prefs.webviewTag).not.toBe(true);

  if (process.platform !== 'linux') {
    const sandboxed = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().some((metric) => metric.type === 'Tab' && metric.sandboxed),
    );
    expect(sandboxed).toBe(true);
  }

  const renderer = await window.evaluate(() => ({
    hasBridge: typeof (window as unknown as Record<string, unknown>).hostileDesktop === 'object',
    hasRequire: typeof (window as unknown as Record<string, unknown>).require !== 'undefined',
    hasProcess: typeof (window as unknown as Record<string, unknown>).process !== 'undefined',
    hasIpcRenderer:
      typeof (window as unknown as Record<string, unknown>).ipcRenderer !== 'undefined',
    bridgeKeys: Object.keys(
      ((window as unknown as Record<string, unknown>).hostileDesktop ?? {}) as object,
    ).sort(),
  }));
  expect(renderer.hasBridge).toBe(true);
  expect(renderer.hasRequire).toBe(false);
  expect(renderer.hasProcess).toBe(false);
  expect(renderer.hasIpcRenderer).toBe(false);
  expect(renderer.bridgeKeys).toEqual(
    [
      'auth',
      'bridgeVersion',
      'capture',
      'getInfo',
      'hosting',
      'media',
      'onPowerEvent',
      'openExternal',
      'room',
      'shortcuts',
    ].sort(),
  );

  const csp = await app.evaluate(async ({ BrowserWindow, net }) => {
    const [win] = BrowserWindow.getAllWindows();
    const response = await net.fetch(win!.webContents.getURL());
    return response.headers.get('content-security-policy');
  });
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).not.toContain("'unsafe-eval'");

  const sandbox = await window.evaluate(async () => {
    const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    let wasm = 'compiled';
    try {
      await WebAssembly.compile(empty);
    } catch (err) {
      wasm = err instanceof Error ? err.message : 'failed';
    }
    let evaluated: string;
    try {
      evaluated = String((0, eval)('1 + 1'));
    } catch (err) {
      evaluated = err instanceof Error ? err.name : 'refused';
    }
    return { wasm, evaluated };
  });
  expect(sandbox.wasm).toBe('compiled');
  expect(sandbox.evaluated).toBe('EvalError');

  const clipboard = await window.evaluate(async () => ({
    write: (await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })).state,
    read: await navigator.permissions
      .query({ name: 'clipboard-read' as PermissionName })
      .then((status) => status.state)
      .catch(() => 'unsupported'),
  }));
  expect(clipboard.write).toBe('granted');
  expect(clipboard.read).not.toBe('granted');

  await expect(window.getByRole('button', { name: 'Host a room' })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Join with a code' })).toBeVisible();
  await expect(window.getByText(/server by address/i)).toHaveCount(0);
});

test('the bridge reports platform information and refuses unsafe external links', async () => {
  const window = await app.firstWindow();
  const info = await window.evaluate(async () => {
    const bridge = (
      window as unknown as { hostileDesktop: { getInfo(): Promise<Record<string, unknown>> } }
    ).hostileDesktop;
    return bridge.getInfo();
  });
  expect(info.platform).toMatch(/darwin|win32|linux/);
  expect(String(info.electronVersion)).toMatch(/^\d+\./);
  expect(info.profile).toBe('e2e');

  const rejected = await window.evaluate(async () => {
    const bridge = (
      window as unknown as { hostileDesktop: { openExternal(url: string): Promise<void> } }
    ).hostileDesktop;
    try {
      await bridge.openExternal('file:///etc/passwd');
      return 'resolved';
    } catch {
      return 'rejected';
    }
  });
  expect(rejected).toBe('rejected');
});

test('a global shortcut is given back to the system while no window can act on it', async () => {
  test.skip(
    process.platform !== 'darwin',
    'elsewhere the app quits with its last window, which releases the shortcuts anyway',
  );
  const accelerator = 'CommandOrControl+Alt+F13';
  const window = await app.firstWindow();

  const state = await window.evaluate(async (binding: string) => {
    const bridge = (
      window as unknown as {
        hostileDesktop: {
          shortcuts: {
            set(bindings: Record<string, string | null>): Promise<{
              status: Record<string, string>;
            }>;
          };
        };
      }
    ).hostileDesktop;
    return bridge.shortcuts.set({ toggleMute: binding, toggleDeafen: null });
  }, accelerator);
  expect(state.status.toggleMute).toBe('registered');

  const held = (accel: string) =>
    app.evaluate(({ globalShortcut }, key: string) => globalShortcut.isRegistered(key), accel);
  expect(await held(accelerator)).toBe(true);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await expect.poll(() => held(accelerator)).toBe(false);

  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit('activate');
  });
  await expect.poll(() => held(accelerator)).toBe(true);
});

test('an unpackaged run gives the Dock its own icon, however Electron was started', async () => {
  test.skip(process.platform !== 'darwin', 'only macOS has a Dock');
  const desktopDir = join(repoRoot, 'apps', 'desktop');
  const electronPath = createRequire(join(desktopDir, 'package.json'))(
    'electron',
  ) as unknown as string;
  for (const entry of [desktopDir, mainEntry]) {
    const dir = mkdtempSync(join(tmpdir(), 'hostile-dock-'));
    try {
      const said = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          electronPath,
          [
            '-r',
            join(repoRoot, 'e2e-desktop', 'dock-probe.cjs'),
            entry,
            `--user-data-dir=${dir}`,
            '--use-mock-keychain',
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let output = '';
        child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
        child.on('error', reject);
        child.on('exit', () =>
          resolve(/\[dock\] (.*)/.exec(output)?.[1] ?? `no report: ${output.slice(-400)}`),
        );
      });
      expect(said).toBe(join(desktopDir, 'build', 'icon-mac.png'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
