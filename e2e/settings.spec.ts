import { expect, test, type Browser, type Page } from '@playwright/test';
import { channelButton, openTextChannel, sendMessage, signIn, USERS, type Person } from './helpers';

async function user(browser: Browser, who: Person) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await signIn(page, who);
  return { context, page };
}

async function openSettings(page: Page, tab: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: tab })
    .click();
}

test.describe('settings', () => {
  test('a channel can be made, renamed, moved, archived and brought back', async ({ browser }) => {
    const { context: ownerContext, page: owner } = await user(browser, USERS.alice);
    const { context: memberContext, page: member } = await user(browser, USERS.bob);
    const name = `room${Date.now().toString().slice(-6)}`;
    const renamed = `${name}x`;

    await openSettings(owner, 'Channels');
    const newChannel = owner.getByLabel('New text channel');
    await newChannel.fill(name);
    await newChannel.press('Enter');
    await expect(channelButton(member, name)).toBeVisible();
    await expect(newChannel).toHaveValue('');

    const nameField = owner.getByLabel(`Rename ${name}`);
    await nameField.fill(renamed);
    await nameField.press('Escape');
    await expect(nameField).toHaveValue(name);
    await expect(owner.getByRole('dialog')).toBeVisible();
    await nameField.fill(renamed);
    await nameField.press('Enter');
    await expect(channelButton(member, renamed)).toBeVisible();

    const row = owner.getByTestId('channel-row').filter({
      has: owner.getByLabel(`Rename ${renamed}`),
    });
    await expect(row.getByRole('button', { name: `Move ${renamed} down` })).toBeDisabled();
    await row.getByRole('button', { name: `Move ${renamed} up` }).click();
    await expect(row.getByRole('button', { name: `Move ${renamed} down` })).toBeEnabled();

    await owner.getByRole('button', { name: 'Close' }).click();
    await openTextChannel(member, renamed);
    const said = `still here ${name}`;
    await sendMessage(member, renamed, said);
    await expect(member.getByText(said)).toBeVisible();
    await openTextChannel(member, 'general');
    await openSettings(owner, 'Channels');

    const archive = row.getByRole('button', { name: 'Archive' });
    await archive.click();
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByRole('button', { name: 'Archive' })).toBeFocused();
    await archive.click();
    await owner.keyboard.press('Escape');
    await expect(owner.getByRole('dialog')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Archive' })).toBeFocused();
    await expect(channelButton(member, renamed)).toBeVisible();

    await archive.click();
    await row.getByRole('group').getByRole('button', { name: 'Archive' }).click();
    await expect(channelButton(member, renamed)).toHaveCount(0);

    const archived = owner.getByTestId('archived-row').filter({ hasText: renamed });
    await expect(archived).toBeVisible();
    await archived.getByRole('button', { name: 'Restore' }).click();
    await expect(archived).toHaveCount(0);
    await expect(channelButton(member, renamed)).toBeVisible();
    await openTextChannel(member, renamed);
    await expect(member.getByText(said)).toBeVisible();

    await row.getByRole('button', { name: 'Archive' }).click();
    await row.getByRole('group').getByRole('button', { name: 'Archive' }).click();
    await expect(channelButton(member, renamed)).toHaveCount(0);

    await ownerContext.close();
    await memberContext.close();
  });

  test('Remove asks first, and is not offered on the owner', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const owner = await context.newPage();
    await signIn(owner, USERS.alice);
    await openSettings(owner, 'Members');

    const bob = owner.getByTestId('member-row').filter({ hasText: USERS.bob.displayName });
    const alice = owner.getByTestId('member-row').filter({ hasText: USERS.alice.displayName });
    await expect(alice).toBeVisible();
    await expect(alice.getByRole('button', { name: 'Remove' })).toHaveCount(0);

    await bob.getByRole('button', { name: 'Remove' }).click();
    await expect(bob.getByRole('group')).toContainText('Remove');
    await bob.getByRole('button', { name: 'Cancel' }).click();
    await expect(bob.getByRole('group')).toHaveCount(0);
    await expect(bob.getByRole('button', { name: 'Remove' })).toBeVisible();

    await context.close();
  });

  for (const [what, tab] of [
    ['shortcuts', 'Shortcuts'],
    ['members', 'Members'],
    ['channels', 'Channels'],
  ] as const) {
    test(`the ${what} page fits a phone`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      const page = await context.newPage();
      await signIn(page, USERS.alice);
      await page.getByTestId('nav-toggle').click();
      await page.getByTestId('own-card').getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: tab, exact: true }).click();
      const panel = page.getByTestId('settings-panel');
      await expect(panel).toBeVisible();
      await expect.poll(() => panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await context.close();
    });
  }
});
