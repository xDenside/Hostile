import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { REPO_ROOT } from '../scripts/lib/env.mjs';
import { waitForHttp } from '../scripts/lib/net.mjs';
import { USERS } from './helpers';
import { signInHere, startTunnelHost } from './tunnel-harness';

test('a guest finds a host over the public rendezvous', async ({ browser }) => {
  test.setTimeout(240_000);
  const require = createRequire(import.meta.url);
  const webDir = join(REPO_ROOT, 'apps', 'web');
  const viteJson = require.resolve('vite/package.json', { paths: [webDir] });
  const vite = join(viteJson, '..', 'bin', 'vite.js');
  const port = 5295;
  const site = spawn(process.execPath, [vite, '--strictPort'], {
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
  try {
    expect(await waitForHttp(`${url}/`, 45_000, (r) => r.status < 500)).toBe(true);
    const host = await startTunnelHost({ guestUrl: url });
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const context = await browser.newContext({ permissions: [] });
    const page = await context.newPage();
    const relays = new Set<string>();
    page.on('websocket', (ws) => {
      if (ws.url().startsWith('wss://')) relays.add(ws.url());
    });
    await page.goto(`${url}/`);
    await page.getByLabel('Room code').fill(host.code);
    const started = Date.now();
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByLabel('Nickname')).toBeVisible({ timeout: 120_000 });
    const connectMs = Date.now() - started;
    await signInHere(page, USERS.alice);
    const report = { relaysTried: [...relays], connectMs };
    console.log(`PUBLIC RENDEZVOUS ${JSON.stringify(report)}`);
    await context.close();
    await host.stop();
  } finally {
    site.kill('SIGTERM');
  }
});
