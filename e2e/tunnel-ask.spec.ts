import { expect, test } from '@playwright/test';
import {
  joinByCode,
  OWN_OWNER_SECRET,
  startOwnRoomServer,
  startTunnelHost,
} from './tunnel-harness';

test('through the tunnel, a person asks, waits, is turned away, asks again and is let in', async ({
  browser,
}) => {
  const server = await startOwnRoomServer({ port: 4295 });
  const own = await startTunnelHost({ roomUrl: server.url, livekitUrl: null });
  const context = await browser.newContext();
  try {
    const owner = await fetch(`${server.url}/api/auth/owner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: OWN_OWNER_SECRET, client: 'desktop' }),
    });
    expect(owner.status).toBe(200);
    const { accessToken } = (await owner.json()) as { accessToken: string };
    const asOwner = (path: string, method = 'GET') =>
      fetch(`${server.url}/api/admin/${path}`, {
        method,
        headers: { authorization: `Bearer ${accessToken}` },
      });
    const waiting = async () =>
      (
        (await (await asOwner('join-requests')).json()) as {
          requests: { id: string; nickname: string }[];
        }
      ).requests;
    const peopleNow = async () =>
      ((await (await asOwner('users')).json()) as { users: unknown[] }).users.length;

    const page = await context.newPage();
    await joinByCode(page, own.code);
    const people = await peopleNow();

    await page.getByLabel('Nickname').fill('Through The Tunnel');
    await page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(page.getByTestId('ask-waiting')).toBeVisible();
    await expect(page.getByTestId('ask-waiting').getByRole('status')).toHaveText(
      'Waiting for the host, Through The Tunnel',
    );
    await expect
      .poll(waiting)
      .toEqual([expect.objectContaining({ nickname: 'Through The Tunnel' })]);

    const [first] = await waiting();
    expect((await asOwner(`join-requests/${first!.id}/turn-away`, 'POST')).status).toBeLessThan(
      300,
    );
    await expect(page.getByTestId('ask-turned-away')).toBeVisible({ timeout: 15_000 });
    expect(await peopleNow()).toBe(people);

    await page.getByRole('button', { name: 'Ask again' }).click();
    await page.getByRole('button', { name: 'Ask to join' }).click();
    await expect.poll(waiting).toHaveLength(1);
    const [second] = await waiting();
    expect((await asOwner(`join-requests/${second!.id}/let-in`, 'POST')).status).toBeLessThan(300);
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
      timeout: 30_000,
    });
    expect(await peopleNow()).toBe(people + 1);
  } finally {
    await context.close();
    await own.stop();
    await server.destroy();
  }
});
