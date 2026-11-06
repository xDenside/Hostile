import { expect, test } from '@playwright/test';
import { openTextChannel, sendMessage } from './helpers';
import { joinAndAsk, startOwnRoomServer, startTunnelHost } from './tunnel-harness';

let server: Awaited<ReturnType<typeof startOwnRoomServer>> | undefined;
test.afterEach(async () => {
  await server?.destroy();
});

test('a guest survives a reload and a host restart, without a new code', async ({ browser }) => {
  test.setTimeout(240_000);
  server = await startOwnRoomServer({ port: 4294, autoAdmit: true });
  const host = await startTunnelHost({ roomUrl: server.url, livekitUrl: null });
  const context = await browser.newContext();
  const page = await context.newPage();
  await joinAndAsk(page, host.code, 'Comes Back');
  await openTextChannel(page, 'general');

  await page.reload();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
    timeout: 45_000,
  });
  await expect(page.getByLabel('Room code')).toHaveCount(0);
  await expect(page.getByLabel('Nickname')).toHaveCount(0);

  await host.closeBridge();
  await server.kill();
  await expect(page.getByTestId('connection-state')).toHaveText(/Host away/, { timeout: 30_000 });

  await page.reload();
  await expect(page.getByTestId('join-failed')).toHaveAttribute('data-step', 'finding-host', {
    timeout: 45_000,
  });
  await expect(page.getByTestId('join-failed')).toContainText('Trying again');

  await server.start();
  await host.openBridge();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
    timeout: 60_000,
  });
  await openTextChannel(page, 'general');
  const text = `after the restart ${Date.now()}`;
  await sendMessage(page, 'general', text);
  await expect(page.getByRole('log').getByText(text)).toBeVisible({ timeout: 15_000 });

  await host.closeBridge();
  await expect(page.getByTestId('connection-state')).toHaveText(/Host away/, { timeout: 30_000 });
  await host.openBridge();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('connection-state')).toHaveText(/Connected/);

  await context.close();
  await host.stop();
  await server.destroy();
});
