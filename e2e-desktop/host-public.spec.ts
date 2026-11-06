import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { openTextChannel, sendMessage } from '../e2e/helpers';
import { waitForHttp } from '../scripts/lib/net.mjs';
import {
  askBridge,
  askToJoin,
  expectInTheRoom,
  hostFirstRun,
  launch,
  letIn,
  newUserDir,
  removeDir,
  REPO_ROOT,
} from './host-harness';

const OWNER = { displayName: 'Room Host' };
const GUEST = { displayName: 'Tab' };

test.skip(
  !process.env.E2E_PUBLIC_RENDEZVOUS,
  'Set E2E_PUBLIC_RENDEZVOUS=1 to use the public relays.',
);

test('a real host in the app and a guest in a tab meet over the public relays', async () => {
  test.setTimeout(300_000);
  const webDir = join(REPO_ROOT, 'apps', 'web');
  const require = createRequire(import.meta.url);
  const viteJson = require.resolve('vite/package.json', { paths: [webDir] });
  const port = 5295;
  const site = spawn(process.execPath, [join(viteJson, '..', 'bin', 'vite.js'), '--strictPort'], {
    cwd: webDir,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEB_PORT: String(port),
      HOSTILE_GUEST: '1',
      HOSTILE_TEST_RELAYS: '',
      VITE_NO_WATCH: '1',
    },
  });
  const url = `http://localhost:${port}`;
  const dir = newUserDir('public');
  const browser = await chromium.launch({ channel: 'chromium' });
  const host = await launch(dir, { publicRelays: true });
  try {
    expect(await waitForHttp(`${url}/`, 45_000, (r) => r.status < 500)).toBe(true);
    const code = await hostFirstRun(host, OWNER);
    await expect(host.page.getByTestId('hosting-bridge')).toContainText('Running', {
      timeout: 60_000,
    });
    const bridge = await askBridge(host.app);
    expect(bridge.microphone).toBe('NotAllowedError');
    await host.page.keyboard.press('Escape');
    await host.page.waitForTimeout(15_000);

    const context = await browser.newContext({ permissions: [] });
    const tab = await context.newPage();
    const relays = new Set<string>();
    tab.on('websocket', (ws) => {
      if (ws.url().startsWith('wss://')) relays.add(ws.url());
    });
    await tab.goto(`${url}/`);
    await tab.getByLabel('Room code').fill(code);
    const started = Date.now();
    await tab.getByRole('button', { name: 'Connect' }).click();
    await expect(tab.getByLabel('Nickname')).toBeVisible({ timeout: 120_000 });
    const connectMs = Date.now() - started;
    await askToJoin(tab, GUEST.displayName);
    await letIn(host.page, GUEST.displayName);
    await expectInTheRoom(tab);
    await openTextChannel(tab, 'general');
    await openTextChannel(host.page, 'general');
    await sendMessage(tab, 'general', 'over the public relays');
    await expect(host.page.getByRole('log').getByText('over the public relays')).toBeVisible({
      timeout: 30_000,
    });
    await sendMessage(host.page, 'general', 'and back');
    await expect(tab.getByRole('log').getByText('and back')).toBeVisible({ timeout: 30_000 });
    const candidates = bridge.candidates.map((c) => c.split(' ')[7]);
    console.log(
      `PUBLIC RELAYS ${JSON.stringify({ relaysTried: [...relays], connectMs, hostCandidateKinds: candidates })}`,
    );
  } finally {
    await browser.close().catch(() => undefined);
    await host.app.close().catch(() => undefined);
    site.kill('SIGTERM');
    removeDir(dir);
  }
});
