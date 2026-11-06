import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium, expect, test } from '@playwright/test';
import { openTextChannel, sendMessage } from '../e2e/helpers';
import {
  GUEST_URL,
  hostFirstRun,
  joinThroughHost,
  launch,
  newUserDir,
  processTree,
  removeDir,
  type Instance,
} from './host-harness';

test.skip(!process.env.E2E_MEASURE_MEMORY, 'Set E2E_MEASURE_MEMORY=1 to measure.');

const OWNER = { displayName: 'Room Host' };

async function measure(host: Instance) {
  const metrics = await host.app.evaluate(async ({ app, webContents }) => {
    const windows = webContents
      .getAllWebContents()
      .map((w) => ({ pid: w.getOSProcessId(), url: w.getURL() }));
    return {
      windows,
      list: app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        name: m.name ?? m.serviceName ?? '',
        workingSetMB: Math.round(m.memory.workingSetSize / 1024),
      })),
    };
  });
  const root = host.app.process().pid!;
  const rows = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row)!)
    .map((m) => ({ pid: Number(m[1]), rssMB: Math.round(Number(m[2]) / 1024), command: m[3]! }));
  const tree = new Set(processTree(root));
  const named = (row: { pid: number; command: string }) => {
    const metric = metrics.list.find((m) => m.pid === row.pid);
    const window = metrics.windows.find((w) => w.pid === row.pid);
    if (row.pid === root) return 'main';
    if (window?.url.includes('bridge.html')) return 'bridge window';
    if (window) return 'host window';
    if (metric?.name) return metric.name;
    if (row.command.includes('livekit-server')) return 'LiveKit';
    if (metric?.type) return metric.type;
    return /\/bin\/sh/.test(row.command) ? 'LiveKit watcher (sh)' : row.command.slice(0, 40);
  };
  const processes = rows
    .filter((row) => tree.has(row.pid))
    .map((row) => ({
      process: named(row),
      pid: row.pid,
      psRssMB: row.rssMB,
      workingSetMB: metrics.list.find((m) => m.pid === row.pid)?.workingSetMB ?? null,
    }))
    .sort((a, b) => b.psRssMB - a.psRssMB);
  return { processes, totalPsRssMB: processes.reduce((sum, p) => sum + p.psRssMB, 0) };
}

test('what a hosted room costs in memory', async () => {
  test.setTimeout(420_000);
  const hostDir = newUserDir('memory');
  const guestDir = newUserDir('memory-guest');
  const browser = await chromium.launch({ channel: 'chromium' });
  let host = await launch(hostDir, { realMedia: true });
  let appGuest: Instance | null = null;
  try {
    let firstRunPeakMB = 0;
    const sampler = setInterval(() => {
      const tree = new Set(processTree(host.app.process().pid!));
      const rows = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' }).split(
        '\n',
      );
      for (const row of rows) {
        const m = /^\s*(\d+)\s+(\d+)\s+.*NodeService/.exec(row);
        if (m && tree.has(Number(m[1])))
          firstRunPeakMB = Math.max(firstRunPeakMB, Math.round(Number(m[2]) / 1024));
      }
    }, 100);
    const code = await hostFirstRun(host, OWNER);
    clearInterval(sampler);
    await host.page.keyboard.press('Escape');
    await host.page.waitForTimeout(30_000);
    const firstRunIdle = await measure(host);

    await host.app.close();
    host = await launch(hostDir, { realMedia: true });
    await expect(host.page.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
      { timeout: 90_000 },
    );
    await host.page.waitForTimeout(30_000);
    const idle = await measure(host);

    const tab = await (await browser.newContext()).newPage();
    await tab.goto(GUEST_URL);
    await joinThroughHost(host.page, tab, code, 'Tab Guest');
    appGuest = await launch(guestDir);
    await appGuest.page.getByRole('button', { name: 'Join with a code' }).click();
    await joinThroughHost(host.page, appGuest.page, code, 'App Guest');
    for (const page of [host.page, tab, appGuest.page]) await openTextChannel(page, 'general');
    for (let i = 0; i < 10; i++) {
      await sendMessage(host.page, 'general', `host ${i}`);
      await sendMessage(tab, 'general', `tab ${i}`);
      await sendMessage(appGuest.page, 'general', `app ${i}`);
    }
    await host.page.waitForTimeout(30_000);
    const twoGuests = await measure(host);

    const report = { firstRunPeakMB, firstRunIdle, idle, twoGuests };
    const text = JSON.stringify(report, null, 1);
    console.log(`MEMORY ${text}`);
    if (process.env.E2E_MEASURE_OUT) writeFileSync(process.env.E2E_MEASURE_OUT, text);
  } finally {
    await browser.close().catch(() => undefined);
    await appGuest?.app.close().catch(() => undefined);
    await host.app.close().catch(() => undefined);
    removeDir(hostDir);
    removeDir(guestDir);
  }
});
