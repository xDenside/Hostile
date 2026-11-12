import { expect, test, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import { REAL_IMAGES } from '../apps/server/test/support/images';
import { pngFile, REAL_VIDEOS, user } from './attachment-fixtures';
import {
  answerDelete,
  channelButton,
  deleteQuestion,
  installRealtimeBlocker,
  openTextChannel,
  sendMessage,
  setRealtimeBlocked,
  signIn,
  USERS,
} from './helpers';

const PHONE = { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true };

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

async function csrf(page: Page): Promise<string> {
  const res = await page.request.get('/api/auth/session');
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

async function newChannel(owner: Page, type: 'text' | 'voice' = 'text', name = `t-${stamp()}`) {
  const res = await owner.request.post('/api/admin/channels', {
    data: { name, type },
    headers: { 'X-CSRF-Token': await csrf(owner) },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { channel: { id: string; name: string } };
  return body.channel;
}

interface Sent {
  id: string;
  seq: number;
}

async function post(
  page: Page,
  channelId: string,
  content: string,
  replyToId?: string,
): Promise<Sent> {
  const res = await page.request.post(`/api/channels/${channelId}/messages`, {
    data: { content, clientNonce: crypto.randomUUID(), ...(replyToId ? { replyToId } : {}) },
    headers: { 'X-CSRF-Token': await csrf(page) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { message: Sent }).message;
}

async function forwardTo(page: Page, messageId: string, channelId: string): Promise<Sent> {
  const res = await page.request.post(`/api/messages/${messageId}/forward`, {
    data: { channelId, clientNonce: crypto.randomUUID() },
    headers: { 'X-CSRF-Token': await csrf(page) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { message: Sent }).message;
}

interface PostedFile {
  id: string;
  url: string;
}

async function postFiles(
  page: Page,
  channelId: string,
  files: { name: string; bytes: Buffer }[],
  content = '',
): Promise<{ id: string; attachments: PostedFile[] }> {
  const headers = { 'X-CSRF-Token': await csrf(page) };
  const attachmentIds: string[] = [];
  for (const file of files) {
    const res = await page.request.post(
      `/api/channels/${channelId}/attachments?name=${encodeURIComponent(file.name)}`,
      { data: file.bytes, headers },
    );
    expect(res.status(), await res.text()).toBe(201);
    attachmentIds.push(((await res.json()) as { attachment: PostedFile }).attachment.id);
  }
  const res = await page.request.post(`/api/channels/${channelId}/messages`, {
    data: { content, clientNonce: crypto.randomUUID(), attachmentIds },
    headers,
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { message: { id: string; attachments: PostedFile[] } }).message;
}

async function holdOlderPages(page: Page) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/channels/*/messages?*', async (route) => {
    if (route.request().url().includes('before=')) await held;
    await route.continue();
  });
  return { release };
}

async function farQuote(owner: Page, channelId: string) {
  const originalText = `long ago ${stamp()}`;
  const original = await post(owner, channelId, originalText);
  for (let i = 0; i < 70; i++) await post(owner, channelId, `filler ${i} ${stamp()}`);
  const answer = `about that old thing ${stamp()}`;
  await post(owner, channelId, answer, original.id);
  return { original, originalText, answer };
}

async function pair(browser: Browser) {
  const a = await user(browser, USERS.alice);
  const b = await user(browser, USERS.bob);
  return {
    alice: a.page,
    bob: b.page,
    aliceContext: a.context,
    close: () => Promise.all([a.context.close(), b.context.close()]),
  };
}

const rowWith = (page: Page, text: string) =>
  page
    .getByTestId('message')
    .filter({ has: page.getByTestId('message-text').filter({ hasText: text }) })
    .last();

const hoverButton = async (row: Locator, name: string) => {
  await row.hover();
  return row.getByRole('button', { name, exact: true });
};

const menu = (page: Page) => page.getByTestId('message-menu');
const menuItem = (page: Page, name: string) =>
  menu(page).getByRole('menuitem', { name, exact: true });
const menuItems = (page: Page) =>
  menu(page)
    .getByRole('menuitem')
    .evaluateAll((items) => items.map((i) => i.textContent));

async function openMenu(row: Locator) {
  await row.click({ button: 'right' });
  await expect(row.page().getByTestId('message-menu')).toBeVisible();
}

const composer = (page: Page, channel: string) => page.getByLabel(`Message #${channel}`);

async function fingers(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (
    type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
    points: { x: number; y: number }[],
  ) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((point, id) => ({ ...point, id })),
    });
  return {
    down: (x: number, y: number) => send('touchStart', [{ x, y }]),
    downTwo: (a: { x: number; y: number }, b: { x: number; y: number }) =>
      send('touchStart', [a, b]),
    move: (x: number, y: number) => send('touchMove', [{ x, y }]),
    moveTwo: (a: { x: number; y: number }, b: { x: number; y: number }) =>
      send('touchMove', [a, b]),
    up: () => send('touchEnd', []),
    async drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', [
          {
            x: from.x + ((to.x - from.x) * i) / steps,
            y: from.y + ((to.y - from.y) * i) / steps,
          },
        ]);
        await page.waitForTimeout(16);
      }
    },
  };
}

const center = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const transformOf = (locator: Locator) =>
  locator.evaluate((el) => (el as HTMLElement).style.transform);

test.describe('replying', () => {
  test('by the hover button: the bar, the send, the quote, live for the other member', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const text = `Are we on tonight? ${stamp()}`;
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');
    await sendMessage(alice, 'general', text);
    const original = rowWith(bob, text);
    await expect(original).toBeVisible();

    await (await hoverButton(original, 'Reply')).click();
    const bar = bob.getByTestId('reply-bar');
    await expect(bar).toContainText('Replying to');
    await expect(bar).toContainText(USERS.alice.displayName);
    await expect(bar).toContainText(text);
    await expect(composer(bob, 'general')).toBeFocused();

    const answer = `Yes, at nine ${stamp()}`;
    await composer(bob, 'general').fill(answer);
    await composer(bob, 'general').press('Enter');
    await expect(bar).toHaveCount(0);

    for (const page of [bob, alice]) {
      const row = rowWith(page, answer);
      await expect(row).toBeVisible();
      const quote = row.getByTestId('reply-quote');
      await expect(quote).toContainText(USERS.alice.displayName);
      await expect(quote).toContainText(text);
    }

    await alice.reload();
    await expect(rowWith(alice, answer).getByTestId('reply-quote')).toContainText(text);
    await close();
  });

  test('by the menu, and Esc in the text field or the X cancels it', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const text = `Menu me ${stamp()}`;
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');
    await sendMessage(alice, 'general', text);
    const original = rowWith(bob, text);

    await openMenu(original);
    await menuItem(bob, 'Reply').click();
    await expect(menu(bob)).toHaveCount(0);
    const bar = bob.getByTestId('reply-bar');
    await expect(bar).toContainText(text);
    await bob.waitForTimeout(250);
    await expect(composer(bob, 'general')).toBeFocused();

    await bob.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);

    await openMenu(original);
    await menuItem(bob, 'Reply').click();
    await bar.getByRole('button', { name: 'Cancel reply' }).click();
    await expect(bar).toHaveCount(0);
    await expect(composer(bob, 'general')).toBeFocused();

    await openMenu(original);
    await menuItem(bob, 'Reply').click();
    let sends = 0;
    bob.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/messages')) sends++;
    });
    await composer(bob, 'general').press('Enter');
    await bob.waitForTimeout(150);
    expect(sends).toBe(0);
    await expect(bar).toBeVisible();

    const answer = `By the menu ${stamp()}`;
    await composer(bob, 'general').fill(answer);
    await composer(bob, 'general').press('Enter');
    await expect(rowWith(alice, answer).getByTestId('reply-quote')).toContainText(text);
    await close();
  });

  test('is held per channel, and is gone after a reload', async ({ browser }) => {
    const { alice, close } = await pair(browser);
    const text = `Held ${stamp()}`;
    await openTextChannel(alice, 'general');
    await sendMessage(alice, 'general', text);
    await (await hoverButton(rowWith(alice, text), 'Reply')).click();
    const bar = alice.getByTestId('reply-bar');
    await expect(bar).toBeVisible();

    await openTextChannel(alice, 'gaming');
    await expect(bar).toHaveCount(0);
    await openTextChannel(alice, 'general');
    await expect(bar).toContainText(text);

    await alice.reload();
    await expect(composer(alice, 'general')).toBeVisible();
    await expect(bar).toHaveCount(0);
    await close();
  });

  test('a reply starts a new group even under the same author, and its avatar sits by its head', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    await openTextChannel(bob, channel.name);
    const first = await post(bob, channel.id, `first ${stamp()}`);
    const plain = `plain follow-up ${stamp()}`;
    await post(bob, channel.id, plain);
    const answer = `quoting follow-up ${stamp()}`;
    await post(bob, channel.id, answer, first.id);

    const plainRow = rowWith(bob, plain);
    const answerRow = rowWith(bob, answer);
    await expect(answerRow).toBeVisible();
    await expect(plainRow.getByTestId('message-author')).toHaveCount(0);
    await expect(answerRow.getByTestId('message-author')).toBeVisible();

    const quote = (await answerRow.getByTestId('reply-quote').boundingBox())!;
    const head = (await answerRow.getByTestId('message-author').boundingBox())!;
    const avatar = (await answerRow
      .getByRole('button', { name: `Profile of ${USERS.bob.displayName}` })
      .boundingBox())!;
    expect(quote.y + quote.height).toBeLessThanOrEqual(head.y + 1);
    expect(avatar.y).toBeGreaterThanOrEqual(quote.y + quote.height - 1);
    await close();
  });

  test('with images, and with only images, in the same frame as the tray', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');
    const text = `Show me ${stamp()}`;
    await sendMessage(alice, 'general', text);
    const original = rowWith(bob, text);

    await (await hoverButton(original, 'Reply')).click();
    const name = `answer-${stamp()}.png`;
    await bob.getByTestId('attach-input').setInputFiles(pngFile(name));
    const bar = bob.getByTestId('reply-bar');
    await expect(bob.getByTestId('tray-file')).toContainText(name);
    await expect(bar).toBeVisible();
    const barBox = (await bar.boundingBox())!;
    const trayBox = (await bob.getByTestId('attachment-tray').boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(trayBox.y + 1);

    await bob.getByRole('button', { name: 'Send message' }).click();
    await expect(bar).toHaveCount(0);
    const withImage = alice
      .getByTestId('message')
      .filter({ has: alice.locator(`img[alt="${name}"]`) });
    await expect(withImage.getByTestId('reply-quote')).toContainText(text);
    await expect(withImage.getByTestId('message-text')).toHaveCount(0);

    await (await hoverButton(withImage, 'Reply')).click();
    await expect(alice.getByTestId('reply-bar')).toContainText('Photo');
    const noted = `Nice picture ${stamp()}`;
    await composer(alice, 'general').fill(noted);
    await composer(alice, 'general').press('Enter');
    await expect(rowWith(bob, noted).getByTestId('reply-quote')).toContainText('Photo');

    const both = `With words ${stamp()}`;
    const second = `second-${stamp()}.png`;
    await (await hoverButton(rowWith(bob, noted), 'Reply')).click();
    await bob.getByTestId('attach-input').setInputFiles(pngFile(second));
    await composer(bob, 'general').fill(both);
    await composer(bob, 'general').press('Enter');
    const last = rowWith(alice, both);
    await expect(last.getByTestId('reply-quote')).toContainText(noted);
    await expect(last.locator(`img[alt="${second}"]`)).toBeVisible();
    await close();
  });

  test('a pending row shows the quote, a retry keeps it, and a reload keeps it too', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');
    const text = `Quote me pending ${stamp()}`;
    await sendMessage(alice, 'general', text);
    const original = rowWith(bob, text);

    let refused = 0;
    await bob.route('**/api/channels/*/messages', async (route) => {
      if (route.request().method() === 'POST' && refused === 0) {
        refused++;
        await route.fulfill({
          status: 400,
          json: { error: { code: 'validation_error', message: 'Not today.' } },
        });
        return;
      }
      await route.continue();
    });

    await (await hoverButton(original, 'Reply')).click();
    const answer = `Eventually ${stamp()}`;
    await composer(bob, 'general').fill(answer);
    await composer(bob, 'general').press('Enter');
    const pending = bob.getByTestId('pending-message').filter({ hasText: answer });
    await expect(pending.getByTestId('reply-quote')).toContainText(text);
    await expect(pending).toContainText('Not sent');

    await bob.reload();
    const restored = bob.getByTestId('pending-message').filter({ hasText: answer });
    await expect(restored.getByTestId('reply-quote')).toContainText(text);

    const sent = bob.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/messages') && r.postData() !== null,
    );
    await restored.getByRole('button', { name: 'Retry' }).click();
    const body = (await sent).postDataJSON() as { replyToId?: string };
    expect(body.replyToId).toEqual(expect.any(String));
    await expect(rowWith(alice, answer).getByTestId('reply-quote')).toContainText(text);
    await close();
  });

  test('a quote follows its original: edited, then deleted, for someone watching', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');
    const text = `Before ${stamp()}`;
    await sendMessage(alice, 'general', text);
    await (await hoverButton(rowWith(bob, text), 'Reply')).click();
    const answer = `Answering ${stamp()}`;
    await composer(bob, 'general').fill(answer);
    await composer(bob, 'general').press('Enter');
    const quote = rowWith(bob, answer).getByTestId('reply-quote');
    await expect(quote).toContainText(text);

    const original = rowWith(alice, text);
    await (await hoverButton(original, 'Edit message')).click();
    const edited = `After ${stamp()}`;
    const box = alice.getByRole('textbox', { name: 'Edit message' });
    await box.fill(edited);
    await box.press('Enter');
    await expect(quote).toContainText(edited);

    await (await hoverButton(rowWith(alice, edited), 'Delete message')).click();
    await answerDelete(alice);
    await expect(quote).toContainText('Original message was deleted');
    await expect(rowWith(bob, answer).locator('button[data-testid="reply-quote"]')).toHaveCount(0);
    await close();
  });

  test('a quote catches up after a reconnect, through the changes it missed', async ({
    browser,
  }) => {
    const a = await user(browser, USERS.alice);
    const alice = a.page;
    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();
    await installRealtimeBlocker(bob);
    await signIn(bob, USERS.bob);
    const close = () => Promise.all([a.context.close(), bobContext.close()]);
    const channel = await newChannel(alice);
    await openTextChannel(bob, channel.name);
    const edited = await post(alice, channel.id, `to be edited ${stamp()}`);
    const deleted = await post(alice, channel.id, `to be deleted ${stamp()}`);
    const first = `answers the first ${stamp()}`;
    const second = `answers the second ${stamp()}`;
    await post(bob, channel.id, first, edited.id);
    await post(bob, channel.id, second, deleted.id);
    await expect(rowWith(bob, second)).toBeVisible();

    await setRealtimeBlocked(bob, true);
    const headers = { 'X-CSRF-Token': await csrf(alice) };
    const changed = `edited offline ${stamp()}`;
    await alice.request.patch(`/api/messages/${edited.id}`, {
      data: { content: changed },
      headers,
    });
    await alice.request.delete(`/api/messages/${deleted.id}`, { headers });
    await setRealtimeBlocked(bob, false);

    await expect(rowWith(bob, first).getByTestId('reply-quote')).toContainText(changed, {
      timeout: 40_000,
    });
    await expect(rowWith(bob, second).getByTestId('reply-quote')).toContainText(
      'Original message was deleted',
    );
    await close();
  });

  test('a reply being written follows its original too, and is accepted when it is gone', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');
    const text = `Going away ${stamp()}`;
    await sendMessage(alice, 'general', text);
    await (await hoverButton(rowWith(bob, text), 'Reply')).click();
    await expect(bob.getByTestId('reply-bar')).toContainText(text);

    await (await hoverButton(rowWith(alice, text), 'Delete message')).click();
    await answerDelete(alice);
    await expect(bob.getByTestId('reply-bar')).toContainText('Original message was deleted');

    const answer = `Too late, but still ${stamp()}`;
    await composer(bob, 'general').fill(answer);
    await composer(bob, 'general').press('Enter');
    await expect(rowWith(alice, answer).getByTestId('reply-quote')).toContainText(
      'Original message was deleted',
    );
    await close();
  });

  test('the quote line keeps name and words on one baseline, in every font a name can have', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    await openTextChannel(bob, 'general');
    const headers = { 'X-CSRF-Token': await csrf(alice) };
    const fonts = [
      'default',
      'unbounded',
      'playfair',
      'pacifico',
      'caveat',
      'pixel',
      'mono',
      'comfortaa',
      'russo',
    ];
    const channel = (
      (await (await bob.request.get('/api/bootstrap')).json()) as {
        channels: { id: string; name: string }[];
      }
    ).channels.find((c) => c.name === 'general')!;
    const original = await post(alice, channel.id, `Baselines ${stamp()}`);
    const answer = `Measuring ${stamp()}`;
    await post(bob, channel.id, answer, original.id);
    const quote = rowWith(bob, answer).getByTestId('reply-quote');

    try {
      for (const nameFont of fonts) {
        const res = await alice.request.patch('/api/auth/profile', {
          data: { nameFont },
          headers,
        });
        expect(res.status()).toBe(200);
        await expect(quote.locator(`[data-text]`)).toHaveClass(
          new RegExp(`font-?${nameFont}`, 'i'),
        );
        await bob.evaluate(() => document.fonts.ready);
        const drift = await quote.evaluate((el) => {
          const baseline = (host: Element) => {
            const probe = document.createElement('span');
            probe.style.cssText = 'display:inline-block;width:0;height:0';
            host.prepend(probe);
            const bottom = probe.getBoundingClientRect().bottom;
            probe.remove();
            return bottom;
          };
          const name = el.querySelector('[data-text]')!;
          const words = name.parentElement!.nextElementSibling!;
          return baseline(name) - baseline(words);
        });
        expect(Math.abs(drift), `${nameFont}: ${drift}`).toBeLessThan(1);
        expect((await quote.boundingBox())!.height, nameFont).toBe(20);
      }
    } finally {
      await alice.request.patch('/api/auth/profile', { data: { nameFont: 'default' }, headers });
    }
    await close();
  });
});

test.describe('the buttons on a message', () => {
  test('are on every message, with what applies to it, and only one row has them', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    await openTextChannel(alice, channel.name);
    await openTextChannel(bob, channel.name);
    const fromAlice = `from alice ${stamp()}`;
    const fromBob = `from bob ${stamp()}`;
    await post(alice, channel.id, fromAlice);
    await post(bob, channel.id, fromBob);

    const names = (row: Locator) =>
      row
        .locator('[data-row-actions] button')
        .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')));

    await rowWith(bob, fromAlice).hover();
    expect(await names(rowWith(bob, fromAlice))).toEqual(['Reply', 'Forward', 'Copy text']);
    await rowWith(bob, fromBob).hover();
    expect(await names(rowWith(bob, fromBob))).toEqual([
      'Reply',
      'Forward',
      'Copy text',
      'Edit message',
      'Delete message',
    ]);

    await rowWith(alice, fromBob).hover();
    expect(await names(rowWith(alice, fromBob))).toEqual([
      'Reply',
      'Forward',
      'Copy text',
      'Delete message',
    ]);
    await rowWith(alice, fromAlice).hover();
    expect(await names(rowWith(alice, fromAlice))).toEqual([
      'Reply',
      'Forward',
      'Copy text',
      'Edit message',
      'Delete message',
    ]);

    await expect(alice.locator('[data-row-actions]')).toHaveCount(1);
    await alice.getByLabel(`Message #${channel.name}`).hover();
    await expect(alice.locator('[data-row-actions]')).toHaveCount(0);
    await close();
  });

  test('moving between rows and starting an edit redraw only the rows concerned', async ({
    browser,
  }) => {
    const { alice, close } = await pair(browser);
    const channel = await newChannel(alice);
    await openTextChannel(alice, channel.name);
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const text = `row ${i} ${stamp()}`;
      texts.push(text);
      await post(alice, channel.id, text);
    }
    await expect(rowWith(alice, texts[5]!)).toBeVisible();

    await alice.evaluate(() => {
      const w = window as unknown as { __mutated: Set<string> };
      w.__mutated = new Set();
      const list = document.querySelector('[role="log"]')!;
      new MutationObserver((records) => {
        for (const record of records) {
          const row = (record.target as Element).closest?.('[data-message-id]');
          const actions = (record.target as Element).closest?.('[data-row-actions]');
          const addsActions = [...record.addedNodes, ...record.removedNodes].some((n) =>
            (n as Element).matches?.('[data-row-actions]'),
          );
          if (row && !actions && !addsActions) {
            w.__mutated.add((row as HTMLElement).dataset.messageId!);
          }
        }
      }).observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const mutated = () =>
      alice.evaluate(() => [...(window as unknown as { __mutated: Set<string> }).__mutated]);

    for (const text of texts) await rowWith(alice, text).hover();
    expect(await mutated()).toEqual([]);

    const id = await rowWith(alice, texts[2]!).getAttribute('data-message-id');
    const target = alice.locator(`[data-message-id="${id}"]`);
    await openMenu(target);
    await menuItem(alice, 'Edit').click();
    await expect(target.getByRole('textbox', { name: 'Edit message' })).toBeFocused();
    expect(await mutated()).toEqual([id]);
    await alice.keyboard.press('Escape');
    await expect(target.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0);
    await expect(target).toBeFocused();
    await close();
  });

  test('copying across messages takes their words, and none of the labels on their buttons', async ({
    browser,
  }) => {
    const { bob, close } = await pair(browser);
    await bob.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const id = stamp();
    const words = [`first words ${id}`, `second words ${id}`, `third words ${id}`];
    await openTextChannel(bob, 'general');
    for (const text of words) await sendMessage(bob, 'general', text);
    const box = (text: string) => rowWith(bob, text).getByTestId('message-text').boundingBox();
    await expect(rowWith(bob, words[2]!)).toBeVisible();

    const from = (await box(words[0]!))!;
    const to = (await box(words[2]!))!;
    await bob.mouse.move(from.x + 2, from.y + from.height / 2);
    await bob.mouse.down();
    await bob.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 12 });
    await bob.mouse.up();
    await expect(rowWith(bob, words[0]!).locator('[data-row-actions]')).toHaveCount(1);

    await bob.keyboard.press('ControlOrMeta+c');
    const copied = await bob.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(words[0]);
    expect(copied).toContain(`second words ${id}`);
    expect(copied).not.toMatch(/Reply|Forward|Copy text|Edit message|Delete message/);
    await close();
  });

  test('after an Alt-Tab, the row still has them and the keyboard is still on them', async ({
    browser,
  }) => {
    const { bob, close } = await pair(browser);
    const text = `Coming back ${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', text);
    const row = rowWith(bob, text);
    await row.focus();
    await bob.keyboard.press('Tab');
    const actions = row.locator('[data-row-actions]');
    const reply = actions.getByRole('button', { name: 'Reply', exact: true });
    await expect(reply).toBeFocused();

    await bob.evaluate(() => {
      document.hasFocus = () => false;
      document.activeElement!.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: null }),
      );
    });
    await bob.waitForTimeout(100);
    await expect(reply).toBeFocused();
    await expect(actions).toHaveCSS('opacity', '1');

    await bob.evaluate(() => {
      Reflect.deleteProperty(document, 'hasFocus');
    });
    await composer(bob, 'general').focus();
    await expect(actions).toHaveCount(0);
    await close();
  });

  test('deleting by keyboard leaves it on the next message, or else the one before', async ({
    browser,
  }) => {
    const { bob, close } = await pair(browser);
    const id = stamp();
    const [first, second, third] = [`one ${id}`, `two ${id}`, `three ${id}`] as const;
    await openTextChannel(bob, 'general');
    for (const text of [first, second, third]) await sendMessage(bob, 'general', text);
    await expect(rowWith(bob, third)).toBeVisible();

    await rowWith(bob, second).focus();
    await bob.keyboard.press('Shift+F10');
    await expect(menu(bob)).toBeVisible();
    await bob.keyboard.press('End');
    await bob.keyboard.press('Enter');
    await expect(deleteQuestion(bob).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await bob.keyboard.press('Tab');
    await bob.keyboard.press('Enter');
    await expect(bob.getByText(second)).toHaveCount(0);
    await expect(rowWith(bob, third)).toBeFocused();

    await bob.keyboard.press('Tab');
    const remove = rowWith(bob, third).getByRole('button', { name: 'Delete message' });
    await remove.focus();
    await expect(remove).toBeFocused();
    await bob.keyboard.press('Enter');
    await expect(deleteQuestion(bob).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await bob.keyboard.press('Tab');
    await bob.keyboard.press('Enter');
    await expect(bob.getByText(third)).toHaveCount(0);
    await expect(rowWith(bob, first)).toBeFocused();
    await close();
  });

  test('deleting with the mouse draws no ring round whatever is left', async ({ browser }) => {
    const { bob, close } = await pair(browser);
    const id = stamp();
    const [kept, gone] = [`kept ${id}`, `gone ${id}`] as const;
    await openTextChannel(bob, 'general');
    for (const text of [kept, gone]) await sendMessage(bob, 'general', text);
    await (await hoverButton(rowWith(bob, gone), 'Delete message')).click();
    await answerDelete(bob);
    await expect(bob.getByText(gone)).toHaveCount(0);
    await expect(rowWith(bob, kept)).toBeFocused();
    expect(await rowWith(bob, kept).evaluate((el) => el.matches(':focus-visible'))).toBe(false);
    await close();
  });

  test('Delete asks in the page, with the message in view, and only Delete deletes it', async ({
    browser,
  }) => {
    const { bob, close } = await pair(browser);
    const text = `Still here ${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', text);
    let browserAsked = false;
    bob.on('dialog', (d) => {
      browserAsked = true;
      void d.dismiss();
    });
    await (await hoverButton(rowWith(bob, text), 'Delete message')).click();

    const question = deleteQuestion(bob);
    await expect(question.getByTestId('forward-preview')).toContainText(text);
    await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await bob.keyboard.press('Escape');
    await expect(question).toHaveCount(0);
    await expect(rowWith(bob, text)).toBeFocused();

    await (await hoverButton(rowWith(bob, text), 'Delete message')).click();
    await expect(question).toBeVisible();
    await bob.mouse.click(5, 5);
    await expect(question).toHaveCount(0);
    await expect(rowWith(bob, text)).toBeVisible();

    const refuse = (route: Route) =>
      route.request().method() === 'DELETE' ? route.abort() : route.continue();
    await bob.route('**/api/messages/*', refuse);
    await (await hoverButton(rowWith(bob, text), 'Delete message')).click();
    await answerDelete(bob);
    await expect(question).toHaveCount(0);
    await expect(bob.getByText(/Could not delete/)).toBeVisible();
    await expect(rowWith(bob, text)).toBeVisible();
    await bob.unroute('**/api/messages/*', refuse);

    await (await hoverButton(rowWith(bob, text), 'Delete message')).click();
    await answerDelete(bob);
    await expect(bob.getByText(text)).toHaveCount(0);
    expect(browserAsked).toBe(false);
    await close();
  });

  test('a slow save does not close the edit started since, or take its focus', async ({
    browser,
  }) => {
    const { bob, close } = await pair(browser);
    const id = stamp();
    const [one, two] = [`first to change ${id}`, `second to change ${id}`] as const;
    await openTextChannel(bob, 'general');
    for (const text of [one, two]) await sendMessage(bob, 'general', text);
    const firstId = await rowWith(bob, one).getAttribute('data-message-id');
    const secondId = await rowWith(bob, two).getAttribute('data-message-id');
    const first = bob.locator(`[data-message-id="${firstId}"]`);
    const second = bob.locator(`[data-message-id="${secondId}"]`);

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await bob.route('**/api/messages/*', async (route) => {
      if (route.request().method() === 'PATCH') await held;
      await route.continue();
    });

    await openMenu(first);
    await menuItem(bob, 'Edit').click();
    const firstBox = first.getByRole('textbox', { name: 'Edit message' });
    const saved = `saved slowly ${id}`;
    await firstBox.fill(saved);
    await firstBox.press('Enter');

    await openMenu(second);
    await menuItem(bob, 'Edit').click();
    const secondBox = second.getByRole('textbox', { name: 'Edit message' });
    await expect(secondBox).toBeFocused();
    await secondBox.fill('still typing this');

    release();
    await expect(first).toContainText(saved);
    await expect(first).toContainText('(edited)');
    await bob.waitForTimeout(100);
    await expect(secondBox).toHaveValue('still typing this');
    await expect(secondBox).toBeFocused();
    await close();
  });
});

test.describe('the Copy button', () => {
  const pictureOnClipboard = (page: Page) =>
    page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const blob = await item!.getType('image/png');
      const bitmap = await createImageBitmap(blob);
      return {
        types: item!.types,
        signature: Array.from(new Uint8Array(await blob.slice(0, 4).arrayBuffer())),
        width: bitmap.width,
        height: bitmap.height,
      };
    });
  const textOnClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
  const clearClipboard = (page: Page) =>
    page.evaluate(() => navigator.clipboard.writeText('nothing yet'));
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

  async function reader(browser: Browser) {
    const { alice, bob, close } = await pair(browser);
    await bob.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const channel = await newChannel(alice);
    await openTextChannel(bob, channel.name);
    await clearClipboard(bob);
    return { alice, bob, channel, close };
  }

  const rowOf = (page: Page, message: { id: string }) =>
    page.locator(`[data-message-id="${message.id}"]`);
  const linkTo = (page: Page, file: PostedFile) => new URL(file.url, page.url()).href;

  test('takes the words of a message that has any, whatever else is on it', async ({ browser }) => {
    const { alice, bob, channel, close } = await reader(browser);
    const text = `Words first ${stamp()}`;
    const message = await postFiles(
      alice,
      channel.id,
      [{ name: 'beside.png', bytes: REAL_IMAGES.png.bytes }],
      text,
    );
    const row = rowOf(bob, message);
    await expect(row.getByTestId('message-text')).toHaveText(text);
    await (await hoverButton(row, 'Copy text')).click();
    await expect(bob.getByText('Text copied.')).toBeVisible();
    expect(await textOnClipboard(bob)).toBe(text);
    await close();
  });

  for (const [name, fixture] of [
    ['a PNG', REAL_IMAGES.png],
    ['a JPEG', REAL_IMAGES.jpeg],
    ['a WebP', REAL_IMAGES.webpLossy],
  ] as const) {
    test(`copies ${name} alone on its message as a PNG the clipboard really holds`, async ({
      browser,
    }) => {
      const { alice, bob, channel, close } = await reader(browser);
      const message = await postFiles(alice, channel.id, [
        { name: `picture-${stamp()}`, bytes: fixture.bytes },
      ]);
      const row = rowOf(bob, message);
      await expect(row.locator('img')).toBeVisible();
      await (await hoverButton(row, 'Copy image')).click();
      await expect(bob.getByText('Image copied.')).toBeVisible();
      const held = await pictureOnClipboard(bob);
      expect(held.types).toContain('image/png');
      expect(held.signature).toEqual(PNG_SIGNATURE);
      expect({ width: held.width, height: held.height }).toEqual({
        width: fixture.width,
        height: fixture.height,
      });
      await close();
    });
  }

  for (const [name, fixture] of [
    ['a GIF', REAL_IMAGES.gifAnimated],
    ['an animated WebP', REAL_IMAGES.webpAnimated],
    ['an animated PNG', REAL_IMAGES.apng],
  ] as const) {
    test(`copies ${name} as a link, since a PNG of it would stop moving`, async ({ browser }) => {
      const { alice, bob, channel, close } = await reader(browser);
      const message = await postFiles(alice, channel.id, [
        { name: `moving-${stamp()}`, bytes: fixture.bytes },
      ]);
      const row = rowOf(bob, message);
      await expect(row.locator('img')).toBeVisible();
      await row.hover();
      await row.locator('[data-row-actions] button').nth(2).click();
      await expect(bob.getByText('Link copied.')).toBeVisible();
      const link = await textOnClipboard(bob);
      expect(link).toBe(linkTo(bob, message.attachments[0]!));
      expect((await bob.request.get(link)).status()).toBe(200);
      await close();
    });
  }

  test('copies a GIF by a button that says it is a link', async ({ browser }) => {
    const { alice, bob, channel, close } = await reader(browser);
    const message = await postFiles(alice, channel.id, [
      { name: `moving-${stamp()}.gif`, bytes: REAL_IMAGES.gifAnimated.bytes },
    ]);
    const row = rowOf(bob, message);
    await expect(row.locator('img')).toBeVisible();
    await expect(await hoverButton(row, 'Copy link')).toBeVisible();
    await close();
  });

  test('copies a video as a link', async ({ browser }) => {
    const { alice, bob, channel, close } = await reader(browser);
    const message = await postFiles(alice, channel.id, [
      { name: `played-${stamp()}.webm`, bytes: REAL_VIDEOS.webm.bytes },
    ]);
    const row = rowOf(bob, message);
    await expect(row.getByTestId('attachment-video')).toBeVisible();
    await (await hoverButton(row, 'Copy link')).click();
    await expect(bob.getByText('Link copied.')).toBeVisible();
    expect(await textOnClipboard(bob)).toBe(linkTo(bob, message.attachments[0]!));
    await close();
  });

  test('copies several files as links, one to a line, in their order', async ({ browser }) => {
    const { alice, bob, channel, close } = await reader(browser);
    const message = await postFiles(alice, channel.id, [
      { name: `one-${stamp()}.png`, bytes: REAL_IMAGES.png.bytes },
      { name: `two-${stamp()}.webm`, bytes: REAL_VIDEOS.webm.bytes },
      { name: `three-${stamp()}.jpg`, bytes: REAL_IMAGES.jpeg.bytes },
    ]);
    const row = rowOf(bob, message);
    await expect(row.locator('img').first()).toBeVisible();
    await (await hoverButton(row, 'Copy links')).click();
    await expect(bob.getByText('Links copied.')).toBeVisible();
    expect(await textOnClipboard(bob)).toBe(
      message.attachments.map((file) => linkTo(bob, file)).join('\n'),
    );
    await close();
  });

  test('the menu offers the same, for the file under the pointer and for the message', async ({
    browser,
  }) => {
    const { alice, bob, channel, close } = await reader(browser);

    const picture = await postFiles(alice, channel.id, [
      { name: `alone-${stamp()}.png`, bytes: REAL_IMAGES.png.bytes },
    ]);
    const pictureRow = rowOf(bob, picture);
    await expect(pictureRow.locator('img')).toBeVisible();
    await pictureRow.locator('img').click({ button: 'right' });
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy image', 'Save image']);
    await menuItem(bob, 'Copy image').click();
    await expect(bob.getByText('Image copied.')).toBeVisible();
    expect((await pictureOnClipboard(bob)).signature).toEqual(PNG_SIGNATURE);

    const text = `Words and a picture ${stamp()}`;
    const both = await postFiles(
      alice,
      channel.id,
      [{ name: `with-${stamp()}.png`, bytes: REAL_IMAGES.png.bytes }],
      text,
    );
    const bothRow = rowOf(bob, both);
    await expect(bothRow.locator('img')).toBeVisible();
    await bothRow.locator('img').click({ button: 'right' });
    expect(await menuItems(bob)).toEqual([
      'Reply',
      'Forward',
      'Copy text',
      'Copy image',
      'Save image',
    ]);
    await bob.keyboard.press('Escape');
    await bothRow.getByTestId('message-text').click({ button: 'right' });
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy text']);
    await bob.keyboard.press('Escape');

    const moving = await postFiles(alice, channel.id, [
      { name: `moving-${stamp()}.gif`, bytes: REAL_IMAGES.gifAnimated.bytes },
    ]);
    const movingRow = rowOf(bob, moving);
    await expect(movingRow.locator('img')).toBeVisible();
    await movingRow.locator('img').click({ button: 'right' });
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy link', 'Save image']);
    await menuItem(bob, 'Copy link').click();
    await expect(bob.getByText('Link copied.')).toBeVisible();
    expect(await textOnClipboard(bob)).toBe(linkTo(bob, moving.attachments[0]!));

    const several = await postFiles(alice, channel.id, [
      { name: `a-${stamp()}.png`, bytes: REAL_IMAGES.png.bytes },
      { name: `b-${stamp()}.jpg`, bytes: REAL_IMAGES.jpeg.bytes },
    ]);
    const severalRow = rowOf(bob, several);
    await expect(severalRow.locator('img').first()).toBeVisible();
    const { width } = (await severalRow.boundingBox())!;
    await severalRow.click({ button: 'right', position: { x: width - 4, y: 4 } });
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy links']);
    await menuItem(bob, 'Copy links').click();
    await expect(bob.getByText('Links copied.')).toBeVisible();
    expect(await textOnClipboard(bob)).toBe(
      several.attachments.map((file) => linkTo(bob, file)).join('\n'),
    );
    await close();
  });

  test('a clipboard that will not take a picture gets the link instead', async ({ browser }) => {
    const { alice, bob, channel, close } = await reader(browser);
    const message = await postFiles(alice, channel.id, [
      { name: `refused-${stamp()}.png`, bytes: REAL_IMAGES.png.bytes },
    ]);
    const row = rowOf(bob, message);
    await expect(row.locator('img')).toBeVisible();
    await bob.evaluate(() => {
      navigator.clipboard.write = () => Promise.reject(new Error('no'));
    });
    await (await hoverButton(row, 'Copy image')).click();
    await expect(bob.getByText('Link copied.')).toBeVisible();
    expect(await textOnClipboard(bob)).toBe(linkTo(bob, message.attachments[0]!));
    await close();
  });

  test('a picture that cannot be fetched gets the link instead', async ({ browser }) => {
    const { alice, bob, channel, close } = await reader(browser);
    const message = await postFiles(alice, channel.id, [
      { name: `unreachable-${stamp()}.png`, bytes: REAL_IMAGES.png.bytes },
    ]);
    const row = rowOf(bob, message);
    await expect(row.locator('img')).toBeVisible();
    await bob.route('**/api/attachments/*', (route) => route.fulfill({ status: 503, body: '' }));
    await (await hoverButton(row, 'Copy image')).click();
    await expect(bob.getByText('Link copied.')).toBeVisible();
    expect(await textOnClipboard(bob)).toBe(linkTo(bob, message.attachments[0]!));
    await close();
  });

  test('a clipboard that will take nothing says so', async ({ browser }) => {
    const { alice, bob, channel, close } = await reader(browser);
    const message = await postFiles(alice, channel.id, [
      { name: `nothing-${stamp()}.png`, bytes: REAL_IMAGES.png.bytes },
    ]);
    const row = rowOf(bob, message);
    await expect(row.locator('img')).toBeVisible();
    await bob.evaluate(() => {
      navigator.clipboard.write = () => Promise.reject(new Error('no'));
      navigator.clipboard.writeText = () => Promise.reject(new Error('no'));
    });
    await (await hoverButton(row, 'Copy image')).click();
    await expect(bob.getByText('Could not copy that. This browser refused.')).toBeVisible();
    await close();
  });
});

test.describe('the menu', () => {
  test('on your own message has everything, in order, with the separator before the last two', async ({
    browser,
  }) => {
    const { bob, close } = await pair(browser);
    const text = `Mine ${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', text);
    const row = rowWith(bob, text);
    await openMenu(row);
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy text', 'Edit', 'Delete']);
    const order = await menu(bob).evaluate((el) =>
      [...el.children].map((c) => (c.getAttribute('role') === 'menuitem' ? 'item' : 'rule')),
    );
    expect(order).toEqual(['item', 'item', 'item', 'rule', 'item', 'item']);
    const color = (name: string) =>
      menuItem(bob, name).evaluate((el) => getComputedStyle(el).color);
    expect(await color('Delete')).not.toBe(await color('Edit'));
    await close();
  });

  test("on someone else's: without Edit or Delete, and no separator with nothing after it", async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const text = `Theirs ${stamp()}`;
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');
    await sendMessage(alice, 'general', text);
    await openMenu(rowWith(bob, text));
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy text']);
    const roles = await menu(bob).evaluate((el) =>
      [...el.children].map((c) => c.getAttribute('role')),
    );
    expect(roles).toEqual(['menuitem', 'menuitem', 'menuitem']);
    await close();
  });

  test('as the owner, Delete on anyone, and it works', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const text = `Moderated ${stamp()}`;
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', text);
    await openMenu(rowWith(alice, text));
    expect(await menuItems(alice)).toEqual(['Reply', 'Forward', 'Copy text', 'Delete']);
    await menuItem(alice, 'Delete').click();
    await answerDelete(alice);
    await expect(bob.getByText(text)).toHaveCount(0);
    await expect(alice.getByText(text)).toHaveCount(0);
    await close();
  });

  test('Edit and Delete act on your own message, and Delete asks first', async ({ browser }) => {
    const { bob, close } = await pair(browser);
    const text = `Change me ${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', text);
    const row = rowWith(bob, text);

    await openMenu(row);
    await menuItem(bob, 'Edit').click();
    const box = bob.getByRole('textbox', { name: 'Edit message' });
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(text);
    const changed = `Changed ${stamp()}`;
    await box.fill(changed);
    await box.press('Enter');
    await expect(rowWith(bob, changed)).toContainText('(edited)');

    await openMenu(rowWith(bob, changed));
    await menuItem(bob, 'Delete').click();
    await deleteQuestion(bob).getByRole('button', { name: 'Cancel' }).click();
    await expect(deleteQuestion(bob)).toHaveCount(0);
    await expect(rowWith(bob, changed)).toBeVisible();

    await openMenu(rowWith(bob, changed));
    await menuItem(bob, 'Delete').click();
    await answerDelete(bob);
    await expect(bob.getByText(changed)).toHaveCount(0);
    await close();
  });

  test('Copy text copies the whole message, and says so', async ({ browser }) => {
    const { bob, close } = await pair(browser);
    await bob.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const text = `Copy all of this ${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', text);
    await openMenu(rowWith(bob, text));
    await menuItem(bob, 'Copy text').click();
    await expect(bob.getByText('Text copied.')).toBeVisible();
    expect(await bob.evaluate(() => navigator.clipboard.readText())).toBe(text);
    await close();
  });

  test('Copy selection takes its place when text in that message is selected', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    await bob.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const other = `Another message ${stamp()}`;
    const text = `Select part of this ${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(alice, 'general', other);
    await sendMessage(alice, 'general', text);
    const row = rowWith(bob, text);
    await expect(row).toBeVisible();

    const select = () =>
      row.getByTestId('message-text').evaluate((el) => {
        const node = el.firstChild!;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 'Select part'.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });

    await select();
    await openMenu(row);
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy selection']);
    await menuItem(bob, 'Copy selection').click();
    await expect(bob.getByText('Selection copied.')).toBeVisible();
    expect(await bob.evaluate(() => navigator.clipboard.readText())).toBe('Select part');

    await select();
    await openMenu(rowWith(bob, other));
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy text']);
    await bob.keyboard.press('Escape');

    await bob.evaluate(() => window.getSelection()!.removeAllRanges());
    await row.getByTestId('message-text').click({ button: 'right' });
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy text']);
    await close();
  });

  test('a clipboard that refuses says so', async ({ browser }) => {
    const { bob, close } = await pair(browser);
    const text = `Refused ${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', text);
    await bob.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('no')) },
      });
    });
    await openMenu(rowWith(bob, text));
    await menuItem(bob, 'Copy text').click();
    await expect(bob.getByText('Could not copy that. This browser refused.')).toBeVisible();
    await close();
  });

  test('Save appears for the file under the pointer: image and video, and downloads it', async ({
    browser,
  }) => {
    const { bob, close } = await pair(browser);
    await openTextChannel(bob, 'general');
    const image = `saved-${stamp()}.png`;
    const video = `saved-${stamp()}.webm`;
    await bob.getByTestId('attach-input').setInputFiles([
      pngFile(image),
      {
        name: video,
        mimeType: 'video/webm',
        buffer: REAL_VIDEOS.webm.bytes,
      },
    ]);
    await bob.getByRole('button', { name: 'Send message' }).click();
    const row = bob.getByTestId('message').filter({ has: bob.locator(`img[alt="${image}"]`) });
    const picture = row.locator(`img[alt="${image}"]`);
    await expect(picture).toBeVisible();

    await picture.click({ button: 'right' });
    expect(await menuItems(bob)).toEqual([
      'Reply',
      'Forward',
      'Copy image',
      'Save image',
      'Edit',
      'Delete',
    ]);
    const saving = bob.waitForEvent('download');
    await menuItem(bob, 'Save image').click();
    expect((await saving).suggestedFilename()).toBe(image);
    await expect(menu(bob)).toHaveCount(0);

    const player = row.getByTestId('attachment-video').locator('video');
    await player.click({ button: 'right', position: { x: 4, y: 4 } });
    expect(await menuItems(bob)).toContain('Save video');
    expect(await menuItems(bob)).not.toContain('Save image');
    await bob.keyboard.press('Escape');
    await expect(menu(bob)).toHaveCount(0);

    const box = (await row.boundingBox())!;
    await bob.mouse.click(box.x + box.width - 4, box.y + 4, { button: 'right' });
    await expect(menu(bob)).toBeVisible();
    expect(await menuItems(bob)).not.toContain('Save image');
    expect(await menuItems(bob)).not.toContain('Save video');
    await close();
  });

  test('works by keyboard alone, and focus comes back to the message', async ({ browser }) => {
    const { bob, close } = await pair(browser);
    const text = `Keys ${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', text);
    const row = rowWith(bob, text);
    await row.focus();
    await expect(row).toBeFocused();

    const focused = () => bob.evaluate(() => document.activeElement?.textContent);

    await bob.keyboard.press('Shift+F10');
    await expect(menu(bob)).toBeVisible();
    await expect(menu(bob).getByRole('menuitem').first()).toBeFocused();
    await expect(bob.getByRole('menu', { name: 'Message actions' })).toBeVisible();
    const rowBox = (await row.boundingBox())!;
    await expect
      .poll(async () => {
        const box = (await menu(bob).boundingBox())!;
        return Math.abs(box.x - (rowBox.x + 16)) < 40;
      })
      .toBe(true);

    await bob.keyboard.press('ArrowDown');
    expect(await focused()).toBe('Forward');
    await bob.keyboard.press('ArrowDown');
    expect(await focused()).toBe('Copy text');
    await bob.keyboard.press('ArrowUp');
    expect(await focused()).toBe('Forward');
    await bob.keyboard.press('End');
    expect(await focused()).toBe('Delete');
    await bob.keyboard.press('ArrowDown');
    expect(await focused()).toBe('Reply');
    await bob.keyboard.press('Home');
    expect(await focused()).toBe('Reply');
    await bob.keyboard.press('ArrowUp');
    expect(await focused()).toBe('Delete');

    await bob.keyboard.press('Escape');
    await expect(menu(bob)).toHaveCount(0);
    await expect(row).toBeFocused();

    await bob.keyboard.press('ContextMenu');
    await expect(menu(bob)).toBeVisible();
    await bob.keyboard.press('ArrowDown');
    await bob.keyboard.press('ArrowDown');
    await bob.keyboard.press('Enter');
    await expect(menu(bob)).toHaveCount(0);
    await expect(bob.getByRole('alert').or(bob.getByText(/copied|Could not copy/))).toBeVisible();

    await row.focus();
    await bob.keyboard.press('Shift+F10');
    await expect(menu(bob).getByRole('menuitem').first()).toBeFocused();
    await bob.keyboard.press('Enter');
    await bob.waitForTimeout(250);
    await expect(composer(bob, 'general')).toBeFocused();
    await bob.keyboard.press('Escape');

    await row.focus();
    await bob.keyboard.press('Tab');
    const actions = row.locator('[data-row-actions]');
    await expect(actions.getByRole('button', { name: 'Reply', exact: true })).toBeFocused();
    await expect(actions).toHaveCSS('opacity', '1');
    await close();
  });

  test("Shift + right-click and a link leave the browser's menu alone", async ({ browser }) => {
    const { alice: owner, bob, close } = await pair(browser);
    const text = `Native ${stamp()}`;
    const url = `https://example.com/page-${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', `${text} ${url}`);
    const row = rowWith(bob, text);
    await expect(row).toBeVisible();

    await bob.evaluate(() => {
      const w = window as unknown as { __prevented: boolean | null };
      w.__prevented = null;
      window.addEventListener('contextmenu', (e) => {
        w.__prevented = e.defaultPrevented;
      });
    });
    const prevented = () =>
      bob.evaluate(() => (window as unknown as { __prevented: boolean | null }).__prevented);

    await row.getByRole('link').click({ button: 'right' });
    expect(await prevented()).toBe(false);
    await expect(menu(bob)).toHaveCount(0);

    await row
      .getByTestId('message-text')
      .click({ button: 'right', modifiers: ['Shift'], position: { x: 4, y: 8 } });
    expect(await prevented()).toBe(false);
    await expect(menu(bob)).toHaveCount(0);

    const channel = await newChannel(owner);
    await openTextChannel(bob, channel.name);
    const named = `Named ${stamp()}`;
    await post(owner, channel.id, named);
    await bob.evaluate(() => {
      (window as unknown as { __prevented: boolean | null }).__prevented = null;
    });
    await rowWith(bob, named)
      .getByTestId('message-author')
      .click({ button: 'right', modifiers: ['Shift'] });
    expect(await prevented()).toBe(false);
    await expect(bob.getByTestId('member-menu')).toHaveCount(0);
    await openTextChannel(bob, 'general');

    await row.getByTestId('message-text').click({ button: 'right', position: { x: 4, y: 8 } });
    expect(await prevented()).toBe(true);
    await expect(menu(bob)).toBeVisible();
    await close();
  });

  test('a name and an avatar keep their own member menu', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    await openTextChannel(bob, channel.name);
    const text = `Named ${stamp()}`;
    await post(alice, channel.id, text);
    const row = rowWith(bob, text);
    await row.getByTestId('message-author').click({ button: 'right' });
    await expect(bob.getByTestId('member-menu')).toBeVisible();
    await expect(menu(bob)).toHaveCount(0);
    await bob.keyboard.press('Escape');
    await row
      .getByRole('button', { name: `Profile of ${USERS.alice.displayName}` })
      .click({ button: 'right' });
    await expect(bob.getByTestId('member-menu')).toBeVisible();
    await expect(menu(bob)).toHaveCount(0);
    await close();
  });

  test('closes on an outside press, Esc, a scroll, a resize and a channel change', async ({
    browser,
  }) => {
    const { alice, close } = await pair(browser);
    const channel = await newChannel(alice);
    await openTextChannel(alice, channel.name);
    const texts: string[] = [];
    for (let i = 0; i < 40; i++) {
      const text = `scrolling ${i} ${stamp()}`;
      texts.push(text);
      await post(alice, channel.id, `${text}\n\n`);
    }
    const row = rowWith(alice, texts[39]!);
    await expect(row).toBeVisible();

    await openMenu(row);
    await alice.mouse.click(700, 80);
    await expect(menu(alice)).toHaveCount(0);

    await openMenu(row);
    await alice.keyboard.press('Escape');
    await expect(menu(alice)).toHaveCount(0);

    await openMenu(row);
    const box = (await alice.getByRole('log').boundingBox())!;
    await alice.mouse.move(box.x + box.width - 60, box.y + 60);
    await alice.mouse.wheel(0, -200);
    await expect(menu(alice)).toHaveCount(0);

    await alice.getByRole('log').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(row).toBeInViewport();
    await openMenu(row);
    await alice.getByRole('log').evaluate((el) => (el.scrollTop = 0));
    await expect(menu(alice)).toHaveCount(0);

    await alice.getByRole('log').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(row).toBeInViewport();
    await openMenu(row);
    await alice.setViewportSize({ width: 1100, height: 860 });
    await expect(menu(alice)).toHaveCount(0);
    await alice.setViewportSize({ width: 1280, height: 860 });

    await expect(row).toBeInViewport();
    await openMenu(row);
    await alice.evaluate(() => {
      const button = [...document.querySelectorAll('nav button')].find((b) =>
        b.textContent?.startsWith('general'),
      ) as HTMLElement;
      button.click();
    });
    await expect(menu(alice)).toHaveCount(0);
    await close();
  });

  test('stays open when a message arrives and the list follows it', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    await openTextChannel(alice, channel.name);
    const text = `Staying ${stamp()}`;
    await post(alice, channel.id, Array(50).fill(text).join('\n'));
    const row = rowWith(alice, text);
    await expect(row).toBeVisible();
    const box = (await row.boundingBox())!;
    await alice.mouse.click(box.x + 100, box.y + box.height - 20, { button: 'right' });
    await expect(menu(alice)).toBeVisible();
    const after = `Arriving ${stamp()}`;
    await post(bob, channel.id, after);
    await expect(rowWith(alice, after)).toBeInViewport();
    await alice.waitForTimeout(300);
    await expect(menu(alice)).toBeVisible();
    await close();
  });

  test('stays open through the end of a scroll that had finished before it opened', async ({
    browser,
  }) => {
    const { alice, close } = await pair(browser);
    const channel = await newChannel(alice);
    await openTextChannel(alice, channel.name);
    const text = `Just stopped ${stamp()}`;
    await post(alice, channel.id, Array(60).fill(text).join('\n'));
    const row = rowWith(alice, text);
    await expect(row).toBeVisible();
    await alice.getByRole('log').evaluate((list) => {
      list.scrollTop -= 200;
      const target = list.querySelector('[data-testid="message-text"]')!;
      const box = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: box.left + 10,
          clientY: Math.max(box.top, 100) + 10,
        }),
      );
    });
    await expect(menu(alice)).toBeVisible();
    await alice.waitForTimeout(300);
    await expect(menu(alice)).toBeVisible();
    await close();
  });

  test("stays open as the list grows because a phone's keyboard went away", async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const texts: string[] = [];
    for (let i = 0; i < 40; i++) {
      texts.push(`row ${i} ${stamp()}`);
      await post(alice, channel.id, texts[i]!);
    }
    await bob.setViewportSize({ width: 1280, height: 700 });
    await openTextChannel(bob, channel.name);
    const list = bob.getByRole('log');
    await expect(rowWith(bob, texts[39]!)).toBeInViewport();
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 120));
    await expect(bob.getByRole('button', { name: 'Newest messages' })).toBeVisible();
    const before = await list.evaluate((el) => el.scrollTop);
    const box = (await rowWith(bob, texts[30]!).boundingBox())!;
    await bob.mouse.click(box.x + 100, box.y + box.height / 2, { button: 'right' });
    await expect(menu(bob)).toBeVisible();
    expect(await list.evaluate((el) => el.scrollTop)).toBe(before);

    await bob.setViewportSize({ width: 1280, height: 1000 });
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeLessThan(before);
    await bob.waitForTimeout(300);
    await expect(menu(bob)).toBeVisible();
    await close();
  });

  test('stays inside the window at every edge, and at a phone width', async ({ browser }) => {
    const { bob, close } = await pair(browser);
    const text = `Edges ${stamp()}`;
    await openTextChannel(bob, 'general');
    await sendMessage(bob, 'general', text);
    const row = rowWith(bob, text);
    await expect(row).toBeVisible();
    const viewport = bob.viewportSize()!;

    const inside = async () => {
      await expect
        .poll(async () => (await menu(bob).boundingBox())?.width, { timeout: 5000 })
        .toBeGreaterThan(200);
      await bob.waitForTimeout(250);
      const box = (await menu(bob).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    };

    const rowBox = (await row.boundingBox())!;
    await bob.mouse.click(rowBox.x + rowBox.width - 2, rowBox.y + rowBox.height - 2, {
      button: 'right',
    });
    await inside();
    await close();
  });

  test('its rows are 44 pixels under a finger', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Fingers ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    await openMenu(row);
    const heights = await menu(page)
      .getByRole('menuitem')
      .evaluateAll((items) => items.map((i) => (i as HTMLElement).offsetHeight));
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    await context.close();
  });
});

test.describe('under a finger', () => {
  test('a swipe left past the threshold starts a reply, and the row comes back', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Swipe me ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __vibrated: number[] };
      w.__vibrated = [];
      Object.defineProperty(navigator, 'vibrate', {
        value: (ms: number) => w.__vibrated.push(ms) > 0,
      });
    });
    const vibrations = () =>
      page.evaluate(() => (window as unknown as { __vibrated: number[] }).__vibrated);
    const touch = await fingers(page);
    const from = await center(row);

    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x - 40, y: from.y });
    expect(await transformOf(row)).toBe('translateX(-40px)');
    const icon = page.getByTestId('swipe-icon');
    const opacity = () => icon.evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(await opacity()).toBeGreaterThan(0.4);
    expect(await opacity()).toBeLessThan(1);
    await expect(icon).not.toHaveAttribute('data-armed');
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    expect(await vibrations()).toEqual([]);

    await touch.drag({ x: from.x - 40, y: from.y }, { x: from.x - 80, y: from.y });
    const moved = await transformOf(row);
    expect(moved).toMatch(/translateX\(-\d+/);
    await expect(icon).toHaveAttribute('data-armed');
    expect(await opacity()).toBe(1);
    expect(await vibrations()).toEqual([10]);
    await touch.drag({ x: from.x - 80, y: from.y }, { x: from.x - 110, y: from.y });
    expect(await vibrations()).toEqual([10]);
    await touch.up();

    await expect(page.getByTestId('reply-bar')).toContainText(text);
    await expect.poll(() => transformOf(row)).toBe('');
    await expect(composer(page, 'general')).toBeFocused();
    await context.close();
  });

  test('a swipe short of the threshold springs back and does nothing', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Not far enough ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    const touch = await fingers(page);
    const from = await center(row);
    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x - 50, y: from.y });
    expect(await transformOf(row)).toBe('translateX(-50px)');
    await touch.up();
    await expect.poll(() => transformOf(row)).toBe('');
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    await context.close();
  });

  test('with reduced motion asked for, it goes straight back', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, {
      ...PHONE,
      reducedMotion: 'reduce',
    });
    const text = `No spring ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    const touch = await fingers(page);
    const from = await center(row);
    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x - 50, y: from.y });
    expect(await transformOf(row)).toBe('translateX(-50px)');
    await touch.up();
    await expect.poll(() => transformOf(row), { timeout: 200 }).toBe('');
    expect(await row.evaluate((el) => (el as HTMLElement).style.transition)).toBe('');
    await context.close();
  });

  test('a swipe that is taken back before letting go does nothing', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Changed my mind ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    const touch = await fingers(page);
    const from = await center(row);
    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x - 90, y: from.y });
    await touch.drag({ x: from.x - 90, y: from.y }, { x: from.x - 10, y: from.y });
    await touch.up();
    await expect.poll(() => transformOf(row)).toBe('');
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    await context.close();
  });

  test('a vertical swipe scrolls the list and does not reply', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Scroll past ${stamp()}`;
    await sendMessage(page, 'general', Array(60).fill(text).join('\n'));
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    const list = page.getByRole('log');
    const before = await list.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(200);

    const box = (await list.boundingBox())!;
    const from = { x: box.x + box.width / 2, y: box.y + 120 };
    const touch = await fingers(page);
    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x, y: from.y + 300 }, 12);
    await touch.up();

    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeLessThan(before - 100);
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    expect(await transformOf(row)).toBe('');
    await expect(menu(page)).toHaveCount(0);
    await context.close();
  });

  test('a swipe under way keeps the list still, however the finger drifts', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Sideways first ${stamp()}`;
    await sendMessage(page, 'general', Array(60).fill(text).join('\n'));
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    expect(await row.evaluate((el) => getComputedStyle(el).touchAction)).toBe('pan-y pinch-zoom');
    const list = page.getByRole('log');
    const before = await list.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(200);

    const box = (await list.boundingBox())!;
    const from = { x: box.x + box.width / 2, y: box.y + 120 };
    const touch = await fingers(page);
    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x - 40, y: from.y + 2 }, 4);
    await touch.drag({ x: from.x - 40, y: from.y + 2 }, { x: from.x - 80, y: from.y + 200 }, 10);
    expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
    expect(await transformOf(row)).toMatch(/translateX\(-\d+/);
    await touch.up();
    await expect(page.getByTestId('reply-bar')).toBeVisible();
    await context.close();
  });

  test('a swipe does not begin on a video, or on a message being edited', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const name = `no-swipe-${stamp()}.webm`;
    await page.getByTestId('attach-input').setInputFiles({
      name,
      mimeType: 'video/webm',
      buffer: REAL_VIDEOS.webm.bytes,
    });
    await page.getByRole('button', { name: 'Send message' }).click();
    const withVideo = page.getByTestId('message').filter({
      has: page.locator(`video[aria-label="${name}"]`),
    });
    const video = withVideo.locator('video');
    await expect(video).toBeVisible();
    const touch = await fingers(page);
    let from = await center(video);
    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x - 90, y: from.y });
    expect(await transformOf(withVideo)).toBe('');
    await touch.up();
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);

    const text = `Being edited ${stamp()}`;
    await sendMessage(page, 'general', text);
    const id = await rowWith(page, text).getAttribute('data-message-id');
    const row = page.locator(`[data-message-id="${id}"]`);
    await openMenu(row);
    await menuItem(page, 'Edit').click();
    const box = row.getByRole('textbox', { name: 'Edit message' });
    await expect(box).toBeVisible();
    from = await center(box);
    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x - 90, y: from.y });
    expect(await transformOf(row)).toBe('');
    await touch.up();
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    await context.close();
  });

  test('a swipe along a long line of code reads the code, and starts nothing', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const id = stamp();
    await sendMessage(page, 'general', `\`\`\`\n${id} ${'long '.repeat(120)}\n\`\`\``);
    const row = rowWith(page, id);
    const code = row.locator('pre');
    await expect(code).toBeVisible();
    expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const touch = await fingers(page);
    const from = await center(code);
    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x - 120, y: from.y });
    expect(await transformOf(row)).toBe('');
    await expect(page.getByTestId('swipe-icon')).not.toHaveAttribute('data-armed');
    await touch.up();
    await page.waitForTimeout(100);
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    await expect.poll(() => code.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

    const short = `short ${stamp()}`;
    await sendMessage(page, 'general', `\`\`\`\n${short}\n\`\`\``);
    const shortCode = rowWith(page, short).locator('pre');
    await expect(shortCode).toBeVisible();
    const at = await center(shortCode);
    await touch.down(at.x, at.y);
    await touch.drag(at, { x: at.x - 110, y: at.y });
    await touch.up();
    await expect(page.getByTestId('reply-bar')).toContainText(short);
    await context.close();
  });

  test('a finger stopping where a swipe is decided leaves no row out of place', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Exactly ten ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    const fire = (type: string, x: number, y: number) =>
      row.evaluate(
        (el, { type, x, y }) => {
          const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
          const held = type === 'touchend' ? [] : [touch];
          el.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: held,
              targetTouches: held,
              changedTouches: [touch],
            }),
          );
        },
        { type, x, y },
      );
    const at = await center(row);

    await fire('touchstart', at.x, at.y);
    await fire('touchmove', at.x - 10, at.y);
    expect(await transformOf(row)).toBe('translateX(-10px)');
    await page.waitForTimeout(700);
    await expect(menu(page)).toHaveCount(0);
    await fire('touchend', at.x - 10, at.y);
    await expect.poll(() => transformOf(row)).toBe('');

    await fire('touchstart', at.x, at.y);
    await fire('touchmove', at.x - 10, at.y);
    expect(await transformOf(row)).toBe('translateX(-10px)');
    await row.evaluate((el, { x, y }) => {
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
    }, at);
    await expect(menu(page)).toBeVisible();
    await expect.poll(() => transformOf(row)).toBe('');
    await fire('touchend', at.x - 10, at.y);
    expect(await transformOf(row)).toBe('');
    await context.close();
  });

  test('a pinch does not fire, and a row already moving goes back', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Pinch ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    const touch = await fingers(page);
    const at = await center(row);

    const a = { x: at.x - 40, y: at.y };
    const b = { x: at.x + 40, y: at.y };
    await touch.downTwo(a, b);
    for (let i = 1; i <= 6; i++) {
      await touch.moveTwo({ x: a.x - i * 15, y: a.y }, { x: b.x - i * 15, y: b.y });
      await page.waitForTimeout(16);
    }
    expect(await transformOf(row)).toBe('');
    await touch.up();
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    await expect(menu(page)).toHaveCount(0);

    await touch.downTwo(a, b);
    await page.waitForTimeout(700);
    await expect(menu(page)).toHaveCount(0);
    await touch.up();

    await touch.down(at.x, at.y);
    await touch.drag(at, { x: at.x - 80, y: at.y });
    expect(await transformOf(row)).not.toBe('');
    await touch.downTwo({ x: at.x - 80, y: at.y }, { x: at.x + 20, y: at.y + 40 });
    await touch.up();
    await expect.poll(() => transformOf(row)).toBe('');
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    await context.close();
  });

  test('a long press opens the menu, with the click after it swallowed and nothing selected', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    await sendMessage(page, 'general', Array(60).fill('filler').join('\n'));
    const text = `Press me ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    const touch = await fingers(page);
    const at = await center(row.getByTestId('message-text'));

    await touch.down(at.x, at.y);
    await page.waitForTimeout(250);
    await expect(menu(page)).toHaveCount(0);
    await page.waitForTimeout(450);
    await expect(menu(page)).toBeVisible();
    const box = (await menu(page).boundingBox())!;
    expect(box.y).toBeLessThan(at.y);
    await menu(page)
      .getByRole('menuitem')
      .first()
      .evaluate((item: HTMLElement) => item.click());
    await touch.up();
    await page.waitForTimeout(400);
    await expect(menu(page)).toBeVisible();
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');

    expect(await menuItems(page)).toEqual(['Reply', 'Forward', 'Copy text', 'Edit', 'Delete']);
    await menuItem(page, 'Reply').click();
    await expect(page.getByTestId('reply-bar')).toContainText(text);
    await context.close();
  });

  test('a finger that moves or lifts early is not a long press', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Press and move ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    const touch = await fingers(page);
    const box = (await row.boundingBox())!;
    const at = { x: box.x + 30, y: box.y + box.height / 2 };

    await touch.down(at.x, at.y);
    await touch.drag(at, { x: at.x - 24, y: at.y }, 3);
    await page.waitForTimeout(700);
    await expect(menu(page)).toHaveCount(0);
    await touch.up();

    await touch.down(at.x, at.y);
    await page.waitForTimeout(100);
    await touch.up();
    await page.waitForTimeout(600);
    await expect(menu(page)).toHaveCount(0);

    await touch.down(at.x, at.y);
    await touch.move(at.x + 4, at.y + 4);
    await page.waitForTimeout(650);
    await expect(menu(page)).toBeVisible();
    await touch.up();
    await context.close();
  });

  test('a list that scrolls under a press cancels it', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Moved along ${stamp()}`;
    await sendMessage(page, 'general', Array(60).fill(text).join('\n'));
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    const list = page.getByRole('log');
    const box = (await list.boundingBox())!;
    const touch = await fingers(page);
    await touch.down(box.x + 80, box.y + 200);
    await list.evaluate((el) => (el.scrollTop -= 300));
    await page.waitForTimeout(700);
    await expect(menu(page)).toHaveCount(0);
    await touch.up();
    await context.close();
  });

  test('a tap still brings the buttons up, and they all work', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Tap me ${stamp()}`;
    await sendMessage(page, 'general', text);
    const row = rowWith(page, text);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-row-actions]')).toHaveCount(0);
    const box = (await row.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    const reply = row.getByRole('button', { name: 'Reply', exact: true });
    await expect(reply).toHaveCSS('opacity', '1');
    await row.locator('[data-row-actions]').waitFor();
    const size = (await reply.boundingBox())!;
    expect(size.height).toBeGreaterThanOrEqual(40);
    await reply.click();
    await expect(page.getByTestId('reply-bar')).toContainText(text);
    await context.close();
  });

  test('the channel list opens and closes by its own swipe, with no reply started', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    const text = `Under the list ${stamp()}`;
    await sendMessage(page, 'general', text);
    await expect(rowWith(page, text)).toBeVisible();
    await page.getByTestId('nav-toggle').click();
    const nav = page.getByRole('navigation', { name: 'Channels' });
    await expect(nav).toBeInViewport();
    const touch = await fingers(page);
    const box = (await nav.boundingBox())!;
    const from = { x: box.x + box.width - 30, y: box.y + 240 };
    await touch.down(from.x, from.y);
    await touch.drag(from, { x: from.x - 120, y: from.y });
    await touch.up();
    await expect(nav).not.toBeInViewport();
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    await context.close();
  });
});

test.describe('jumping to a quote', () => {
  test('inside the window: scrolled to, flashed, and the list still follows afterwards', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const originalText = `the original ${stamp()}`;
    const original = await post(alice, channel.id, originalText);
    for (let i = 0; i < 30; i++) await post(alice, channel.id, `filler ${i} ${stamp()}\n\n`);
    const answer = `the answer ${stamp()}`;
    await post(alice, channel.id, answer, original.id);

    await openTextChannel(bob, channel.name);
    const answerRow = rowWith(bob, answer);
    await expect(answerRow).toBeInViewport();
    const originalRow = rowWith(bob, originalText);
    await expect(originalRow).not.toBeInViewport();

    await answerRow.getByTestId('reply-quote').click();
    await expect(originalRow).toBeInViewport();
    await expect(originalRow).toHaveAttribute('data-flash', '');
    await expect(originalRow).not.toHaveAttribute('data-flash', /.*/, { timeout: 4000 });
    await expect(bob.getByRole('button', { name: 'Newest messages' })).toBeVisible();
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);

    const later = `arrived while reading ${stamp()}`;
    await post(alice, channel.id, later);
    await expect(rowWith(bob, later)).toBeAttached();
    await expect(originalRow).toBeInViewport();

    await bob.getByRole('button', { name: 'Newest messages' }).click();
    await expect(rowWith(bob, later)).toBeInViewport();
    const after = `and following again ${stamp()}`;
    await post(alice, channel.id, after);
    await expect(rowWith(bob, after)).toBeInViewport();
    await close();
  });

  test('a quote of something already on screen flashes it and leaves the list alone', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const originalText = `right above ${stamp()}`;
    const original = await post(alice, channel.id, originalText);
    const answer = `right below ${stamp()}`;
    await post(alice, channel.id, answer, original.id);
    await openTextChannel(bob, channel.name);
    const list = bob.getByRole('log');
    await expect(rowWith(bob, answer)).toBeInViewport();
    const before = await list.evaluate((el) => el.scrollTop);
    await rowWith(bob, answer).getByTestId('reply-quote').click();
    await expect(rowWith(bob, originalText)).toHaveAttribute('data-flash', '');
    expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
    const after = `still following ${stamp()}`;
    await post(alice, channel.id, after);
    await expect(rowWith(bob, after)).toBeInViewport();
    await close();
  });

  test('outside the window: loads the page around it, marks nothing read, and comes back', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const originalText = `long ago ${stamp()}`;
    const original = await post(alice, channel.id, originalText);
    for (let i = 0; i < 70; i++) await post(alice, channel.id, `filler ${i} ${stamp()}`);
    const answer = `about that old thing ${stamp()}`;
    await post(alice, channel.id, answer, original.id);

    await openTextChannel(bob, channel.name);
    const answerRow = rowWith(bob, answer);
    await expect(answerRow).toBeInViewport();
    await expect(rowWith(bob, originalText)).toHaveCount(0);
    await expect(channelButton(bob, channel.name)).not.toContainText('Unread');

    let marks = 0;
    bob.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/read')) marks++;
    });

    await answerRow.getByTestId('reply-quote').click();
    const originalRow = rowWith(bob, originalText);
    await expect(originalRow).toBeInViewport();
    await expect(originalRow).toHaveAttribute('data-flash', '');
    const present = bob.getByRole('button', { name: 'Jump to present' });
    await expect(present).toBeVisible();
    await expect(answerRow).toHaveCount(0);

    const missed = `while away ${stamp()}`;
    await post(alice, channel.id, missed);
    await expect(channelButton(bob, channel.name)).toHaveAccessibleName(/Unread/);
    await bob.waitForTimeout(300);
    await expect(rowWith(bob, missed)).toHaveCount(0);
    await expect(originalRow).toBeInViewport();
    expect(marks).toBe(0);

    await present.click();
    await expect(rowWith(bob, missed)).toBeInViewport();
    await expect(present).toHaveCount(0);
    await expect(channelButton(bob, channel.name)).not.toHaveAccessibleName(/Unread/);

    const after = `back in the present ${stamp()}`;
    await post(alice, channel.id, after);
    await expect(rowWith(bob, after)).toBeInViewport();
    await close();
  });

  test('a page too short to scroll stays put, as the longer window it replaced goes', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const originalText = `long ago ${stamp()}`;
    const original = await post(alice, channel.id, originalText);
    for (let i = 0; i < 40; i++) await post(alice, channel.id, `short ${i} ${stamp()}`);
    for (let i = 0; i < 60; i++) await post(alice, channel.id, `tall ${i}\n\n\n\n${stamp()}`);
    const answer = `about that ${stamp()}`;
    await post(alice, channel.id, answer, original.id);
    await bob.setViewportSize({ width: 1280, height: 1200 });
    await openTextChannel(bob, channel.name);
    await expect(rowWith(bob, answer)).toBeInViewport();

    await rowWith(bob, answer).getByTestId('reply-quote').click();
    const originalRow = rowWith(bob, originalText);
    await expect(originalRow).toBeInViewport();
    await expect(bob.getByRole('log')).toHaveJSProperty('scrollTop', 0);
    await bob.waitForTimeout(400);
    await expect(originalRow).toBeInViewport();
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toBeVisible();
    await close();
  });

  test('scrolling down a page from the past reaches the present by itself', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const originalText = `long ago ${stamp()}`;
    const original = await post(alice, channel.id, originalText);
    for (let i = 0; i < 70; i++) await post(alice, channel.id, `filler ${i} ${stamp()}`);
    const answer = `about that ${stamp()}`;
    await post(alice, channel.id, answer, original.id);
    await openTextChannel(bob, channel.name);
    await rowWith(bob, answer).getByTestId('reply-quote').click();
    await expect(rowWith(bob, originalText)).toBeInViewport();

    await bob.waitForTimeout(300);
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toBeVisible();

    const list = bob.getByRole('log');
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(rowWith(bob, answer)).toBeVisible();
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
    await close();
  });

  test('reading far back keeps the place, also once the newest messages leave the window', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const tag = stamp();
    for (let i = 0; i < 360; i++) await post(alice, channel.id, `line ${i} ${tag}`);
    await openTextChannel(bob, channel.name);
    const list = bob.getByRole('log');
    await expect(rowWith(bob, `line 359 ${tag}`)).toBeInViewport();
    const topId = () =>
      list.evaluate((el) => el.querySelector('[data-message-id]')?.getAttribute('data-message-id'));

    for (let page = 0; page < 7; page++) {
      const before = await topId();
      await list.evaluate((el) => (el.scrollTop = 0));
      await expect.poll(topId, { timeout: 20_000 }).not.toBe(before);
      await expect(list.locator(`[data-message-id="${before}"]`)).toBeInViewport();
    }
    await expect(rowWith(bob, `line 0 ${tag}`)).toHaveCount(1);
    await expect(rowWith(bob, `line 359 ${tag}`)).toHaveCount(0);
    await close();
  });

  test('replying from a page in the past takes the reader to their reply', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const originalText = `long ago ${stamp()}`;
    const original = await post(alice, channel.id, originalText);
    for (let i = 0; i < 70; i++) await post(alice, channel.id, `filler ${i} ${stamp()}`);
    const answer = `about that ${stamp()}`;
    await post(alice, channel.id, answer, original.id);
    await openTextChannel(bob, channel.name);
    await rowWith(bob, answer).getByTestId('reply-quote').click();
    const originalRow = rowWith(bob, originalText);
    await expect(originalRow).toBeInViewport();

    await (await hoverButton(originalRow, 'Reply')).click();
    const mine = `my late answer ${stamp()}`;
    await composer(bob, channel.name).fill(mine);
    await composer(bob, channel.name).press('Enter');
    await expect(rowWith(bob, mine)).toBeInViewport();
    await expect(rowWith(bob, mine).getByTestId('reply-quote')).toContainText(originalText);
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
    await expect(bob.getByRole('button', { name: 'Newest messages' })).toHaveCount(0);
    await close();
  });

  test('a double click on a quote outside the window gets there all the same', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const { originalText, answer } = await farQuote(alice, channel.id);
    await openTextChannel(bob, channel.name);
    await expect(rowWith(bob, answer)).toBeInViewport();
    const held = await holdOlderPages(bob);
    await rowWith(bob, answer).getByTestId('reply-quote').dblclick();
    held.release();
    const target = rowWith(bob, originalText);
    await expect(target).toBeInViewport();
    await expect(target).toHaveAttribute('data-flash', '');
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toBeVisible();
    await close();
  });

  test('a second quote clicked while the first page is on its way is the one that lands', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const firstText = `the first of them ${stamp()}`;
    const first = await post(alice, channel.id, firstText);
    for (let i = 0; i < 40; i++) await post(alice, channel.id, `filler ${i} ${stamp()}`);
    const secondText = `the second of them ${stamp()}`;
    const second = await post(alice, channel.id, secondText);
    for (let i = 0; i < 70; i++) await post(alice, channel.id, `more ${i} ${stamp()}`);
    const answerFirst = `about the first ${stamp()}`;
    await post(alice, channel.id, answerFirst, first.id);
    const answerSecond = `about the second ${stamp()}`;
    await post(alice, channel.id, answerSecond, second.id);
    await openTextChannel(bob, channel.name);
    await expect(rowWith(bob, answerSecond)).toBeInViewport();

    const held = await holdOlderPages(bob);
    await rowWith(bob, answerFirst).getByTestId('reply-quote').click();
    await rowWith(bob, answerSecond).getByTestId('reply-quote').click();
    held.release();
    const target = rowWith(bob, secondText);
    await expect(target).toBeInViewport();
    await expect(target).toHaveAttribute('data-flash', '');
    await expect(rowWith(bob, firstText)).toHaveCount(0);
    await close();
  });

  test('a quote in the window clicked while a page is on its way keeps the window', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const { answer } = await farQuote(alice, channel.id);
    const near = `further up, in the window ${stamp()}`;
    const nearby = await post(alice, channel.id, near);
    for (let i = 0; i < 20; i++) await post(alice, channel.id, `tall ${i}\n\n\n${stamp()}`);
    const nearAnswer = `about the near one ${stamp()}`;
    await post(alice, channel.id, nearAnswer, nearby.id);
    await openTextChannel(bob, channel.name);
    await expect(rowWith(bob, nearAnswer)).toBeInViewport();
    await expect(rowWith(bob, near)).not.toBeInViewport();
    const list = bob.getByRole('log');
    await rowWith(bob, answer).getByTestId('reply-quote').scrollIntoViewIfNeeded();

    const held = await holdOlderPages(bob);
    const arrived = bob.waitForResponse((r) => r.url().includes('before='));
    await rowWith(bob, answer).getByTestId('reply-quote').click();
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await rowWith(bob, nearAnswer).getByTestId('reply-quote').click();
    await expect(rowWith(bob, near)).toHaveAttribute('data-flash', '');
    await expect(rowWith(bob, near)).toBeInViewport();
    const place = await list.evaluate((el) => el.scrollTop);

    let reloads = 0;
    bob.on('request', (r) => {
      if (r.url().includes('/messages?') && !r.url().includes('before=')) reloads++;
    });
    held.release();
    await arrived;
    await bob.waitForTimeout(300);
    expect(reloads).toBe(0);
    await expect(rowWith(bob, near)).toBeInViewport();
    expect(await list.evaluate((el) => el.scrollTop)).toBe(place);
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
    await close();
  });

  test('Newest messages pressed while a page is on its way calls the jump off', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const { originalText, answer } = await farQuote(alice, channel.id);
    await openTextChannel(bob, channel.name);
    await expect(rowWith(bob, answer)).toBeInViewport();
    const held = await holdOlderPages(bob);
    const arrived = bob.waitForResponse((r) => r.url().includes('before='));
    await rowWith(bob, answer).getByTestId('reply-quote').click();
    const newest = bob.getByRole('button', { name: 'Newest messages' });
    await newest.click();
    await expect(newest).toHaveCount(0);

    held.release();
    await arrived;
    await bob.waitForTimeout(200);
    await expect(rowWith(bob, answer)).toBeInViewport();
    await expect(rowWith(bob, originalText)).toHaveCount(0);
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
    const after = `still here ${stamp()}`;
    await post(alice, channel.id, after);
    await expect(rowWith(bob, after)).toBeInViewport();
    await close();
  });

  test('leaving a channel while a page is on its way forgets the jump', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const { originalText, answer } = await farQuote(alice, channel.id);
    await openTextChannel(bob, channel.name);
    await expect(rowWith(bob, answer)).toBeInViewport();
    const held = await holdOlderPages(bob);
    const arrived = bob.waitForResponse((r) => r.url().includes('before='));
    await rowWith(bob, answer).getByTestId('reply-quote').click();
    await openTextChannel(bob, 'general');
    held.release();
    await arrived;
    await bob.waitForTimeout(200);

    await openTextChannel(bob, channel.name);
    await expect(rowWith(bob, answer)).toBeInViewport();
    await expect(rowWith(bob, originalText)).toHaveCount(0);
    await expect(bob.locator('[data-flash]')).toHaveCount(0);
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
    await close();
  });

  test('by keyboard, it lands on the message, and does not take you from what you are typing', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const { originalText, answer } = await farQuote(alice, channel.id);
    await openTextChannel(bob, channel.name);
    await expect(rowWith(bob, answer)).toBeInViewport();

    await rowWith(bob, answer).getByTestId('reply-quote').focus();
    await bob.keyboard.press('Enter');
    const target = rowWith(bob, originalText);
    await expect(target).toBeInViewport();
    await expect(target).toBeFocused();
    await bob.getByRole('button', { name: 'Jump to present' }).click();

    const held = await holdOlderPages(bob);
    await rowWith(bob, answer).getByTestId('reply-quote').click();
    await composer(bob, channel.name).click();
    await bob.keyboard.type('still typing');
    held.release();
    await expect(target).toBeInViewport();
    await expect(composer(bob, channel.name)).toBeFocused();
    await expect(composer(bob, channel.name)).toHaveValue('still typing');
    await close();
  });

  test('an edit in progress comes back with its words after a jump away and back', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    const { originalText, answer } = await farQuote(alice, channel.id);
    const mineText = `mine to change ${stamp()}`;
    const mine = await post(bob, channel.id, mineText);
    await openTextChannel(bob, channel.name);
    const row = bob.locator(`[data-message-id="${mine.id}"]`);
    await expect(row).toBeInViewport();

    await openMenu(row);
    await menuItem(bob, 'Edit').click();
    const box = row.getByRole('textbox', { name: 'Edit message' });
    await box.fill('half a thought');
    await rowWith(bob, answer).getByTestId('reply-quote').click();
    await expect(rowWith(bob, originalText)).toBeInViewport();
    await expect(box).toHaveCount(0);

    await bob.getByRole('button', { name: 'Jump to present' }).click();
    await expect(box).toHaveValue('half a thought');
    await box.press('Enter');
    await expect(rowWith(bob, 'half a thought')).toContainText('(edited)');
    await close();
  });

  test('a message that turns out to be gone says so, and the reader stays put', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const channel = await newChannel(alice);
    await openTextChannel(alice, channel.name);
    const originalText = `gone soon ${stamp()}`;
    const original = await post(alice, channel.id, originalText);
    for (let i = 0; i < 70; i++) await post(alice, channel.id, `filler ${i} ${stamp()}`);
    const answer = `about that ${stamp()}`;
    await post(alice, channel.id, answer, original.id);
    await openTextChannel(bob, channel.name);
    const row = rowWith(bob, answer);
    await expect(row.getByTestId('reply-quote')).toContainText(originalText);

    await bob.routeWebSocket('**/socket.io/**', () => undefined).catch(() => undefined);
    await bob.route('**/api/channels/*/messages?*', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { messages: { id: string }[] };
      body.messages = body.messages.filter((m) => m.id !== original.id);
      await route.fulfill({ response: res, json: body });
    });
    await row.getByTestId('reply-quote').click();
    await expect(bob.getByText('That message is no longer there.')).toBeVisible();
    await expect(row).toBeVisible();
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);
    await close();
  });

  test('one gone, from another channel: the reader arrives at the newest, following', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const from = await newChannel(alice);
    const to = await newChannel(alice);
    const { original, originalText, answer } = await farQuote(alice, from.id);
    await forwardTo(bob, original.id, to.id);
    await openTextChannel(bob, to.name);
    const line = rowWith(bob, originalText).locator('button[data-testid="forward-origin"]');
    await expect(line).toBeVisible();

    await bob.route('**/api/channels/*/messages?*', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { messages: { id: string }[] };
      body.messages = body.messages.filter((m) => m.id !== original.id);
      await route.fulfill({ response: res, json: body });
    });
    await line.click();
    await expect(bob.getByText('That message is no longer there.')).toBeVisible();
    await expect(composer(bob, from.name)).toBeVisible();
    await expect(rowWith(bob, answer)).toBeInViewport();
    await expect(bob.getByRole('button', { name: 'Newest messages' })).toHaveCount(0);
    await expect(bob.getByRole('button', { name: 'Jump to present' })).toHaveCount(0);

    const after = `and on it goes ${stamp()}`;
    await post(alice, from.id, after);
    await expect(rowWith(bob, after)).toBeInViewport();
    await close();
  });
});

test.describe('forwarding', () => {
  test('text: the dialog, the send, the rendering, live in the other channel, and the way back', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const from = await newChannel(alice);
    const to = await newChannel(alice);
    await openTextChannel(alice, to.name);
    await openTextChannel(bob, from.name);
    const text = `Worth sharing ${stamp()}`;
    await post(alice, from.id, text);
    const original = rowWith(bob, text);

    await (await hoverButton(original, 'Forward')).click();
    const dialog = bob.getByRole('dialog', { name: 'Forward to' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('forward-preview')).toContainText(text);
    await expect(dialog.getByTestId('forward-preview')).toContainText(USERS.alice.displayName);
    await expect(dialog.getByLabel('Find a channel')).toBeFocused();
    await expect(dialog.getByRole('button', { name: to.name, exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'General Voice' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: from.name, exact: true })).toHaveCount(0);

    await dialog.getByRole('button', { name: to.name, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(bob.getByText(`Forwarded to #${to.name}`)).toBeVisible();
    await expect(composer(bob, from.name)).toBeVisible();
    await expect(original).toBeVisible();

    const copy = rowWith(alice, text);
    await expect(copy).toBeVisible();
    await expect(copy.getByTestId('forward-label')).toHaveText('Forwarded');
    await expect(copy.getByTestId('message-author')).toContainText(USERS.bob.displayName);
    const origin = copy.getByTestId('forward-origin');
    await expect(origin).toContainText(USERS.alice.displayName);
    await expect(origin).toContainText(`#${from.name}`);

    const label = (await copy.getByTestId('forward-label').boundingBox())!;
    const line = (await origin.boundingBox())!;
    expect(line.y).toBeCloseTo(label.y, 0);
    expect(line.x).toBeGreaterThanOrEqual(label.x + label.width);
    const forwarded = (await copy.getByTestId('message-text').boundingBox())!;
    expect(forwarded.y).toBeGreaterThanOrEqual(line.y + line.height);

    await expect(channelButton(bob, to.name)).not.toHaveAccessibleName(/Unread/);

    await origin.click();
    await expect(composer(alice, from.name)).toBeVisible();
    const back = rowWith(alice, text);
    await expect(back).toBeInViewport();
    await expect(back).toHaveAttribute('data-flash', '');
    await expect(back.getByTestId('forward-label')).toHaveCount(0);
    await expect(alice.getByRole('button', { name: 'Newest messages' })).toHaveCount(0);
    const next = `after the way back ${stamp()}`;
    await post(bob, from.id, next);
    await expect(rowWith(alice, next)).toBeInViewport();
    await close();
  });

  test('into a channel with unread messages leaves them unread', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const from = await newChannel(alice);
    const to = await newChannel(alice);
    await post(alice, to.id, `already read ${stamp()}`);
    await openTextChannel(bob, to.name);
    await expect(channelButton(bob, to.name)).not.toHaveAccessibleName(/Unread/);
    await openTextChannel(bob, from.name);
    const text = `Passing this on ${stamp()}`;
    await post(alice, from.id, text);
    await post(alice, to.id, `not read yet ${stamp()}`);
    await expect(channelButton(bob, to.name)).toHaveAccessibleName(/Unread/);

    await (await hoverButton(rowWith(bob, text), 'Forward')).click();
    const dialog = bob.getByRole('dialog', { name: 'Forward to' });
    await dialog.getByRole('button', { name: to.name, exact: true }).click();
    await expect(bob.getByText(`Forwarded to #${to.name}`)).toBeVisible();
    await bob.waitForTimeout(300);
    await expect(channelButton(bob, to.name)).toHaveAccessibleName(/Unread/);
    await close();
  });

  test('deleting the original stops its forward offering the way there, for someone watching', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const from = await newChannel(alice);
    const to = await newChannel(alice);
    const text = `Soon to be a copy of nothing ${stamp()}`;
    const original = await post(alice, from.id, text);
    await forwardTo(alice, original.id, to.id);
    await openTextChannel(bob, to.name);
    const copy = rowWith(bob, text);
    await expect(copy.locator('button[data-testid="forward-origin"]')).toBeVisible();

    const res = await alice.request.delete(`/api/messages/${original.id}`, {
      headers: { 'X-CSRF-Token': await csrf(alice) },
    });
    expect(res.status()).toBe(200);
    await expect(copy.locator('button[data-testid="forward-origin"]')).toHaveCount(0);
    await expect(copy.getByTestId('forward-origin')).toContainText(USERS.alice.displayName);
    await close();
  });

  test('a dialog closed while its send is on its way: a failure is still told, and a new dialog is left alone', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const from = await newChannel(alice);
    const to = await newChannel(alice);
    await openTextChannel(bob, from.name);
    const text = `Sent and left ${stamp()}`;
    const other = `Another to send ${stamp()}`;
    await post(alice, from.id, text);
    await post(alice, from.id, other);
    const dialog = bob.getByRole('dialog', { name: 'Forward to' });

    let answer: (status: number) => void = () => undefined;
    await bob.route('**/api/messages/*/forward', async (route) => {
      const status = await new Promise<number>((resolve) => (answer = resolve));
      if (status === 200) return route.continue();
      await route.fulfill({
        status,
        json: { error: { code: 'not_found', message: 'Channel not found.' } },
      });
    });

    await (await hoverButton(rowWith(bob, text), 'Forward')).click();
    await dialog.getByRole('button', { name: to.name, exact: true }).click();
    await expect(dialog.getByRole('list', { name: 'Channels' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await bob.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    answer(404);
    await expect(
      bob.getByText(`Could not forward to #${to.name}: Channel not found.`),
    ).toBeVisible();

    await (await hoverButton(rowWith(bob, text), 'Forward')).click();
    await dialog.getByRole('button', { name: to.name, exact: true }).click();
    await expect(dialog.getByRole('list', { name: 'Channels' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await bob.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await (await hoverButton(rowWith(bob, other), 'Forward')).click();
    await expect(dialog.getByTestId('forward-preview')).toContainText(other);
    answer(200);
    await expect(bob.getByText(`Forwarded to #${to.name}`)).toBeVisible();
    await bob.waitForTimeout(200);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('forward-preview')).toContainText(other);
    await close();
  });

  test('from the menu, and the buttons and menu of a forward have no Edit', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const from = await newChannel(alice);
    const to = await newChannel(alice);
    await openTextChannel(bob, from.name);
    const text = `Via the menu ${stamp()}`;
    await post(alice, from.id, text);
    await openMenu(rowWith(bob, text));
    await menuItem(bob, 'Forward').click();
    const dialog = bob.getByRole('dialog', { name: 'Forward to' });
    await dialog.getByRole('button', { name: to.name, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rowWith(bob, text)).toBeFocused();

    await openTextChannel(bob, to.name);
    const copy = rowWith(bob, text);
    await expect(copy.getByTestId('forward-label')).toBeVisible();
    await copy.hover();
    await expect(copy.getByRole('button', { name: 'Edit message' })).toHaveCount(0);
    await expect(copy.getByRole('button', { name: 'Delete message' })).toBeVisible();
    await openMenu(copy);
    expect(await menuItems(bob)).toEqual(['Reply', 'Forward', 'Copy text', 'Delete']);
    await bob.keyboard.press('Escape');

    await copy.hover();
    await copy.getByRole('button', { name: 'Delete message' }).click();
    await answerDelete(bob);
    await expect(bob.getByText(text)).toHaveCount(0);
    await close();
  });

  test('an image: its own file, which stays when the original is deleted', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const from = await newChannel(alice);
    const to = await newChannel(alice);
    await openTextChannel(alice, from.name);
    await openTextChannel(bob, to.name);

    const name = `carried-${stamp()}.png`;
    await alice.getByTestId('attach-input').setInputFiles(pngFile(name));
    await alice.getByRole('button', { name: 'Send message' }).click();
    const original = alice
      .getByTestId('message')
      .filter({ has: alice.locator(`img[alt="${name}"]`) });
    await expect(original.locator('img')).toBeVisible();
    const listed = (await (
      await alice.request.get(`/api/channels/${from.id}/messages`)
    ).json()) as {
      messages: { attachments: { url: string }[] }[];
    };
    const originalSrc = listed.messages[0]!.attachments[0]!.url;

    await (await hoverButton(original, 'Forward')).click();
    const dialog = alice.getByRole('dialog', { name: 'Forward to' });
    await expect(dialog.getByTestId('forward-preview').locator('img')).toBeVisible();
    await expect(dialog.getByTestId('forward-preview')).toContainText('Photo');
    await dialog.getByRole('button', { name: to.name, exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const copy = bob.getByTestId('message').filter({ has: bob.locator(`img[alt="${name}"]`) });
    await expect(copy.getByTestId('forward-label')).toBeVisible();
    const image = copy.locator(`img[alt="${name}"]`);
    await expect
      .poll(() => image.evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBeGreaterThan(0);
    const copySrc = (await image.getAttribute('src'))!;
    expect(copySrc).not.toBe(originalSrc);
    expect((await bob.request.get(copySrc)).status()).toBe(200);

    await (await hoverButton(original, 'Delete message')).click();
    await answerDelete(alice);
    await expect(original).toHaveCount(0);
    await expect.poll(async () => (await bob.request.get(originalSrc)).status()).toBe(404);
    expect((await bob.request.get(copySrc)).status()).toBe(200);
    await bob.reload();
    const reloaded = bob.getByTestId('message').filter({ has: bob.locator(`img[alt="${name}"]`) });
    await expect(reloaded.getByTestId('forward-origin')).toBeVisible();
    await expect(reloaded.locator('button[data-testid="forward-origin"]')).toHaveCount(0);
    await close();
  });

  test('the dialog: its filter, its error, a retry with the same nonce, and no double send', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const stampText = stamp();
    const from = await newChannel(alice);
    const wanted = await newChannel(alice, 'text', `wanted-${stampText}`);
    const other = await newChannel(alice, 'text', `other-${stampText}`);
    await openTextChannel(bob, from.name);
    const text = `To the right place ${stamp()}`;
    await post(alice, from.id, text);
    await (await hoverButton(rowWith(bob, text), 'Forward')).click();
    const dialog = bob.getByRole('dialog', { name: 'Forward to' });

    const filter = dialog.getByLabel('Find a channel');
    await filter.fill(`WANTED-${stampText}`);
    await expect(dialog.getByRole('button', { name: wanted.name, exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: other.name, exact: true })).toHaveCount(0);
    await filter.fill('no-channel-is-called-this');
    await expect(dialog.getByText('No channel by that name')).toBeVisible();
    await filter.fill(stampText);

    const nonces: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await bob.route('**/api/messages/*/forward', async (route) => {
      const body = route.request().postDataJSON() as { clientNonce: string };
      nonces.push(body.clientNonce);
      if (nonces.length === 1) {
        await route.fulfill({
          status: 404,
          json: { error: { code: 'not_found', message: 'Channel not found.' } },
        });
        return;
      }
      await held;
      await route.continue();
    });

    const target = dialog.getByRole('button', { name: wanted.name });
    await target.click();
    await expect(dialog.getByRole('alert')).toContainText('Channel not found.');
    await expect(dialog).toBeVisible();
    await expect(target).toBeEnabled();

    await target.click();
    await expect(dialog.getByRole('list', { name: 'Channels' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(target).toBeDisabled();
    await expect(dialog.getByRole('button', { name: other.name, exact: true })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await target.click({ force: true }).catch(() => undefined);
    release();

    await expect(dialog).toHaveCount(0);
    await expect(bob.getByText(`Forwarded to #${wanted.name}`)).toBeVisible();
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).toBe(nonces[0]);
    await close();
  });

  test('a voice channel is somewhere it can go, and its chat opens for the way back', async ({
    browser,
  }) => {
    const { alice, close } = await pair(browser);
    const voice = await newChannel(alice, 'voice');
    const to = await newChannel(alice);
    const channelId = (
      (await (await alice.request.get('/api/bootstrap')).json()) as {
        channels: { id: string; name: string }[];
      }
    ).channels.find((c) => c.name === 'general')!.id;
    const text = `To a call ${stamp()}`;
    await post(alice, channelId, text);
    await openTextChannel(alice, 'general');
    await (await hoverButton(rowWith(alice, text), 'Forward')).click();
    const dialog = alice.getByRole('dialog', { name: 'Forward to' });
    await dialog.getByRole('button', { name: voice.name, exact: true }).click();
    await expect(alice.getByText(`Forwarded to ${voice.name}`)).toBeVisible();
    const res = await alice.request.get(`/api/channels/${voice.id}/messages`);
    const page = (await res.json()) as { messages: { content: string }[] };
    expect(page.messages.map((m) => m.content)).toEqual([text]);

    const spoken = `Said during the call ${stamp()}`;
    const inCall = await post(alice, voice.id, spoken);
    await forwardTo(alice, inCall.id, to.id);
    await channelButton(alice, voice.name).click();
    const chat = alice.getByRole('complementary', { name: `Chat in ${voice.name}` });
    await chat.getByRole('button', { name: 'Hide chat' }).click();
    await expect(chat).toHaveCount(0);
    await openTextChannel(alice, to.name);
    await rowWith(alice, spoken).getByTestId('forward-origin').click();
    await expect(chat).toBeVisible();
    const original = chat
      .getByTestId('message')
      .filter({ has: alice.getByTestId('message-text').filter({ hasText: spoken }) });
    await expect(original).toBeInViewport();
    await expect(original).toHaveAttribute('data-flash', '');
    await expect(original.getByTestId('forward-label')).toHaveCount(0);
    await close();
  });

  test('on a phone, too, where that chat always starts out shut', async ({ browser }) => {
    const { alice, close } = await pair(browser);
    const voice = await newChannel(alice, 'voice');
    const to = await newChannel(alice);
    const spoken = `Said during the call ${stamp()}`;
    const inCall = await post(alice, voice.id, spoken);
    await forwardTo(alice, inCall.id, to.id);

    const { context, page } = await user(browser, USERS.bob, PHONE);
    await page.getByTestId('nav-toggle').click();
    await channelButton(page, voice.name).click();
    const chat = page.getByRole('complementary', { name: `Chat in ${voice.name}` });
    await expect(chat).toHaveCount(0);
    await page.getByTestId('nav-toggle').click();
    await channelButton(page, to.name).click();
    const line = rowWith(page, spoken).getByTestId('forward-origin');
    await line.click({ trial: true });
    const box = (await line.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.viewport.width);
    expect(box.height).toBeLessThan(24);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(chat).toBeVisible();
    const original = chat
      .getByTestId('message')
      .filter({ has: page.getByTestId('message-text').filter({ hasText: spoken }) });
    await expect(original).toBeInViewport();
    await expect(original).toHaveAttribute('data-flash', '');
    await context.close();
    await close();
  });
});
