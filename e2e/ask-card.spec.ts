import { expect, test } from '@playwright/test';

test('the join card fits a phone, and on a short screen all of it can be reached', async ({
  page,
}) => {
  for (const viewport of [
    { width: 360, height: 800 },
    { width: 360, height: 560 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByLabel('Nickname')).toBeVisible({ timeout: 45_000 });
    const screen = page.locator('main').first();

    const widths = await screen.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(widths[0]).toBeLessThanOrEqual(widths[1]!);

    await screen.evaluate((el) => el.scrollTo(0, 0));
    const subtitle = await page.getByText('Choose how the room sees you').boundingBox();
    expect(subtitle!.y).toBeGreaterThanOrEqual(0);

    const ask = page.getByRole('button', { name: 'Ask to join' });
    await ask.scrollIntoViewIfNeeded();
    const button = await ask.boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(viewport.height);
  }
});
