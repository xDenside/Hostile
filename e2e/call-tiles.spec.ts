import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { askAndEnter, joinVoice, signIn, USERS, type Person } from './helpers';

const TOLERANCE = 0.5;
const SMALLEST = 32;
const CLEARANCE = 3;

interface Tile {
  user: string;
  kind: 'large' | 'strip';
  speaking: boolean;
  width: number;
  height: number;
  animating: boolean;
  dx: number;
  dy: number;
  ringDx: number;
  ringDy: number;
  size: number;
  radius: number;
  reach: number;
  tagWidth: number;
  tagHeight: number;
  outside: number;
}

function measure(page: Page): Promise<Tile[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid=participant-tile]')].map((tile) => {
      const t = tile.getBoundingClientRect();
      const local = (r: DOMRect) => ({
        left: r.left - t.left,
        top: r.top - t.top,
        right: r.right - t.left,
        bottom: r.bottom - t.top,
      });
      const wrap = tile.querySelector<HTMLElement>('[class*=largeAvatar]');
      const circle = (wrap ?? tile).querySelector<HTMLElement>('[class*=avatar]')!;
      const a = local((wrap ?? circle).getBoundingClientRect());
      const c = local(circle.getBoundingClientRect());
      const cx = (c.left + c.right) / 2;
      const cy = (c.top + c.bottom) / 2;
      const label = wrap ? tile.querySelector<HTMLElement>('[class*=largeLabel]') : null;
      const l = label ? local(label.getBoundingClientRect()) : null;
      const reach = l
        ? Math.hypot(Math.max(l.left - cx, 0, cx - l.right), Math.max(l.top - cy, 0, cy - l.bottom))
        : Infinity;
      const g = tile.closest('[data-testid=participant-tiles]')!.getBoundingClientRect();
      return {
        user: tile.getAttribute('data-user') ?? '',
        kind: wrap ? ('large' as const) : ('strip' as const),
        speaking: tile.hasAttribute('data-speaking'),
        width: t.width,
        height: t.height,
        animating:
          Math.abs(t.width - tile.offsetWidth) > 1 || Math.abs(t.height - tile.offsetHeight) > 1,
        dx: (a.left + a.right) / 2 - t.width / 2,
        dy: (a.top + a.bottom) / 2 - t.height / 2,
        ringDx: cx - (a.left + a.right) / 2,
        ringDy: cy - (a.top + a.bottom) / 2,
        size: circle.offsetWidth,
        radius: (c.right - c.left) / 2,
        reach,
        tagWidth: l ? l.right - l.left : 0,
        tagHeight: l ? l.bottom - l.top : 0,
        outside: wrap
          ? Math.max(0, g.left - t.left, t.right - g.right, g.top - t.top, t.bottom - g.bottom)
          : 0,
      };
    }),
  );
}

const sizeBefore = (height: number) =>
  Math.round(Math.max(40, Math.min(Math.round(height) * 0.36, 128)));
const clearance = (t: Tile) => t.reach - t.radius;

function problems(tiles: Tile[]): string[] {
  const found: string[] = [];
  for (const t of tiles) {
    const who = `${t.kind} tile ${t.width.toFixed(0)}x${t.height.toFixed(0)}`;
    if (t.animating) found.push(`${who} is still animating`);
    if (t.kind === 'large' && Math.abs(t.dx) > TOLERANCE) found.push(`${who}: dx ${t.dx}`);
    if (Math.abs(t.dy) > TOLERANCE) found.push(`${who}: dy ${t.dy}`);
    if (Math.abs(t.ringDx) > TOLERANCE || Math.abs(t.ringDy) > TOLERANCE)
      found.push(`${who}: ring off its wrapper`);
    if (t.outside > TOLERANCE) found.push(`${who}: ${t.outside} px outside the call`);
    if (t.kind !== 'large') continue;
    const before = sizeBefore(t.height);
    if (t.size > before) found.push(`${who}: avatar ${t.size} px, larger than ${before}`);
    if (t.size < SMALLEST) found.push(`${who}: avatar ${t.size} px, under ${SMALLEST}`);
    if (t.size > SMALLEST && clearance(t) < CLEARANCE)
      found.push(`${who}: avatar ${t.size} px only ${clearance(t).toFixed(1)} px from the tag`);
    const roomForBefore = t.reach - (before / 2) * 1.04;
    if (t.size < before && roomForBefore >= 4 + 1)
      found.push(`${who}: avatar shrunk to ${t.size} px though ${before} px had room`);
  }
  return found;
}

const report = (t: Tile) =>
  `${t.kind}${t.speaking ? ' speaking' : ''} ${t.width.toFixed(0)}x${t.height.toFixed(0)}: dx ${t.dx.toFixed(2)} dy ${t.dy.toFixed(2)}` +
  (t.kind === 'large'
    ? `, avatar ${t.size} px (before ${sizeBefore(t.height)}), tag ${t.tagWidth.toFixed(0)}x${t.tagHeight.toFixed(0)}, ${Number.isFinite(t.reach) ? `${clearance(t).toFixed(1)} px from the tag` : 'no tag'}`
    : '');

async function expectCentred(page: Page, layout: string, count: number, whileSpeaking = false) {
  await expect(page.getByTestId('participant-tile')).toHaveCount(count, { timeout: 30_000 });
  await page.mouse.move(0, 0);
  let last: Tile[] = [];
  await expect
    .poll(
      async () => {
        last = await measure(page);
        if (whileSpeaking && !last.some((t) => t.speaking)) return ['nobody is speaking yet'];
        return problems(last);
      },
      {
        message: `${layout}: avatar centred, clear of the tag, tiles inside the call`,
        timeout: 10_000,
      },
    )
    .toEqual([]);
  console.log(`${layout}: ${last.map(report).join('; ')}`);
  return last;
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

const opened: BrowserContext[] = [];

async function person(
  browser: Browser,
  who: Person | string,
  options: Parameters<Browser['newContext']>[0] = {},
) {
  const context = await browser.newContext({ permissions: ['microphone'], ...options });
  opened.push(context);
  const page = await context.newPage();
  if (typeof who === 'string') await askAndEnter(page, who);
  else await signIn(page, who);
  return page;
}

test.describe('a call tile', () => {
  test.setTimeout(240_000);
  test.afterEach(async () => {
    for (const context of opened.splice(0)) await context.close().catch(() => undefined);
  });

  test('has its avatar centred and clear of the name tag, alone, in pairs, in a grid and at the smallest window', async ({
    browser,
  }) => {
    const alice = await person(browser, USERS.alice, { viewport: { width: 1440, height: 900 } });
    await joinVoice(alice, 'General Voice');
    await expectCentred(alice, 'alone, 1440x900', 1);
    await shot(alice, 'alone-1440x900');
    await alice.setViewportSize({ width: 940, height: 600 });
    await expectCentred(alice, 'alone, 940x600', 1);
    await alice.setViewportSize({ width: 1440, height: 900 });

    const bob = await person(browser, USERS.bob);
    await joinVoice(bob, 'General Voice');
    await expectCentred(alice, 'two, 1440x900', 2);
    await expect(alice.locator('[data-testid=participant-tile][data-speaking]')).not.toHaveCount(
      0,
      { timeout: 20_000 },
    );
    const speaking = await expectCentred(alice, 'two, someone speaking', 2, true);
    const sizes = speaking.map((t) => t.size).join();
    for (let i = 0; i < 10; i++) {
      await alice.waitForTimeout(200);
      expect((await measure(alice)).map((t) => t.size).join(), 'no change while speaking').toBe(
        sizes,
      );
    }

    const suffix = Date.now().toString().slice(-6);
    for (const name of [
      `Carol ${suffix}`,
      `Dave ${suffix}`,
      `Bartholomew Featherstonehaugh ${suffix}`,
    ]) {
      await joinVoice(await person(browser, name), 'General Voice');
    }
    await expectCentred(alice, 'five, 1440x900', 5);
    await shot(alice, 'five-1440x900');

    for (const size of [
      { width: 1280, height: 860 },
      { width: 1100, height: 700 },
      { width: 940, height: 600 },
    ]) {
      await alice.setViewportSize(size);
      await expectCentred(alice, `five, ${size.width}x${size.height}`, 5);
    }
    await shot(alice, 'five-940x600');
    const toggle = alice.getByTestId('voice-chat-toggle');
    const chatWas = await toggle.getAttribute('aria-pressed');
    await toggle.click();
    await expect(toggle).not.toHaveAttribute('aria-pressed', chatWas ?? '');
    await expectCentred(alice, `five, 940x600, chat ${chatWas === 'true' ? 'closed' : 'open'}`, 5);
    await shot(alice, `five-940x600-chat-${chatWas === 'true' ? 'closed' : 'open'}`);
  });

  test('keeps it centred on a phone, and beside a screen share or a focused one', async ({
    browser,
  }) => {
    const alice = await person(browser, USERS.alice, { viewport: { width: 1280, height: 860 } });
    const bob = await person(browser, USERS.bob, {
      viewport: { width: 390, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    await joinVoice(alice, 'General Voice');
    await bob.getByTestId('nav-toggle').click();
    await bob
      .getByRole('navigation', { name: 'Channels' })
      .getByRole('button', { name: /^General Voice/ })
      .click();
    await expect(bob.getByTestId('voice-state')).toHaveText('Voice connected', { timeout: 30_000 });
    await expectCentred(bob, 'phone, two', 2);
    await shot(bob, 'phone-two-390x780');
    await bob.setViewportSize({ width: 390, height: 600 });
    await expectCentred(bob, 'phone, short', 2);

    await alice.getByRole('button', { name: 'Share your screen' }).click();
    await alice.getByRole('button', { name: 'Start sharing' }).click();
    await expect(alice.getByTestId('share-tile-local')).toBeVisible({ timeout: 30_000 });
    const strip = await expectCentred(alice, 'beside a screen share', 2);
    expect(strip.every((t) => t.kind === 'strip')).toBe(true);
    await shot(alice, 'beside-share-1280x860');
    await expectCentred(bob, 'phone, beside a screen share', 2);

    const second = await person(browser, `Erin ${Date.now().toString().slice(-6)}`);
    await joinVoice(second, 'General Voice');
    await second.getByRole('button', { name: 'Share your screen' }).click();
    await second.getByRole('button', { name: 'Start sharing' }).click();
    await expect(alice.getByTestId('share-tile-remote')).toBeVisible({ timeout: 30_000 });
    await alice.getByRole('button', { name: 'Enlarge this stream' }).first().click();
    await expect(alice.locator('[class*=stageFocused]')).toBeVisible();
    await expectCentred(alice, 'a focused stream', 3);

    await alice
      .getByTestId('share-tile-local')
      .getByRole('button', { name: 'Stop sharing' })
      .click();
    await second
      .getByTestId('share-tile-local')
      .getByRole('button', { name: 'Stop sharing' })
      .click();
    await expect(alice.getByTestId('share-tile-remote')).toHaveCount(0, { timeout: 20_000 });
    const back = await expectCentred(alice, 'after the streams end', 3);
    expect(back.every((t) => t.kind === 'large')).toBe(true);
  });
});
