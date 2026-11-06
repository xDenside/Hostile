import { expect, test, type Page } from '@playwright/test';
import { joinVoice } from '../e2e/helpers';
import { launch, newUserDir, readCode, removeDir, type Instance } from './host-harness';

async function dragRegions(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    const region = (el: Element, pseudo?: string) =>
      getComputedStyle(el, pseudo).getPropertyValue('-webkit-app-region').trim();
    const name = (el: Element) => {
      const label =
        el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().replace(/\s+/g, ' ');
      const classes = [...el.classList].join('.');
      return `<${el.tagName.toLowerCase()}${classes ? `.${classes}` : ''}>${label.slice(0, 40)}`;
    };
    const overlaps = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const all = [...document.querySelectorAll('*')];

    const drags = all.filter((el) => region(el) === 'drag');
    for (const el of all) {
      for (const pseudo of ['::before', '::after']) {
        const drawn = !['none', 'normal'].includes(getComputedStyle(el, pseudo).content);
        if (drawn && region(el, pseudo) === 'drag')
          problems.push(`${name(el)}${pseudo} is a drag region`);
      }
    }
    for (const el of drags) {
      if (el.children.length || (el.textContent ?? '').trim())
        problems.push(`${name(el)} is a drag region with something inside it`);
    }
    const dragRects = drags
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);

    const controls = all.filter(
      (el) =>
        el.matches(
          'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=tab], ' +
            '[role=switch], [role=checkbox], [role=radio], [role=menuitem], [role=option], [contenteditable=true], ' +
            '[tabindex]:not([tabindex="-1"])',
        ) && el.getClientRects().length > 0,
    );
    for (const el of controls) {
      for (let at: Element | null = el; at; at = at.parentElement) {
        if (region(at) === 'drag') {
          problems.push(`${name(el)} is inside the drag region ${name(at)}`);
          break;
        }
      }
      if (dragRects.some((d) => overlaps(el.getBoundingClientRect(), d)))
        problems.push(`${name(el)} is under a drag region`);
    }

    for (const el of all) {
      const style = getComputedStyle(el);
      if (!/auto|scroll|overlay/.test(`${style.overflowX} ${style.overflowY}`)) continue;
      if (region(el) === 'drag') problems.push(`the scrolling ${name(el)} is a drag region`);
      const box = el.getBoundingClientRect();
      const port = new DOMRect(
        box.left + el.clientLeft,
        box.top + el.clientTop,
        el.clientWidth,
        el.clientHeight,
      );
      if (port.width > 0 && port.height > 0 && dragRects.some((d) => overlaps(port, d)))
        problems.push(`the scrolling ${name(el)} runs under a drag region`);
    }

    return {
      problems,
      strips: dragRects.map((r) => ({ top: r.top, height: r.height, width: r.width })),
      width: window.innerWidth,
    };
  });
}

async function expectSafeDragging(page: Page, screen: string) {
  await page.waitForTimeout(600);
  const found = await dragRegions(page);
  expect(found.problems, screen).toEqual([]);
  expect(found.strips, screen).toContainEqual({ top: 0, height: 28, width: found.width });
}

test.skip(process.platform !== 'darwin', 'Only the macOS window has no title bar of its own.');

test('no control or scrolling area is in or under a window drag region on the first screen, the setup card, Settings, the room, a profile card, the Forward and Delete dialogs, a voice call and the Join screen', async () => {
  test.setTimeout(240_000);
  const dir = newUserDir('drag');
  const guestDir = newUserDir('drag-guest');
  let host: Instance | null = null;
  let guest: Instance | null = null;
  try {
    host = await launch(dir);
    const { page } = host;
    await expect(page.getByRole('button', { name: 'Host a room' })).toBeVisible();
    await expectSafeDragging(page, 'the first screen');

    await page.getByRole('button', { name: 'Host a room' }).click();
    await expect(page.getByLabel('Nickname')).toBeVisible({ timeout: 60_000 });
    await expectSafeDragging(page, 'the setup card');
    await host.app.evaluate(({ BrowserWindow }) => {
      const [main] = BrowserWindow.getAllWindows().filter((w) => w.isVisible());
      main!.setSize(940, 600);
    });
    await expectSafeDragging(page, 'the setup card in the smallest window');

    await page.getByLabel('Nickname').fill('Drag Check');
    await page.getByRole('button', { name: 'Create my room' }).click();
    await readCode(page);
    await expectSafeDragging(page, 'Settings, on the Hosting tab');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /general/ }).first()).toBeVisible();
    await expectSafeDragging(page, 'the room');

    await page.getByRole('complementary').getByText('Drag Check').first().click();
    await expect(page.getByTestId('profile-card')).toBeVisible();
    await expectSafeDragging(page, 'a profile card');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('profile-card')).toHaveCount(0);

    const composer = page.getByLabel('Message #general');
    await composer.fill('drag check message');
    await composer.press('Enter');
    const message = page.getByRole('log').getByText('drag check message').first();
    await expect(message).toBeVisible();
    for (const action of ['Forward', 'Delete']) {
      await message.click({ button: 'right' });
      await page.getByRole('menuitem', { name: action }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectSafeDragging(page, `the ${action} dialog`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }

    await joinVoice(page, 'General Voice');
    await expectSafeDragging(page, 'a voice call');

    await host.app.close();
    host = null;
    guest = await launch(guestDir);
    await guest.page.getByRole('button', { name: 'Join with a code' }).click();
    await expect(guest.page.getByLabel('Room code')).toBeVisible({ timeout: 30_000 });
    await expectSafeDragging(guest.page, 'the Join screen');
  } finally {
    await host?.app.close().catch(() => undefined);
    await guest?.app.close().catch(() => undefined);
    removeDir(dir);
    removeDir(guestDir);
  }
});
