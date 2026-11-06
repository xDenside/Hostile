import { expect, test, type Page, type Route } from '@playwright/test';
import { joinVoice, openTextChannel, sendMessage, signIn, USERS } from './helpers';

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const row = (page: Page, text: string) =>
  page.getByRole('log').locator('[data-message-id]').filter({ hasText: text });

async function rewriteTimes(page: Page, times: Map<string, string>) {
  await page.route('**/api/channels/*/messages?*', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as {
      messages: { content: string; createdAt: string }[];
    };
    for (const message of body.messages) {
      message.createdAt = times.get(message.content) ?? message.createdAt;
    }
    await route.fulfill({ response, json: body });
  });
}

test.describe('the time beside a message', () => {
  test('shows once for each minute, on one line, inside the gutter', async ({ browser }) => {
    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();
    await signIn(bob, USERS.bob);
    const aliceContext = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'UTC',
      viewport: { width: 1280, height: 860 },
    });
    const alice = await aliceContext.newPage();
    await signIn(alice, USERS.alice);

    const run = stamp();
    const before = `before ${run}`;
    const names = ['head', 'same-minute', 'next-minute', 'next-same', 'one-second-later'].map(
      (name) => `${name} ${run}`,
    );
    const [head, sameMinute, nextMinute, nextSame, oneSecondLater] = names as [
      string,
      string,
      string,
      string,
      string,
    ];

    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', before);
    await expect(row(bob, before)).toBeVisible();
    await openTextChannel(alice, 'general');
    await expect(row(alice, before)).toBeVisible();
    for (const text of names) {
      await sendMessage(alice, 'general', text);
      await expect(row(alice, text)).toBeVisible();
    }

    const minute = Math.floor(Date.now() / 60_000) - 3;
    const at = (minutes: number, seconds: number) =>
      new Date((minute + minutes) * 60_000 + seconds * 1000).toISOString();
    await rewriteTimes(
      alice,
      new Map([
        [head, at(0, 10)],
        [sameMinute, at(0, 50)],
        [nextMinute, at(1, 0)],
        [nextSame, at(1, 59)],
        [oneSecondLater, at(2, 0)],
      ]),
    );
    await alice.reload();
    await expect(row(alice, oneSecondLater)).toBeVisible();

    const hoverTime = (text: string) => row(alice, text).getByTestId('message-hover-time');
    await expect(row(alice, head).locator('time')).toHaveCount(1);
    await expect(hoverTime(head)).toHaveCount(0);
    await expect(hoverTime(sameMinute)).toHaveCount(0);
    await expect(hoverTime(nextSame)).toHaveCount(0);

    for (const text of [nextMinute, oneSecondLater]) {
      const time = hoverTime(text);
      await expect(time).toHaveCount(1);
      await expect(time).toHaveCSS('opacity', '0');
      await row(alice, text).hover();
      await expect(time).toHaveCSS('opacity', '1');
      await expect(time).toHaveText(/^\d\d:\d\d [AP]M$/);

      const box = (await time.boundingBox())!;
      const list = (await alice.getByRole('log').boundingBox())!;
      const body = (await row(alice, text).getByText(text).boundingBox())!;
      expect(box.height).toBeLessThan(16);
      expect(box.x).toBeGreaterThanOrEqual(list.x);
      expect(box.x + box.width).toBeLessThanOrEqual(body.x);
    }

    await aliceContext.close();
    await bobContext.close();
  });
});

test.describe('the line between two days', () => {
  test('is as far from the avatar above it as from the one below', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    await signIn(page, USERS.bob);
    const run = stamp();
    const [older, newer] = [`yesterday ${run}`, `today ${run}`];
    await openTextChannel(page, 'general');
    await sendMessage(page, 'general', older);
    await sendMessage(page, 'general', newer);
    const now = Date.now();
    await rewriteTimes(
      page,
      new Map([
        [older, new Date(now - 24 * 60 * 60 * 1000).toISOString()],
        [newer, new Date(now).toISOString()],
      ]),
    );
    await page.reload();
    await expect(row(page, newer)).toBeVisible();

    const gaps = await row(page, newer).evaluate((below) => {
      const line = [...below.closest('[role="log"]')!.querySelectorAll('[class*="daySeparator"]')]
        .pop()!
        .getBoundingClientRect();
      const middle = line.top + line.height / 2;
      const rows = [...below.closest('[role="log"]')!.querySelectorAll('[data-message-id]')];
      const above = rows[rows.indexOf(below) - 1]!;
      const avatar = (row: Element) =>
        row.querySelector('[class*="avatarSlot"]')!.getBoundingClientRect();
      return { above: middle - avatar(above).bottom, below: avatar(below).top - middle };
    });
    expect(Math.abs(gaps.above - gaps.below)).toBeLessThan(1);
    expect(gaps.below).toBeLessThan(24);
    await context.close();
  });
});

test.describe('the name on a large call tile', () => {
  test('reads larger than the rest of the tile, and so does "you"', async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ['microphone'],
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await signIn(page, USERS.alice);
    await joinVoice(page, 'General Voice');

    const tile = page.getByTestId('participant-tile').first();
    await expect(tile.getByText(USERS.alice.displayName)).toHaveCSS('font-size', '17px');
    await expect(tile.getByText('you', { exact: true })).toHaveCSS('font-size', '13px');

    await context.close();
  });
});

test.describe('the sidebar', () => {
  for (const who of [USERS.alice, USERS.bob]) {
    test(`has one Settings button, on your own card, for ${who.displayName}`, async ({
      browser,
    }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await signIn(page, who);
      const card = page.getByTestId('own-card');
      await expect(card.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
      await context.close();
    });
  }
});

test.describe('the name of the app', () => {
  test('is Hostile on the tab and at the door', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await expect(page).toHaveTitle('Hostile');
    await expect(page.getByLabel('Nickname')).toBeVisible();
    expect(await page.locator('body').innerText()).toContain('Hostile');
    await context.close();
  });
});
