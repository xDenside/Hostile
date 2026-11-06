import { expect, test } from '@playwright/test';
import { askAndEnter, openTextChannel, sendMessage, signIn, USERS } from './helpers';

test.describe('membership', () => {
  test('a person joins, and is then removed', async ({ browser }) => {
    const ownerContext = await browser.newContext();
    const newcomerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const newcomer = await newcomerContext.newPage();

    await signIn(owner, USERS.alice);

    const nickname = `Carol ${Date.now().toString().slice(-6)}`;
    await askAndEnter(newcomer, nickname);

    await openTextChannel(newcomer, 'general');
    const hello = `hello from ${nickname}`;
    await sendMessage(newcomer, 'general', hello);
    await expect(newcomer.getByText(hello)).toBeVisible();

    await owner.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await owner.getByRole('button', { name: 'Members', exact: true }).click();
    const row = owner.getByTestId('member-row').filter({ hasText: nickname });
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Remove' }).last().click();
    await expect(owner.getByTestId('member-row').filter({ hasText: nickname })).toHaveCount(0);

    if (process.env.E2E_TUNNEL_MODE) {
      await expect(newcomer.getByTestId('join-ended')).toContainText('removed you', {
        timeout: 30_000,
      });
    } else {
      await expect(newcomer.getByRole('button', { name: 'Ask to join' })).toBeVisible({
        timeout: 30_000,
      });
    }

    const again = `${nickname} again`;
    await askAndEnter(newcomer, again);
    await openTextChannel(newcomer, 'general');
    await expect(newcomer.getByText(hello)).toBeVisible();
    await owner.keyboard.press('Escape');
    await openTextChannel(owner, 'general');
    await expect(owner.getByText(hello)).toBeVisible();

    await ownerContext.close();
    await newcomerContext.close();
  });

  test('a member cannot reach owner-only administration', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, USERS.bob);

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Members', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Channels' })).toHaveCount(0);

    const status = await page.evaluate(async () => {
      const res = await fetch('/api/admin/users', { credentials: 'same-origin' });
      return res.status;
    });
    expect(status).toBe(403);

    await context.close();
  });
});
