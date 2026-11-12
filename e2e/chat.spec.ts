import { expect, test, type Page } from '@playwright/test';
import {
  answerDelete,
  channelButton,
  installRealtimeBlocker,
  openTextChannel,
  sendMessage,
  setRealtimeBlocked,
  signIn,
  USERS,
} from './helpers';

test.describe('text chat between two users', () => {
  test('messages, edits, deletions, persistence and reconnect reconciliation', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await installRealtimeBlocker(bob);

    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');

    const text = `Привет, Bob! Unicode ✅ ${Date.now()}`;
    await sendMessage(alice, 'general', text);
    await expect(bob.getByText(text)).toBeVisible();
    await expect(alice.getByTestId('pending-message')).toHaveCount(0);

    await sendMessage(alice, 'general', '**bold** and `code` and <b>not html</b>');
    await expect(bob.locator('strong', { hasText: 'bold' })).toBeVisible();
    await expect(bob.getByText('<b>not html</b>')).toBeVisible();

    const editable = `edit me ${Date.now()}`;
    await sendMessage(alice, 'general', editable);
    await expect(bob.getByText(editable)).toBeVisible();
    const aliceMessage = alice.getByTestId('message').filter({ hasText: editable });
    await aliceMessage.hover();
    await aliceMessage.getByRole('button', { name: 'Edit message' }).click();
    await alice.keyboard.press('ControlOrMeta+a');
    await alice.keyboard.type('edited text');
    await alice.keyboard.press('Enter');
    await expect(bob.getByText('edited text')).toBeVisible();
    await expect(bob.getByText('(edited)').first()).toBeVisible();

    const deletable = `delete me ${Date.now()}`;
    await sendMessage(alice, 'general', deletable);
    await expect(bob.getByText(deletable)).toBeVisible();
    const toDelete = alice.getByTestId('message').filter({ hasText: deletable });
    await toDelete.hover();
    await toDelete.getByRole('button', { name: 'Delete message' }).click();
    await answerDelete(alice);
    await expect(bob.getByText(deletable)).toHaveCount(0);

    await bob.reload();
    await expect(bob.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await expect(bob.getByText(text)).toBeVisible();

    await setRealtimeBlocked(bob, true);
    await expect(bob.getByTestId('connection-state')).not.toHaveAttribute(
      'data-state',
      'connected',
      { timeout: 30_000 },
    );

    const missed = `missed while offline ${Date.now()}`;
    await sendMessage(alice, 'general', missed);
    const doomed = `doomed ${Date.now()}`;
    await sendMessage(alice, 'general', doomed);
    await expect(alice.getByText(doomed)).toBeVisible();
    const doomedRow = alice.getByTestId('message').filter({ hasText: doomed });
    await doomedRow.hover();
    await doomedRow.getByRole('button', { name: 'Delete message' }).click();
    await answerDelete(alice);
    await expect(alice.getByText(doomed)).toHaveCount(0);

    await setRealtimeBlocked(bob, false);
    await expect(bob.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
      timeout: 40_000,
    });
    await expect(bob.getByText(missed)).toBeVisible({ timeout: 20_000 });
    await expect(bob.getByText(doomed)).toHaveCount(0);

    await aliceContext.close();
    await bobContext.close();
  });

  test('a failed send is retried with the same id and never duplicates', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, USERS.alice);
    await openTextChannel(page, 'general');

    const unique = `retry test ${Date.now()}`;
    let attempts = 0;
    await page.route('**/api/channels/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts += 1;
      if (attempts === 1) return route.abort('connectionfailed');
      return route.continue();
    });

    await sendMessage(page, 'general', unique);
    await expect(page.getByText(unique)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('pending-message')).toHaveCount(0, { timeout: 20_000 });
    expect(attempts).toBeGreaterThan(1);
    await expect(page.getByTestId('message').filter({ hasText: unique })).toHaveCount(1);

    await context.close();
  });

  test('unread indicators and typing indicators', async ({ browser }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);

    await openTextChannel(bob, 'gaming');
    await openTextChannel(alice, 'general');
    await sendMessage(alice, 'general', `unread check ${Date.now()}`);
    await alice.waitForTimeout(3200);
    const generalButton = channelButton(bob, 'general');
    await expect(generalButton.getByLabel('Unread messages')).toBeVisible({ timeout: 15_000 });
    await generalButton.click();
    await expect(generalButton.getByLabel('Unread messages')).toHaveCount(0, { timeout: 15_000 });

    await typeWithoutSending(alice, 'general', 'typing…');
    await expect(bob.getByText(/is typing/)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => {
        const pill = (await bob.getByText(/is typing/).boundingBox())!;
        const last = (await bob.getByTestId('message').last().boundingBox())!;
        return pill.y - (last.y + last.height);
      })
      .toBeGreaterThanOrEqual(0);

    await aliceContext.close();
    await bobContext.close();
  });
});

async function typeWithoutSending(page: Page, channel: string, text: string) {
  const composer = page.getByLabel(`Message #${channel}`);
  await composer.click();
  await composer.pressSequentially(text, { delay: 25 });
}
