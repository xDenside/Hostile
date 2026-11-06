import { expect, test } from '@playwright/test';
import { openTextChannel, sendMessage, USERS } from './helpers';
import {
  GUEST_URL,
  joinAndSignIn,
  startTunnelHost,
  watchForLeaks,
  type TunnelHost,
} from './tunnel-harness';

test.describe('chat through the tunnel', () => {
  let host: TunnelHost;
  test.beforeAll(async () => {
    host = await startTunnelHost();
  });
  test.afterAll(async () => {
    await host.stop();
  });

  test('two guests come in, exchange messages live, and see presence and typing', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const leaks = [...[alice, bob].map(watchForLeaks)];

    await joinAndSignIn(alice, host.code, USERS.alice);
    await expect(host.page.locator('#status')).toHaveAttribute('data-guests', '1');
    await joinAndSignIn(bob, host.code, USERS.bob);
    await expect(host.page.locator('#status')).toHaveAttribute('data-guests', '2');
    expect(host.gateway.guests()).toBe(2);

    await expect(alice.getByText('Test Room').first()).toBeVisible();
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');

    const fromAlice = `tunnel hello ${Date.now()}`;
    await sendMessage(alice, 'general', fromAlice);
    await expect(bob.getByRole('log').getByText(fromAlice)).toBeVisible({ timeout: 15_000 });
    const fromBob = `tunnel reply ${Date.now()}`;
    await sendMessage(bob, 'general', fromBob);
    await expect(alice.getByRole('log').getByText(fromBob)).toBeVisible({ timeout: 15_000 });

    const composer = alice.getByLabel('Message #general');
    const typing = composer.pressSequentially('still typing, and typing, and typing', {
      delay: 150,
    });
    await expect(bob.getByText(/is typing/)).toContainText('Alice', { timeout: 10_000 });
    await typing;
    await alice.getByLabel('Message #general').fill('');

    const onlineCount = alice
      .getByRole('complementary', { name: 'Members' })
      .getByText(/^Online — /);
    await expect(onlineCount).toHaveText('Online — 2', { timeout: 10_000 });
    await bob.close();
    await expect(onlineCount).toHaveText('Online — 1', { timeout: 45_000 });

    expect(leaks.flat(), 'requests that went around the tunnel').toEqual([]);
    await aliceContext.close();
    await bobContext.close();
  });

  test('a guest finds a host gone quiet at once, without waiting for it to speak', async ({
    browser,
  }) => {
    const quiet = await startTunnelHost();
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(GUEST_URL);
    const started = Date.now();
    await page.getByLabel('Room code').fill(quiet.code);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByLabel('Nickname')).toBeVisible({ timeout: 8_000 });
    expect(Date.now() - started).toBeLessThan(8_000);
    await context.close();
    await quiet.stop();
  });

  test('a guest who has granted nothing, as anyone on a first visit, connects all the same', async ({
    browser,
  }) => {
    const context = await browser.newContext({ permissions: [] });
    const page = await context.newPage();
    await joinAndSignIn(page, host.code, USERS.bob);
    await context.close();
  });

  test('answering "stay" to the question on leaving keeps the connection', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await joinAndSignIn(page, host.code, USERS.bob);
    await openTextChannel(page, 'general');
    await page.evaluate(() =>
      window.addEventListener('beforeunload', (event) => event.preventDefault()),
    );
    const asked = page.waitForEvent('dialog');
    await page.close({ runBeforeUnload: true });
    const dialog = await asked;
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    const text = `Still here ${Date.now()}`;
    await sendMessage(page, 'general', text);
    await expect(page.locator('[data-message-id]').filter({ hasText: text })).toBeVisible();
    await context.close();
  });
});
