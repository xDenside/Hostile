import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pngFile } from '../e2e/attachment-fixtures';
import { joinVoice, openTextChannel, sendMessage } from '../e2e/helpers';
import {
  askingCard,
  askToJoin,
  expectInTheRoom,
  GUEST_URL,
  hostApi,
  hostFirstRun,
  joinThroughHost,
  launch,
  letIn,
  newUserDir,
  pasteCode,
  rawStatus,
  recordChannels,
  readCode,
  REPO_ROOT,
  removeDir,
  runPlainly,
  turnAway,
  type Instance,
} from './host-harness';

const OWNER = { displayName: 'Room Host' };

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(path);
    }
  };
  try {
    walk(dir);
  } catch {}
  return found;
}

test.describe.serial('asking to join, through the real app', () => {
  test.setTimeout(420_000);
  const hostDir = newUserDir('joinhost');
  const appDir = newUserDir('joinapp');
  let host: Instance;
  let browser: Browser;
  let code = '';
  let api = '';
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: test.info().outputPath(`${name}.png`) });

  const members = async () => {
    await host.page.getByRole('button', { name: 'Members', exact: true }).click();
    await host.page.getByRole('button', { name: 'Hosting', exact: true }).click();
    await host.page.getByRole('button', { name: 'Members', exact: true }).click();
    const rows = host.page.getByTestId('member-row');
    await expect(rows.first()).toBeVisible();
    return rows.allInnerTexts();
  };
  const newTab = async (): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext();
    await recordChannels(context);
    const page = await context.newPage();
    await page.goto(GUEST_URL);
    return { context, page };
  };

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    browser = await chromium.launch({
      channel: 'chromium',
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    host = await launch(hostDir);
    code = await hostFirstRun(host, OWNER);
    api = await hostApi(host.page);
  });

  test.beforeEach(async () => {
    await host.page.keyboard.press('Escape');
    await host.page.waitForTimeout(400);
    api = await hostApi(host.page);
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await host?.app.close().catch(() => undefined);
    removeDir(hostDir);
    removeDir(appDir);
  });

  test('proof 3: turned away, they are told, nothing is kept, and they may ask again', async () => {
    await host.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await host.page.getByRole('button', { name: 'Hosting', exact: true }).click();
    const { context, page } = await newTab();
    await pasteCode(page, code);
    await shot(page, 'join-card-empty');
    const avatar = pngFile('stranger.png', 200, 200, 31);
    const banner = pngFile('stranger-banner.png', 680, 240, 32);
    await page.getByLabel('Nickname').fill('<b>Bad</b> Stranger');
    await page.getByTestId('upload-avatar').setInputFiles(avatar);
    await page.getByTestId('upload-banner').setInputFiles(banner);
    await expect(page.getByTestId('ask-preview').locator('img').first()).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'join-card-pictures');
    await page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(page.getByTestId('ask-waiting')).toBeVisible({ timeout: 20_000 });
    await shot(page, 'waiting');

    const row = askingCard(host.page, '<b>Bad</b> Stranger');
    await expect(row).toBeVisible({ timeout: 45_000 });
    await expect(row.locator('b')).toHaveCount(0);
    await expect(row.locator('img')).toBeVisible();
    await host.page.waitForTimeout(400);
    await shot(host.page, 'host-card-and-waiting-list');
    await expect(host.page.getByTestId('waiting-none')).toHaveCount(0);
    await expect(row).toHaveCount(1);
    await expect(host.page.getByTestId('join-card')).toHaveCount(0);

    const before = await members();
    const onCard = host.page.getByTestId('join-card').getByTestId('join-request');
    await expect(onCard.filter({ hasText: '<b>Bad</b> Stranger' })).toHaveCount(1);
    await expect(onCard.locator('b')).toHaveCount(0);
    const filesBefore = filesUnder(join(hostDir, 'host', 'data', 'uploads')).length;
    await host.page.getByRole('button', { name: 'Hosting', exact: true }).click();
    await turnAway(host.page, '<b>Bad</b> Stranger');

    await expect(page.getByTestId('ask-turned-away')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('ask-turned-away')).toContainText('turned this request away');
    await shot(page, 'turned-away');

    expect(await members()).toEqual(before);
    expect(filesUnder(join(hostDir, 'host', 'data', 'uploads')).length).toBe(filesBefore);
    await host.page.getByRole('button', { name: 'Hosting', exact: true }).click();

    await page.getByRole('button', { name: 'Ask again' }).click();
    await page.getByLabel('Nickname').fill('Second Try');
    await page.getByRole('button', { name: 'Ask to join' }).click();
    await letIn(host.page, 'Second Try');
    await expectInTheRoom(page);
    await context.close();
  });

  test('several at once queue, on the card and in the Waiting list', async () => {
    const one = await newTab();
    const two = await newTab();
    await pasteCode(one.page, code);
    await pasteCode(two.page, code);
    await askToJoin(one.page, 'Queue One');
    await askToJoin(two.page, 'Queue Two');
    await expect(host.page.getByTestId('join-card-more')).toContainText('1 more', {
      timeout: 30_000,
    });
    await expect(host.page.getByTestId('join-card').getByTestId('join-request')).toHaveCount(1);
    await host.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await host.page.getByRole('button', { name: 'Hosting', exact: true }).click();
    await expect(
      host.page.getByTestId('join-request').filter({ hasText: 'Queue Two' }),
    ).toBeVisible();
    await shot(host.page, 'host-queue');
    const focused = await host.page.evaluate(
      () => document.activeElement?.closest('[data-testid=join-card]') !== null,
    );
    expect(focused).toBe(false);
    await letIn(host.page, 'Queue One');
    await letIn(host.page, 'Queue Two');
    await expectInTheRoom(one.page);
    await expectInTheRoom(two.page);
    await one.context.close();
    await two.context.close();
  });

  test('proof 4: the same device comes straight in, after a reload, an app restart, a host restart and a new code', async () => {
    const tab = await newTab();
    await joinThroughHost(host.page, tab.page, code, 'Returning Tab');
    const app = await launch(appDir);
    await app.page.getByRole('button', { name: 'Join with a code' }).click();
    await joinThroughHost(host.page, app.page, code, 'Returning App');
    await host.page.keyboard.press('Escape');
    await openTextChannel(tab.page, 'general');
    await sendMessage(tab.page, 'general', 'before everything');
    const count = (
      await (async () => {
        await host.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
        return members();
      })()
    ).length;

    await tab.page.reload();
    await expectInTheRoom(tab.page);
    await expect(tab.page.getByLabel('Nickname')).toHaveCount(0);

    await app.app.close();
    expect(await runPlainly(appDir, [{ state: 'connected' }, { text: 'Returning App' }])).toBe(
      'done',
    );

    await host.app.close();
    host = await launch(hostDir);
    await expectInTheRoom(host.page);
    await expectInTheRoom(tab.page);
    await expect(tab.page.getByRole('log').getByText('before everything')).toBeVisible({
      timeout: 30_000,
    });
    await expect(host.page.getByTestId('join-card')).toHaveCount(0);

    await host.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await host.page.getByRole('button', { name: 'Hosting', exact: true }).click();
    const old = await readCode(host.page);
    await host.page.getByRole('button', { name: 'Make a new code' }).click();
    await host.page.getByRole('button', { name: 'Make a new code' }).last().click();
    await expect(host.page.getByTestId('hosting-code').locator('[class*="secret"]')).not.toHaveText(
      old,
      {
        timeout: 15_000,
      },
    );
    code = await readCode(host.page);
    await tab.page.reload();
    await tab.page.getByRole('button', { name: 'Use a different code' }).click({ timeout: 60_000 });
    await tab.page.getByLabel('Room code').fill(code);
    await tab.page.getByRole('button', { name: 'Connect' }).click();
    await expectInTheRoom(tab.page);
    await expect(tab.page.getByLabel('Nickname')).toHaveCount(0);
    await sendMessage(tab.page, 'general', 'after a new code');
    await expect(host.page.getByTestId('join-request')).toHaveCount(0);
    expect((await members()).length).toBe(count);
    await host.page.keyboard.press('Escape');
    await tab.context.close();
  });

  test('proof 5: cleared storage is a new person, who asks again, and old messages keep the old name', async () => {
    const tab = await newTab();
    await joinThroughHost(host.page, tab.page, code, 'First Self');
    await openTextChannel(tab.page, 'general');
    await sendMessage(tab.page, 'general', 'said by the first self');
    await openTextChannel(host.page, 'general');
    await expect(host.page.getByRole('log').getByText('said by the first self')).toBeVisible({
      timeout: 20_000,
    });

    await tab.page.evaluate(async () => {
      localStorage.clear();
      await new Promise<void>((resolve, reject) => {
        const gone = indexedDB.deleteDatabase('hostile-device');
        gone.onsuccess = () => resolve();
        gone.onerror = () => reject(gone.error ?? new Error('the device key stayed'));
        gone.onblocked = () => reject(new Error('the device key is still open'));
      });
    });
    await tab.page.goto(GUEST_URL);
    await pasteCode(tab.page, code);
    await askToJoin(tab.page, 'Second Self');
    await letIn(host.page, 'Second Self');
    await expectInTheRoom(tab.page);
    await openTextChannel(tab.page, 'general');
    const log = tab.page.getByRole('log');
    await expect(log.getByText('said by the first self')).toBeVisible({ timeout: 20_000 });
    await expect(log.getByText('First Self').first()).toBeVisible();
    await sendMessage(tab.page, 'general', 'said by the second self');
    await expect(host.page.getByRole('log').getByText('said by the second self')).toBeVisible({
      timeout: 20_000,
    });
    await tab.context.close();
  });

  test('proof 8: two people with one nickname are two people', async () => {
    const one = await newTab();
    const two = await newTab();
    await joinThroughHost(host.page, one.page, code, 'Same Name', {
      avatar: pngFile('one.png', 200, 200, 41),
    });
    await joinThroughHost(host.page, two.page, code, 'Same Name');
    await openTextChannel(one.page, 'general');
    await openTextChannel(two.page, 'general');
    await sendMessage(one.page, 'general', 'one of them');
    await sendMessage(two.page, 'general', 'the other one');
    await expect(two.page.getByRole('log').getByText('one of them')).toBeVisible({
      timeout: 20_000,
    });
    await host.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await host.page.getByRole('button', { name: 'Members', exact: true }).click();
    const rows = host.page.getByTestId('member-row').filter({ hasText: 'Same Name' });
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    await shot(host.page, 'members-two-same-name');
    const ids = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-member')!));
    expect(new Set(ids).size).toBe(2);
    const row = rows.filter({ has: host.page.locator('img') });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Remove' }).click();
    await row.getByRole('button', { name: 'Remove' }).last().click();
    await expect(one.page.getByTestId('join-ended')).toContainText('removed', { timeout: 20_000 });
    await expect(rows).toHaveCount(1, { timeout: 20_000 });
    await expect(two.page.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
    );
    await sendMessage(two.page, 'general', 'still here');
    await host.page.keyboard.press('Escape');
    await one.context.close();
    await two.context.close();
  });

  test('proof 6: removing someone ends them at once, in a call too, and they can only ask as someone new', async () => {
    const tab = await newTab();
    await joinThroughHost(host.page, tab.page, code, 'Removed Person');
    const kept = await tab.page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([, value]) => value.includes('_session'))
        .map(([key]) => key),
    );
    expect(kept, 'no session token is kept where page scripts can read it').toEqual([]);
    await joinVoice(tab.page, 'General Voice');
    await joinVoice(host.page, 'General Voice');
    await host.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await host.page.getByRole('button', { name: 'Members', exact: true }).click();
    const row = host.page.getByTestId('member-row').filter({ hasText: 'Removed Person' });
    const startedAt = Date.now();
    await row.getByRole('button', { name: 'Remove' }).click();
    await row.getByRole('button', { name: 'Remove' }).last().click();
    await expect(tab.page.getByTestId('join-ended')).toContainText('removed', { timeout: 20_000 });
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    await expect(row).toHaveCount(0, { timeout: 20_000 });
    await host.page.keyboard.press('Escape');
    await expect(host.page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
    await expect(host.page.getByText('Removed Person')).toHaveCount(0, { timeout: 20_000 });
    await shot(host.page, 'after-remove');
    await host.page
      .getByRole('button', { name: /^Leave|Disconnect/ })
      .first()
      .click();

    await tab.page.goto(`${GUEST_URL}/`);
    await expect(tab.page.getByLabel('Nickname')).toBeVisible({ timeout: 60_000 });
    await expect(tab.page.getByTestId('connection-state')).toHaveCount(0);
    await askToJoin(tab.page, 'Removed Person Again');
    await expect(tab.page.getByTestId('connection-state')).toHaveCount(0);
    await letIn(host.page, 'Removed Person Again');
    await expectInTheRoom(tab.page);
    await tab.context.close();
  });

  test('proof 7: no code, no entry', async () => {
    const ask = await fetch(`${api}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: api },
      body: JSON.stringify({ nickname: 'Local Program' }),
    });
    expect(ask.status).toBe(403);
    expect((await fetch(`${api}/api/join/some-ticket`)).status).toBe(403);
    const costumes: Record<string, string>[] = [
      { 'x-forwarded-for': '203.0.113.9' },
      { 'x-hostile-gateway': 'guessed', 'x-forwarded-for': '203.0.113.9' },
    ];
    for (const headers of costumes) {
      const dressed = await fetch(`${api}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: api, ...headers },
        body: JSON.stringify({ nickname: 'Local Program' }),
      });
      expect(dressed.status).toBe(403);
    }
    await expect(host.page.getByTestId('join-request')).toHaveCount(0);

    const wrong = await fetch(`${api}/api/auth/owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: api },
      body: JSON.stringify({ secret: 'x'.repeat(64), client: 'desktop' }),
    });
    expect([401, 403]).toContain(wrong.status);
    const { ownerSecret } = JSON.parse(
      readFileSync(join(hostDir, 'host', 'secrets.json'), 'utf8'),
    ) as { ownerSecret: string };
    const right = await fetch(`${api}/api/auth/owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: api },
      body: JSON.stringify({ secret: ownerSecret, client: 'desktop' }),
    });
    expect(right.status).toBe(200);

    const tab = await newTab();
    await pasteCode(tab.page, code);
    let id = 7001;
    for (const path of ['/api/auth/owner', '/API/auth/owner', '/api/AUTH/owner/']) {
      const status = await rawStatus(tab.page, (id += 2), 'POST', path);
      expect([path, status === 200 || status === 201 || status === 0]).toEqual([path, false]);
    }

    for (const path of [
      '/api/bootstrap',
      '/api/admin/users',
      '/api/admin/join-requests',
      '/api/auth/session',
      '/api/voice/status',
    ]) {
      expect([path, await rawStatus(tab.page, (id += 2), 'GET', path)]).toEqual([path, 401]);
    }
    expect(await rawStatus(tab.page, (id += 2), 'POST', '/api/voice/token')).toBe(401);
    for (const path of ['/api/health', '/api/public-config']) {
      expect([path, await rawStatus(tab.page, (id += 2), 'GET', path)]).toEqual([path, 200]);
    }

    const refused = spawnSync(
      join(REPO_ROOT, 'apps', 'server', 'node_modules', '.bin', 'tsx'),
      ['src/main.ts'],
      {
        cwd: join(REPO_ROOT, 'apps', 'server'),
        env: {
          ...process.env,
          HOSTILE_ENV: 'production',
          PUBLIC_APP_URL: 'https://chat.example.com',
          DATA_DIR: appDir,
          SESSION_SECRET: 'x9f2Kq7Lm4Rz8Tv1Bn6Cw3Hy5Jd0Ps2Ae',
          LIVEKIT_API_KEY: 'APIz7Qk3Vm9Ld2',
          LIVEKIT_API_SECRET: 'Qz4Vb8Nm2Kc6Xy1Hf9Tr3Ws7Pd5Lg0Ja',
          LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:7880',
          LIVEKIT_PUBLIC_URL: 'wss://turn.example.com',
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('only runs inside the host app');
    await tab.context.close();
  });

  test('proof 11: a lost refresh response leaves the person signed in', async () => {
    const tab = await newTab();
    await joinThroughHost(host.page, tab.page, code, 'Lost Answer');
    await host.app.evaluate(({ net }) => {
      const real = net.fetch.bind(net);
      const g = globalThis as unknown as { __lost: number };
      g.__lost = 0;
      net.fetch = (async (input: string, init: RequestInit) => {
        const answer = await real(input, init);
        if (String(input).includes('/api/auth/refresh') && g.__lost === 0) {
          g.__lost = 1;
          throw new TypeError('the connection was lost');
        }
        return answer;
      }) as typeof net.fetch;
    });
    const owner = await host.page.evaluate(async () => {
      const desktop = (
        window as unknown as {
          hostileDesktop: { auth: { refresh(): Promise<{ ok: boolean }> } };
        }
      ).hostileDesktop;
      const first = await desktop.auth.refresh();
      const second = await desktop.auth.refresh();
      return { first: first.ok, second: second.ok };
    });
    expect(owner).toEqual({ first: false, second: true });
    expect(
      await host.app.evaluate(() => (globalThis as unknown as { __lost: number }).__lost),
    ).toBe(1);
    await expectInTheRoom(host.page);
    await openTextChannel(host.page, 'general');
    await sendMessage(host.page, 'general', 'after a lost answer');
    await tab.page.reload();
    await expectInTheRoom(tab.page);
    await tab.context.close();
  });

  test('proof 10: with the window closed and hosting kept, a notification opens it with the request showing', async () => {
    const stub = () =>
      host.app.evaluate(({ Notification }) => {
        const g = globalThis as unknown as {
          __notes: { title: string; body: string }[];
          __lastNote: Electron.Notification | null;
        };
        g.__notes = [];
        g.__lastNote = null;
        Notification.prototype.show = function (this: Electron.Notification) {
          g.__notes.push({ title: this.title, body: this.body });
          g.__lastNote = this;
        };
      });
    await stub();
    await host.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
    });
    await host.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.isVisible()) w.close();
    });
    await expect
      .poll(() =>
        host.app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
        ),
      )
      .toBe(0);

    const tab = await newTab();
    await pasteCode(tab.page, code);
    await askToJoin(tab.page, 'Knocking Friend');
    await expect
      .poll(
        () =>
          host.app.evaluate(
            () => (globalThis as unknown as { __notes: { body: string }[] }).__notes,
          ),
        { timeout: 30_000 },
      )
      .toEqual([expect.objectContaining({ body: expect.stringContaining('Knocking Friend') })]);

    const opened = host.app.waitForEvent('window');
    await host.app.evaluate(() => {
      (globalThis as unknown as { __lastNote: Electron.Notification }).__lastNote.emit('click');
    });
    host.page = await opened;
    await host.page.waitForLoadState('domcontentloaded');
    await letIn(host.page, 'Knocking Friend');
    await expectInTheRoom(tab.page);
    await tab.context.close();
  });

  test('proof 9: a wait of over 3 minutes, a dropped connection, and the host away and back', async () => {
    test.setTimeout(600_000);
    const tab = await newTab();
    await pasteCode(tab.page, code);
    await askToJoin(tab.page, 'Patient Friend');
    await expect(askingCard(host.page, 'Patient Friend')).toBeVisible({ timeout: 45_000 });
    const started = Date.now();

    await tab.context.setOffline(true);
    await tab.page.waitForTimeout(20_000);
    await tab.context.setOffline(false);
    await expect(tab.page.getByTestId('ask-waiting')).toBeVisible();

    await host.app.close();
    await tab.page.waitForTimeout(20_000);
    await expect(tab.page.getByTestId('ask-waiting')).toBeVisible();
    await shot(tab.page, 'waiting-host-away');
    host = await launch(hostDir);
    await expectInTheRoom(host.page);
    await expect(askingCard(host.page, 'Patient Friend')).toBeVisible({ timeout: 120_000 });

    const left = 3 * 60_000 + 20_000 - (Date.now() - started);
    if (left > 0) await tab.page.waitForTimeout(left);
    await expect(tab.page.getByTestId('ask-waiting')).toBeVisible();
    expect(Date.now() - started).toBeGreaterThan(3 * 60_000);
    await expect(askingCard(host.page, 'Patient Friend')).toBeVisible({ timeout: 60_000 });

    await letIn(host.page, 'Patient Friend');
    await expectInTheRoom(tab.page);
    await tab.context.close();
  });
});
