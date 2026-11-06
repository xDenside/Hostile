import { expect, test, type Browser, type Page } from '@playwright/test';
import { joinVoice, openTextChannel, sendMessage, signIn, USERS, type Person } from './helpers';

const ANIMATED_GIF = Buffer.from(
  'R0lGODlhAQABAPEBAP8AAAAA/wAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQECgAAACwAAAAAAQABAAACAkQBACH5BAQKAAAALAAAAAABAAEAAAICTAEAOw==',
  'base64',
);

async function openSettings(page: Page, tab: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: tab, exact: true }).click();
}

async function closeSettings(page: Page) {
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function user(
  browser: Browser,
  who: Person,
  options: Parameters<Browser['newContext']>[0] = {},
) {
  const context = await browser.newContext({ permissions: ['microphone'], ...options });
  const page = await context.newPage();
  await signIn(page, who);
  return { context, page };
}

const SPEAKING_RING = 'rgb(255, 255, 255) 0px 0px 0px 2px';

test.describe('the call screen', () => {
  test('people fill it until a stream takes the stage, then shrink to the size of your own card', async ({
    browser,
  }) => {
    const { context: aliceContext, page: alice } = await user(browser, USERS.alice, {
      viewport: { width: 1440, height: 900 },
    });
    const { context: bobContext, page: bob } = await user(browser, USERS.bob);

    await openSettings(bob, 'Profile');
    const uploaded = bob.waitForResponse((r) => r.url().includes('/profile/media/banner'));
    await bob
      .getByTestId('upload-banner')
      .setInputFiles({ name: 'bg.gif', mimeType: 'image/gif', buffer: ANIMATED_GIF });
    expect((await uploaded).status()).toBe(200);
    await closeSettings(bob);

    await joinVoice(alice, 'General Voice');
    await joinVoice(bob, 'General Voice');
    const tiles = alice.getByTestId('participant-tile');
    await expect(tiles).toHaveCount(2, { timeout: 30_000 });

    const bobTile = tiles.filter({ hasText: 'Bob' });
    await expect
      .poll(async () => (await bobTile.boundingBox())?.width ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(300);
    await expect(bobTile.getByTestId('tile-backdrop-image')).toBeVisible();
    await expect(bobTile.getByTestId('tile-backdrop-image')).toHaveAttribute(
      'src',
      /\/api\/media\//,
    );

    await expect(bobTile).toHaveAttribute('data-speaking', 'true', { timeout: 20_000 });
    await expect
      .poll(() => bobTile.evaluate((el) => getComputedStyle(el).boxShadow))
      .toContain(SPEAKING_RING);
    await bob.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(bobTile).not.toHaveAttribute('data-speaking', 'true', { timeout: 20_000 });
    await expect(bobTile.getByLabel('Muted')).toBeVisible();
    await expect
      .poll(() => bobTile.evaluate((el) => getComputedStyle(el).boxShadow))
      .not.toContain(SPEAKING_RING);

    await bobTile.click({ button: 'right' });
    await expect(alice.getByTestId('member-menu')).toBeVisible();
    await alice.keyboard.press('Escape');

    await alice.getByRole('button', { name: 'Share your screen' }).click();
    await alice.getByRole('button', { name: 'Start sharing' }).click();
    await expect(alice.getByTestId('share-tile-local')).toBeVisible({ timeout: 30_000 });
    await expect(tiles).toHaveCount(2);
    const dock = await alice.getByTestId('dock').boundingBox();
    await expect
      .poll(async () => (await tiles.first().boundingBox())?.width)
      .toBeCloseTo(dock!.width, 0);
    const strip = () => tiles.first().boundingBox();
    const ownCard = await alice.getByTestId('own-card').boundingBox();
    const panel = await alice.locator('main').boundingBox();
    expect((await strip())!.height).toBeCloseTo(52, 0);
    await expect.poll(async () => (await strip())!.y).toBeCloseTo(ownCard!.y - 1, 0);
    expect(dock!.y + dock!.height).toBeCloseTo(panel!.y + panel!.height, 0);

    await alice
      .getByTestId('share-tile-local')
      .getByRole('button', { name: 'Stop sharing' })
      .click();
    await expect(alice.getByTestId('share-tile-local')).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(async () => (await tiles.first().boundingBox())?.width ?? 0)
      .toBeGreaterThan(300);

    await openSettings(bob, 'Profile');
    await bob.getByRole('button', { name: 'Remove' }).click();
    await expect(bob.getByRole('button', { name: 'Remove' })).toHaveCount(0);
    await closeSettings(bob);

    await aliceContext.close();
    await bobContext.close();
  });
});

test.describe('the dock', () => {
  const wide = { viewport: { width: 1280, height: 800 } };

  test('your card has your name and three buttons, and a call joins it as one block', async ({
    browser,
  }) => {
    const { context, page: bob } = await user(browser, USERS.bob, wide);
    const dock = bob.getByTestId('dock');
    const card = bob.getByTestId('own-card');
    await expect(card.getByRole('button', { name: 'Mute microphone' })).toBeVisible();
    await expect(card.getByRole('button', { name: /^Deafen/ })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Sign out' })).toHaveCount(0);

    const fit = await card.evaluate((el) => {
      const name = el.querySelector<HTMLElement>('[data-text]')!;
      const box = el.getBoundingClientRect();
      return {
        nameCut: name.scrollWidth > name.clientWidth,
        past:
          Math.max(
            ...[...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().right),
          ) - box.right,
      };
    });
    expect(fit.nameCut).toBe(false);
    expect(fit.past).toBeLessThanOrEqual(0);
    const alone = await dock.boundingBox();
    const panel = await bob.locator('main').boundingBox();
    const composer = await bob.locator('[class*=composer_]').first().boundingBox();
    expect(alone!.y + alone!.height).toBeCloseTo(panel!.y + panel!.height, 0);
    expect(alone!.y).toBeCloseTo(composer!.y, 0);
    expect(alone!.height).toBeCloseTo(65, 0);
    const surface = (el: Element) => getComputedStyle(el).backgroundColor;
    expect(await dock.evaluate(surface)).toBe(await bob.locator('main').evaluate(surface));

    await bob.getByRole('button', { name: 'Mute microphone' }).click();
    await joinVoice(bob, 'General Voice');
    await expect(card.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    await expect(bob.getByRole('navigation').getByLabel('Muted')).toBeVisible();

    await expect(dock.getByRole('button', { name: 'Share your screen' })).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Leave voice' })).toBeVisible();
    await expect(dock.getByText('General Voice', { exact: true })).toBeVisible();
    await expect(bob.getByRole('button', { name: 'Leave voice' })).toHaveCount(1);
    const inCall = await dock.boundingBox();
    expect(inCall!.height).toBeCloseTo(alone!.height + 41, 0);
    expect(inCall!.y + inCall!.height).toBeCloseTo(alone!.y + alone!.height, 0);

    await bob.getByRole('button', { name: 'Leave voice' }).click();
    await expect.poll(async () => (await dock.boundingBox())!.height).toBeCloseTo(65, 0);
    await context.close();
  });

  test('the channel list can be dragged to any width, and remembers it', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob, wide);
    const nav = page.getByRole('navigation', { name: 'Channels' });
    const handle = page.getByTestId('sidebar-resizer');
    const width = async () => (await nav.boundingBox())!.width;
    expect(await width()).toBeCloseTo(276, 0);

    async function dragBy(dx: number) {
      const box = (await handle.boundingBox())!;
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx / 2, y);
      await page.mouse.move(box.x + box.width / 2 + dx, y);
      await page.mouse.up();
    }

    await dragBy(100);
    expect(await width()).toBeCloseTo(376, 0);
    const main = await page.getByRole('main').boundingBox();
    expect(main!.x).toBeGreaterThanOrEqual(376);

    expect(await page.evaluate(() => String(window.getSelection()))).toBe('');

    await page.reload();
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
      timeout: 20_000,
    });
    expect(await width()).toBeCloseTo(376, 0);

    await dragBy(-350);
    expect(await width()).toBeCloseTo(220, 0);
    const past = await page.getByTestId('own-card').evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      return Math.max(
        ...[...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().right - right),
      );
    });
    expect(past).toBeLessThanOrEqual(0);

    await dragBy(1000);
    expect(await width()).toBeCloseTo(520, 0);

    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    expect(await width()).toBeCloseTo(504, 0);
    await expect(handle).toHaveAttribute('aria-valuenow', '504');
    await page.keyboard.press('Home');
    expect(await width()).toBeCloseTo(220, 0);
    await page.keyboard.press('End');
    expect(await width()).toBeCloseTo(520, 0);

    await page.setViewportSize({ width: 900, height: 700 });
    expect(await width()).toBeCloseTo(340, 0);
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await width()).toBeCloseTo(520, 0);

    await handle.dblclick();
    expect(await width()).toBeCloseTo(276, 0);
    await context.close();

    const { context: phoneContext, page: phone } = await user(browser, USERS.bob, {
      viewport: { width: 390, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    await expect(phone.getByTestId('sidebar-resizer')).toHaveCount(0);
    await phoneContext.close();
  });
});

test.describe('on a phone', () => {
  const phone = { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true };

  async function noSidewaysScroll(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      phone.viewport.width,
    );
  }

  async function panelFits(page: Page) {
    const panel = page.getByTestId('settings-panel');
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }

  test('your own card opens inside the channel list, 8 px from both of its edges', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, phone);
    await page.getByTestId('nav-toggle').click();
    await page.getByTestId('own-card').getByRole('button').first().click();
    await expect(page.locator('[class*=cardFrame]')).toBeVisible();
    const edges = () =>
      page.evaluate(() => {
        const card = document.querySelector('[class*=cardFrame]')!.getBoundingClientRect();
        let drawer = document.querySelector<HTMLElement>('[data-testid=own-card]');
        while (drawer && getComputedStyle(drawer).position !== 'fixed')
          drawer = drawer.parentElement;
        const box = drawer!.getBoundingClientRect();
        return `${Math.round(card.left - box.left)} ${Math.round(box.right - card.right)}`;
      });
    await expect.poll(edges).toBe('8 8');
    await context.close();
  });

  test('the chat has the width, the channel list slides in, and the call stays in reach', async ({
    browser,
  }) => {
    const { context: bobContext, page: bob } = await user(browser, USERS.bob, phone);
    const { context: aliceContext, page: alice } = await user(browser, USERS.alice);
    const nav = bob.getByRole('navigation', { name: 'Channels' });

    await expect(nav).toBeHidden();
    const composer = bob.getByRole('textbox', { name: /^Message/ });
    await expect(composer).toBeVisible();
    const box = await bob.locator('[class*=composerWrap]').boundingBox();
    expect(box!.width).toBe(390);
    await noSidewaysScroll(bob);

    await bob.getByTestId('nav-toggle').click();
    await expect(nav).toBeVisible();
    await bob.getByTestId('nav-scrim').click({ position: { x: 370, y: 400 } });
    await expect(nav).toBeHidden();

    await bob.getByTestId('nav-toggle').click();
    await expect(nav).toBeVisible();
    await nav.evaluate((el) => {
      const touch = (x: number) =>
        new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
      el.dispatchEvent(
        new TouchEvent('touchstart', { bubbles: true, touches: [touch(260)], changedTouches: [] }),
      );
      el.dispatchEvent(
        new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(80)] }),
      );
    });
    await expect(nav).toBeHidden();

    await bob.getByTestId('nav-toggle').click();
    await nav.getByRole('button', { name: /^gaming/ }).click();
    await expect(nav).toBeHidden();
    await expect(bob.locator('header')).toContainText('gaming');

    await openTextChannel(alice, 'general');
    await sendMessage(alice, 'general', `phone unread ${Date.now()}`);
    await expect(bob.getByTestId('nav-unread')).toBeVisible({ timeout: 15_000 });

    await bob.getByTestId('nav-toggle').click();
    await nav.getByRole('button', { name: /^General Voice/ }).click();
    await expect(nav).toBeHidden();
    await expect(bob.getByTestId('voice-state')).toHaveText('Voice connected', { timeout: 30_000 });
    await bob.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(bob.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    await expect(bob.getByTestId('participant-tile')).toHaveCount(1);
    await noSidewaysScroll(bob);

    const voiceComposer = bob.getByRole('textbox', { name: 'Message General Voice' });
    await expect(voiceComposer).toHaveCount(0);
    await bob.getByTestId('voice-chat-toggle').click();
    await expect(voiceComposer).toBeVisible();
    await expect(bob.getByTestId('voice-state')).toHaveText('Voice connected');
    await noSidewaysScroll(bob);
    await bob.getByTestId('voice-chat-toggle').click();
    await expect(voiceComposer).toHaveCount(0);
    await expect(bob.getByTestId('participant-tile')).toBeVisible();

    await bob.getByTestId('nav-toggle').click();
    await nav.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(bob.getByRole('dialog')).toBeVisible();
    await noSidewaysScroll(bob);
    for (const tab of ['Profile', 'Voice & audio', 'Shortcuts', 'Diagnostics']) {
      await bob.getByRole('button', { name: tab, exact: true }).click();
      await expect(bob.getByRole('heading', { name: tab, exact: true })).toBeVisible();
      await panelFits(bob);
    }
    await closeSettings(bob);
    await expect(nav).toBeHidden();

    await bob.getByRole('button', { name: 'Leave voice' }).click();
    await aliceContext.close();
    await bobContext.close();
  });

  test('a message and its buttons behave under a finger', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.alice, phone);
    const text = `tap me ${Date.now()}`;
    await sendMessage(page, 'general', text);
    const row = page.getByTestId('message').filter({ hasText: text });
    await expect(row).toBeVisible();

    const box = (await row.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width - 70, box.y + 4);
    await expect(row.getByRole('textbox')).toHaveCount(0);

    const edit = row.getByRole('button', { name: 'Edit message' });
    await expect(edit).toHaveCSS('opacity', '1');
    await edit.click();
    await expect(row.getByRole('textbox')).toBeVisible();
    await context.close();
  });

  test('the newest message stays in view when the on-screen keyboard takes the height', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.alice, phone);
    await sendMessage(page, 'general', Array(40).fill('filler').join('\n'));
    const text = `newest ${Date.now()}`;
    await sendMessage(page, 'general', text);
    const row = page.getByTestId('message').filter({ hasText: text });
    await expect(row).toBeInViewport({ ratio: 1 });

    await page.setViewportSize({ width: phone.viewport.width, height: 420 });
    await expect(row).toBeInViewport({ ratio: 1 });

    const list = page.getByRole('log');
    await list.evaluate((el) => (el.scrollTop = 0));
    await expect(row).not.toBeInViewport();
    await page.setViewportSize({ width: phone.viewport.width, height: 600 });
    await expect(row).not.toBeInViewport();
    expect(await list.evaluate((el) => el.scrollTop)).toBeLessThan(200);
    await context.close();
  });
});

test.describe('settings', () => {
  test('is the whole window, closes with Escape, and hides what a member cannot use', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, {
      viewport: { width: 1280, height: 800 },
    });
    await openSettings(page, 'Voice & audio');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    await expect(page.getByRole('heading', { name: 'Voice & audio', exact: true })).toBeVisible();
    await expect(page.getByText('Community', { exact: true })).toHaveCount(0);

    const insets = await page.getByRole('combobox', { name: 'Microphone' }).evaluate((select) => {
      const box = select.getBoundingClientRect();
      const arrow = select.nextElementSibling!.getBoundingClientRect();
      return {
        arrow: box.right - arrow.right,
        text: parseFloat(getComputedStyle(select).paddingLeft),
      };
    });
    expect(insets.arrow).toBeCloseTo(insets.text, 0);
    expect(insets.arrow).toBeGreaterThan(8);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await context.close();
  });

  test('every page starts in one place, with its cards side by side where two fit', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.alice, {
      viewport: { width: 1440, height: 900 },
    });
    const titleX = async (name: string) => {
      await openTab(name);
      const title = page.getByRole('heading', { level: 2, name, exact: true });
      return (await title.boundingBox())!.x;
    };
    async function openTab(name: string) {
      await page.getByRole('button', { name, exact: true }).click();
    }

    await openSettings(page, 'Voice & audio');
    const x = await titleX('Voice & audio');
    for (const name of ['Profile', 'Shortcuts', 'Members', 'Channels']) {
      expect(await titleX(name)).toBeCloseTo(x, 0);
      await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1);
    }

    await openTab('Voice & audio');
    const cards = () =>
      page.evaluate(() => {
        const group = (name: string) =>
          [...document.querySelectorAll('h3')]
            .find((h) => h.textContent === name)!
            .closest('section')!
            .getBoundingClientRect();
        const left = group('Devices');
        const right = group('Your microphone');
        return {
          sameTop: left.top - right.top,
          sameHeight: left.height - right.height,
          sameLeft: left.left - right.left,
          across: right.left - left.right,
        };
      });
    const wide = await cards();
    expect(wide.sameTop).toBeCloseTo(0, 0);
    expect(wide.sameHeight).toBeCloseTo(0, 0);
    expect(wide.across).toBeCloseTo(16, 0);

    await page.setViewportSize({ width: 1000, height: 800 });
    expect((await cards()).sameLeft).toBeCloseTo(0, 0);
    await context.close();
  });

  test('the profile preview spans the first two groups of options, edge to edge', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, {
      viewport: { width: 1280, height: 800 },
    });
    await openSettings(page, 'Profile');
    const offsets = () =>
      page.evaluate(() => {
        const group = (name: string) =>
          [...document.querySelectorAll('h3')]
            .find((h) => h.textContent === name)!
            .closest('section')!
            .getBoundingClientRect();
        const card = document
          .querySelector('[data-testid="profile-preview"]')!
          .getBoundingClientRect();
        return {
          top: card.top - group('Avatar').top,
          bottom: card.bottom - group('Profile background').bottom,
          left: card.left - group('Avatar').left,
          right: card.right - group('Avatar').right,
        };
      });

    async function linedUpAtEveryWidth() {
      for (const width of [1280, 1000]) {
        await page.setViewportSize({ width, height: 800 });
        const { top, bottom } = await offsets();
        expect(top).toBeCloseTo(0, 0);
        expect(bottom).toBeCloseTo(0, 0);
      }
    }
    await linedUpAtEveryWidth();

    const uploaded = page.waitForResponse((r) => r.url().includes('/profile/media/banner'));
    await page
      .getByTestId('upload-banner')
      .setInputFiles({ name: 'bg.gif', mimeType: 'image/gif', buffer: ANIMATED_GIF });
    expect((await uploaded).status()).toBe(200);
    await expect(page.getByTestId('profile-preview').locator('img').first()).toBeVisible();
    await linedUpAtEveryWidth();

    for (const width of [390, 800]) {
      await page.setViewportSize({ width, height: 844 });
      const { left, right } = await offsets();
      expect(left).toBeCloseTo(0, 0);
      expect(right).toBeCloseTo(0, 0);
    }
    await context.close();
  });
});

test.describe('shortcuts', () => {
  test('can be changed, refuse what they must, and stay out of the way of typing', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.alice);
    await openTextChannel(page, 'general');
    await joinVoice(page, 'General Voice');
    const muted = page.getByRole('button', { name: 'Unmute microphone' });
    const undeafen = page.getByRole('button', { name: 'Undeafen' });

    await page.keyboard.press('Control+Shift+KeyM');
    await expect(muted).toBeVisible();
    await page.keyboard.press('Meta+Shift+KeyM');
    await expect(muted).toHaveCount(0);

    await openSettings(page, 'Shortcuts');
    await expect(page.getByText(/only work while this tab/)).toBeVisible();
    const muteRow = page.getByTestId('shortcut-toggleMute');
    const deafenRow = page.getByTestId('shortcut-toggleDeafen');

    await muteRow.getByRole('button', { name: 'Change' }).click();
    await expect(muteRow.getByText('Press keys…')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+KeyC');
    await expect(page.getByRole('alert')).toContainText(/already use/);
    await expect(muteRow.getByText('Press keys…')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('alert')).toContainText(/move around/);
    await page.keyboard.press('Control+Backspace');
    await expect(page.getByRole('alert')).toContainText(/edit text/);

    await page.keyboard.press('ControlOrMeta+Shift+KeyD');
    await expect(page.getByRole('alert')).toContainText(/already the shortcut for Deafen/);

    await page.keyboard.press('Shift');
    await expect(muteRow.getByText('Press keys…')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(muteRow.getByText('Press keys…')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(muteRow.getByRole('img')).toHaveAttribute('aria-label', /\+ M$/);

    await muteRow.getByRole('button', { name: 'Change' }).click();
    await page.keyboard.press('Alt+KeyK');
    await expect(muteRow.getByRole('img')).toHaveAttribute('aria-label', /(Alt|Option) \+ K/);

    await deafenRow.getByRole('button', { name: 'Change' }).click();
    await page.keyboard.press('KeyJ');
    await expect(deafenRow.getByRole('img')).toHaveAttribute('aria-label', 'J');
    await closeSettings(page);

    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await expect(muted).toHaveCount(0);
    await page.keyboard.press('Alt+KeyK');
    await expect(muted).toBeVisible();
    await page.keyboard.press('Alt+KeyK');
    await expect(muted).toHaveCount(0);

    await openTextChannel(page, 'general');
    const composer = page.getByLabel('Message #general');
    await composer.click();
    await page.keyboard.press('KeyJ');
    await expect(composer).toHaveValue('j');
    await expect(undeafen).toHaveCount(0);
    await composer.fill('');

    await openSettings(page, 'Shortcuts');
    await page
      .getByTestId('shortcut-fullscreenShare')
      .getByRole('button', { name: 'Change' })
      .click();
    await page.keyboard.press('F8');
    await closeSettings(page);
    await composer.click();
    await page.keyboard.press('F8');
    await expect(page.getByText('There is no stream on screen')).toBeVisible();
    await composer.blur();

    await page.keyboard.down('KeyJ');
    await page.keyboard.down('KeyJ');
    await page.keyboard.down('KeyJ');
    await page.keyboard.up('KeyJ');
    await expect(undeafen).toBeVisible();
    await page.keyboard.press('KeyJ');
    await expect(undeafen).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await openSettings(page, 'Shortcuts');
    await expect(deafenRow.getByRole('img')).toHaveAttribute('aria-label', 'J');
    const { context: bobContext, page: bob } = await user(browser, USERS.bob);
    await openSettings(bob, 'Shortcuts');
    await expect(bob.getByTestId('shortcut-toggleDeafen').getByRole('img')).toHaveAttribute(
      'aria-label',
      /\+ D$/,
    );
    await bobContext.close();
    await page.reload();
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await openSettings(page, 'Shortcuts');
    await expect(deafenRow.getByRole('img')).toHaveAttribute('aria-label', 'J');
    await context.close();
  });

  test('fullscreen takes the stream on screen, and says so when there is none', async ({
    browser,
  }) => {
    const { context: aliceContext, page: alice } = await user(browser, USERS.alice);
    const { context: bobContext, page: bob } = await user(browser, USERS.bob);
    await openTextChannel(bob, 'general');
    await bob.keyboard.press('ControlOrMeta+Shift+KeyF');
    await expect(bob.getByText('There is no stream on screen')).toBeVisible();

    await joinVoice(alice, 'General Voice');
    await joinVoice(bob, 'General Voice');
    await alice.getByRole('button', { name: 'Share your screen' }).click();
    await alice.getByRole('button', { name: 'Start sharing' }).click();
    const video = bob.getByTestId('share-video-remote');
    await expect(video).toBeVisible({ timeout: 30_000 });

    await bob.keyboard.press('ControlOrMeta+Shift+KeyF');
    await expect
      .poll(() => bob.evaluate(() => document.fullscreenElement?.getAttribute('data-testid')))
      .toBe('share-video-remote');
    await bob.keyboard.press('ControlOrMeta+Shift+KeyF');
    await expect.poll(() => bob.evaluate(() => document.fullscreenElement)).toBeNull();

    await aliceContext.close();
    await bobContext.close();
  });
});
