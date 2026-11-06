import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
import { pngFile } from './attachment-fixtures';
import {
  closeModal,
  openTextChannel,
  sendMessage,
  signIn,
  startOnDefaultNoiseMode,
  USERS,
  type Person,
} from './helpers';

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const row = (page: Page, text: string) =>
  page.getByRole('log').locator('[data-message-id]').filter({ hasText: text });

async function person(browser: Browser, who: Person, options: BrowserContextOptions = {}) {
  const context = await browser.newContext(options);
  const errors: string[] = [];
  context.on('weberror', (error) => errors.push(error.error().message));
  const page = await context.newPage();
  await signIn(page, who);
  return { context, page, errors };
}

async function openGeneral(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByTestId('nav-toggle').click();
  await openTextChannel(page, 'general');
}

test('a message goes both ways live, and a picture draws', async ({ browser, isMobile }) => {
  const alice = await person(browser, USERS.alice, { hasTouch: isMobile, isMobile });
  const bob = await person(browser, USERS.bob, { hasTouch: isMobile, isMobile });
  await openGeneral(alice.page, isMobile);
  await openGeneral(bob.page, isMobile);

  const question = `question ${stamp()}`;
  await sendMessage(bob.page, 'general', question);
  await expect(row(alice.page, question)).toBeVisible();

  const name = `picture-${stamp()}.png`;
  const answer = `answer ${stamp()}`;
  await alice.page.getByTestId('attach-input').setInputFiles(pngFile(name));
  await sendMessage(alice.page, 'general', answer);
  await expect(row(bob.page, answer)).toBeVisible();

  const drawn = (page: Page) =>
    page.locator(`img[alt="${name}"]`).evaluate((image: HTMLImageElement) => image.naturalWidth);
  await expect.poll(() => drawn(bob.page)).toBe(640);

  await bob.page.reload();
  await expect(row(bob.page, question)).toBeVisible();
  await expect.poll(() => drawn(bob.page)).toBe(640);

  expect(alice.errors).toEqual([]);
  expect(bob.errors).toEqual([]);
  await alice.context.close();
  await bob.context.close();
});

test('a right-click opens the menu, and Reply from it quotes the message', async ({
  browser,
}, info) => {
  test.skip(info.project.name === 'iphone', 'No right-click under a finger.');
  const alice = await person(browser, USERS.alice);
  await openTextChannel(alice.page, 'general');

  const text = `to reply to ${stamp()}`;
  await sendMessage(alice.page, 'general', text);
  await row(alice.page, text).getByText(text).click({ button: 'right' });
  const menu = alice.page.getByTestId('message-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Reply' }).click();
  await expect(menu).toHaveCount(0);
  await expect(alice.page.getByTestId('reply-bar')).toContainText(text);

  expect(alice.errors).toEqual([]);
  await alice.context.close();
});

test('starts on Strong, and the strong suppressor runs in this engine', async ({
  browser,
  isMobile,
}) => {
  const context = await browser.newContext(isMobile ? { hasTouch: true, isMobile: true } : {});
  startOnDefaultNoiseMode(context);
  const errors: string[] = [];
  context.on('weberror', (error) => errors.push(error.error().message));
  const page = await context.newPage();
  await signIn(page, USERS.alice);
  if (isMobile) await page.getByTestId('nav-toggle').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Voice & audio' }).click();
  await expect(page.getByTestId('noise-mode')).toHaveValue('strong');
  await closeModal(page);

  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'engine-check';
    button.textContent = 'engine check';
    button.style.cssText = 'position:fixed;inset:0;z-index:2147483647;opacity:0.01';
    button.addEventListener('click', () => {
      const module = '/src/features/voice/suppressor.ts';
      const w = window as unknown as { __engine?: Record<string, unknown> };
      void (async () => {
        try {
          const { SuppressorProcessor } = (await import(module)) as {
            SuppressorProcessor: {
              create(
                engine: string,
                broken: (reason: string) => void,
              ): Promise<{ name: string; context: AudioContext; destroy(): Promise<void> }>;
            };
          };
          const broken: string[] = [];
          const started = performance.now();
          const processor = await SuppressorProcessor.create('fastenhancer', (reason) =>
            broken.push(reason),
          );
          const result = {
            name: processor.name,
            state: processor.context.state,
            sampleRate: processor.context.sampleRate,
            startMs: Math.round(performance.now() - started),
          };
          await new Promise((r) => setTimeout(r, 1500));
          await processor.destroy();
          w.__engine = { ...result, broken, after: processor.context.state };
        } catch (err) {
          w.__engine = { error: err instanceof Error ? err.message : String(err) };
        }
      })();
    });
    document.body.append(button);
  });
  await page.locator('#engine-check').click();
  const engine = await page
    .waitForFunction(() => (window as unknown as { __engine?: unknown }).__engine, null, {
      timeout: 60_000,
    })
    .then((handle) => handle.jsonValue());
  console.log(`strong suppressor in this engine: ${JSON.stringify(engine)}`);
  expect(engine).toMatchObject({
    name: 'hostile-fastenhancer',
    state: 'running',
    sampleRate: 48_000,
    broken: [],
    after: 'closed',
  });
  expect(errors).toEqual([]);
  await context.close();
});

test.describe('on an iPhone', () => {
  test.skip(({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile, 'iPhone only.');

  test('the page fits, typing would not zoom it, and a swipe left starts a reply', async ({
    browser,
  }) => {
    const alice = await person(browser, USERS.alice, { hasTouch: true, isMobile: true });
    await openGeneral(alice.page, true);
    const { page } = alice;

    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(0);

    const composer = page.getByLabel('Message #general');
    const size = await composer.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);

    const text = `to swipe ${stamp()}`;
    await sendMessage(page, 'general', text);
    await expect(row(page, text)).toBeVisible();

    await row(page, text).evaluate((el) => {
      const box = el.getBoundingClientRect();
      const y = box.top + box.height / 2;
      const fire = (type: string, x: number) => {
        const touch = { identifier: 1, target: el, clientX: x, clientY: y };
        const held = type === 'touchend' ? [] : [touch];
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { touches: held, targetTouches: held, changedTouches: [touch] });
        el.dispatchEvent(event);
      };
      const start = box.right - 40;
      fire('touchstart', start);
      for (let moved = 10; moved <= 110; moved += 10) fire('touchmove', start - moved);
      fire('touchend', start - 110);
    });
    await expect(page.getByTestId('reply-bar')).toContainText(text);

    expect(alice.errors).toEqual([]);
    await alice.context.close();
  });
});
