import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';
import { pngFile } from '../e2e/attachment-fixtures';
import { joinVoice } from '../e2e/helpers';
import {
  askingCard,
  askToJoin,
  expectInTheRoom,
  GUEST_URL,
  joinThroughHost,
  launch,
  letIn,
  newUserDir,
  pasteCode,
  readCode,
  removeDir,
  turnAway,
  type Instance,
} from './host-harness';

function plainPng(side: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 2;
  return {
    name: 'huge.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.alloc((1 + side * 3) * side), { level: 1 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

const clearOfTheCard = (target: Locator) =>
  target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [r.left + 8, (r.left + r.right) / 2, r.right - 8].every((x) => {
      const hit = document.elementFromPoint(x, (r.top + r.bottom) / 2);
      return !!hit && !hit.closest('[data-testid=join-card]');
    });
  });

test.describe.serial('answering who asks, and waiting for an answer', () => {
  test.setTimeout(300_000);
  const hostDir = newUserDir('answerhost');
  const appDir = newUserDir('answerapp');
  let host: Instance;
  let browser: Browser;
  let code = '';

  const newTab = async (): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(GUEST_URL);
    return { context, page };
  };
  const openSettings = (tab: string) => async () => {
    await host.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await host.page.getByRole('button', { name: tab, exact: true }).click();
  };
  const openHosting = openSettings('Hosting');
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: test.info().outputPath(`${name}.png`) });

  test.beforeAll(async () => {
    browser = await chromium.launch({
      channel: 'chromium',
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
  });

  test.beforeEach(async () => {
    if (!host) return;
    await host.page.keyboard.press('Escape');
    await host.page.waitForTimeout(400);
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await host?.app.close().catch(() => undefined);
    removeDir(hostDir);
    removeDir(appDir);
  });

  test('a refused picture on the first run costs nothing: the next try makes the room', async () => {
    host = await launch(hostDir);
    const { page } = host;
    await page.getByRole('button', { name: 'Host a room' }).click();
    await page.getByLabel('Nickname').fill('Room Host');
    const create = page.getByRole('button', { name: 'Create my room' });

    await host.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.isVisible()) w.setContentSize(1280, 520);
    });
    await page.waitForTimeout(300);
    const offCentre = await create.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return Math.abs((r.left + r.right) / 2 - window.innerWidth / 2);
    });
    expect(offCentre).toBeLessThanOrEqual(1);
    await host.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.isVisible()) w.setContentSize(1280, 800);
    });

    await page.getByTestId('upload-avatar').setInputFiles(plainPng(5000));
    await create.click();
    await expect(page.getByText(/at most 4096 pixels/)).toBeVisible({ timeout: 90_000 });

    await page.getByTestId('upload-avatar').setInputFiles(pngFile('good.png', 200, 200, 6));
    await create.click();
    code = await readCode(page);
    await expect(page.locator('img[src*="/media/"]').first()).toBeAttached();

    for (let i = 0; i < 8; i += 1) {
      await expect(page.getByText(/voice server|Calls are not working/)).toHaveCount(0);
      await page.waitForTimeout(500);
    }
  });

  for (const gap of [150, 350]) {
    test(`a double click on Let in, ${gap} ms apart, lets in one person`, async () => {
      const friend = await newTab();
      const stranger = await newTab();
      await pasteCode(friend.page, code);
      await pasteCode(stranger.page, code);
      await askToJoin(friend.page, `Friend ${gap}`);
      await expect(askingCard(host.page, `Friend ${gap}`)).toBeVisible({ timeout: 45_000 });
      await askToJoin(stranger.page, `Stranger ${gap}`);
      await expect(host.page.getByTestId('join-card-more')).toContainText('1 more', {
        timeout: 30_000,
      });
      const button = askingCard(host.page, `Friend ${gap}`).getByRole('button', { name: 'Let in' });
      await expect(button).toBeEnabled();
      const box = (await button.boundingBox())!;
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await host.page.mouse.click(at.x, at.y);
      await host.page.waitForTimeout(gap);
      await host.page.mouse.click(at.x, at.y);

      await expectInTheRoom(friend.page);
      await stranger.page.waitForTimeout(4_500);
      await expect(stranger.page.getByTestId('ask-waiting')).toBeVisible();
      await expect(askingCard(host.page, `Stranger ${gap}`)).toBeVisible();
      await turnAway(host.page, `Stranger ${gap}`);
      await friend.context.close();
      await stranger.context.close();
    });
  }

  test('a double click in the Waiting list lets in one person too', async () => {
    await openHosting();
    const friend = await newTab();
    const stranger = await newTab();
    await pasteCode(friend.page, code);
    await pasteCode(stranger.page, code);
    await askToJoin(friend.page, 'List Friend');
    await expect(askingCard(host.page, 'List Friend')).toBeVisible({ timeout: 45_000 });
    await askToJoin(stranger.page, 'List Stranger');
    await expect(askingCard(host.page, 'List Stranger')).toBeVisible({ timeout: 30_000 });
    const button = askingCard(host.page, 'List Friend').getByRole('button', { name: 'Let in' });
    await expect(button).toBeEnabled();
    await host.page.waitForTimeout(800);
    const box = (await button.boundingBox())!;
    await host.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await host.page.waitForTimeout(250);
    await host.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expectInTheRoom(friend.page);
    await stranger.page.waitForTimeout(4_500);
    await expect(stranger.page.getByTestId('ask-waiting')).toBeVisible();
    await turnAway(host.page, 'List Stranger');
    await friend.context.close();
    await stranger.context.close();
  });

  test('the card leaves the message box and the Hosting tab free', async () => {
    const asker = await newTab();
    await pasteCode(asker.page, code);
    await askToJoin(asker.page, 'Long Asker');
    const card = host.page.getByTestId('join-card');
    await expect(card).toBeVisible({ timeout: 45_000 });

    const hide = host.page.getByRole('button', { name: 'Hide members' });
    if (await hide.isVisible()) await hide.click();
    await expect(host.page.getByRole('button', { name: 'Show members' })).toBeVisible();
    expect(await clearOfTheCard(host.page.getByLabel(/^Message #/).first())).toBe(true);

    await joinVoice(host.page, 'General Voice');
    const chat = host.page.getByTestId('voice-chat-toggle');
    if ((await chat.getAttribute('aria-pressed')) !== 'true') await chat.click();
    const inCall = host.page.getByLabel(/^Message /).last();
    await expect(inCall).toBeVisible();
    expect(await clearOfTheCard(inCall)).toBe(true);
    await shot(host.page, 'card-in-call');
    await host.page
      .getByRole('button', { name: /^Leave|Disconnect/ })
      .first()
      .click();

    await openHosting();
    await expect(card).toHaveCount(0);
    await expect(askingCard(host.page, 'Long Asker')).toBeVisible();
    await expect(host.page.getByRole('button', { name: 'Stop hosting' })).toBeVisible();

    await host.page.getByRole('button', { name: 'Members', exact: true }).click();
    await expect(card).toBeVisible();
    await host.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.isVisible()) w.setContentSize(1000, 400);
    });
    await host.page.waitForTimeout(300);
    const panel = host.page.getByTestId('settings-panel');
    await panel.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const remove = host.page
      .getByTestId('member-row')
      .getByRole('button', { name: 'Remove' })
      .last();
    expect(await clearOfTheCard(remove)).toBe(true);
    await host.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.isVisible()) w.setContentSize(1280, 800);
    });
    await turnAway(host.page, 'Long Asker');
    await asker.context.close();
  });

  test('asking over and over reaches an absent host about once in 10 s, and a pile-up says how many', async () => {
    await host.app.evaluate(({ Notification, BrowserWindow }) => {
      const g = globalThis as unknown as { __notes: { title: string; body: string }[] };
      g.__notes = [];
      Notification.prototype.show = function (this: Electron.Notification) {
        g.__notes.push({ title: this.title, body: this.body });
      };
      for (const w of BrowserWindow.getAllWindows()) w.isFocused = () => false;
    });
    const notes = () =>
      host.app.evaluate(() =>
        (globalThis as unknown as { __notes: { title: string; body: string }[] }).__notes.slice(),
      );
    const tab = await newTab();
    await pasteCode(tab.page, code);
    const started = Date.now();
    for (let i = 0; i < 10; i += 1) {
      await askToJoin(tab.page, `Again ${i}`);
      await tab.page.getByRole('button', { name: 'Cancel' }).click();
      await expect(tab.page.getByLabel('Nickname')).toBeVisible();
    }
    const elapsed = Date.now() - started;
    const flood = await notes();
    expect(flood.length, `10 asks in ${elapsed} ms`).toBeLessThanOrEqual(
      Math.floor(elapsed / 10_000) + 2,
    );

    const other = await newTab();
    await pasteCode(other.page, code);
    await askToJoin(tab.page, 'Pile One');
    await askToJoin(other.page, 'Pile Two');
    await expect
      .poll(async () => (await notes()).map((n) => n.title), { timeout: 25_000 })
      .toContain('2 people are asking to join');

    await host.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows())
        delete (w as unknown as { isFocused?: unknown }).isFocused;
    });
    await turnAway(host.page, 'Pile One');
    await turnAway(host.page, 'Pile Two');
    await tab.context.close();
    await other.context.close();
  });

  test('after a new code, a guest in the room can paste it there and then, and stays who they are', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const w = window as unknown as { __persistAsked: number };
      w.__persistAsked = 0;
      navigator.storage.persist = () => {
        w.__persistAsked += 1;
        return Promise.resolve(false);
      };
    });
    const page = await context.newPage();
    await page.goto(GUEST_URL);
    await joinThroughHost(host.page, page, code, 'Stays Themself');

    await openHosting();
    const old = code;
    await host.page.getByRole('button', { name: 'Make a new code' }).click();
    await host.page.getByRole('button', { name: 'Make a new code' }).last().click();
    await expect(host.page.getByTestId('hosting-code').locator('[class*="secret"]')).not.toHaveText(
      old,
      { timeout: 15_000 },
    );
    code = await readCode(host.page);

    const change = page.getByRole('button', { name: 'Use a different code' });
    await expect(change).toBeVisible({ timeout: 60_000 });
    await shot(page, 'host-away-banner');
    await change.click();
    await expect(page.getByLabel('Room code')).toHaveValue('');

    await page.getByLabel('Room code').fill(old);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByTestId('join-step').getByRole('status')).toHaveText(/\w/);
    await page.getByRole('button', { name: 'Use a different code' }).click();

    await page.getByLabel('Room code').fill(code);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expectInTheRoom(page);
    await expect(page.getByLabel('Nickname')).toHaveCount(0);
    await expect(page.getByText('Stays Themself').first()).toBeVisible();
    await expect(host.page.getByTestId('join-request')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __persistAsked: number }).__persistAsked),
    ).toBeGreaterThan(0);
    await context.close();
  });

  test('the waiting screen says what it is waiting for, and a long nickname stays inside the card', async () => {
    const tab = await newTab();
    await tab.page.setViewportSize({ width: 360, height: 640 });
    await pasteCode(tab.page, code);
    const nickname = 'M'.repeat(48);
    await askToJoin(tab.page, nickname);
    const waiting = tab.page.getByTestId('ask-waiting');
    await expect(waiting.getByText(`Waiting for the host, ${nickname}`)).toBeVisible();
    await shot(tab.page, 'waiting-long-name');
    const fits = await waiting.evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(fits).toBe(true);
    await turnAway(host.page, nickname);
    await tab.context.close();
  });

  test('a guest in the app has one Leave, under Room', async () => {
    const app = await launch(appDir);
    await app.page.getByRole('button', { name: 'Join with a code' }).click();
    await joinThroughHost(host.page, app.page, code, 'App Guest');
    await app.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    const leave = app.page.getByRole('button', { name: 'Leave', exact: true });
    await expect(leave).toHaveCount(0);
    await app.page.getByRole('button', { name: 'Room', exact: true }).click();
    await expect(leave).toHaveCount(1);
    await app.app.close();
  });

  test('letting the rest in still works', async () => {
    const tab = await newTab();
    await pasteCode(tab.page, code);
    await askToJoin(tab.page, 'Last One');
    await letIn(host.page, 'Last One');
    await expectInTheRoom(tab.page);
    await tab.context.close();
  });
});
