import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { signIn, USERS } from './helpers';

test.describe('leaks', () => {
  test.setTimeout(180_000);
  test.skip(
    process.env.E2E_LIVEKIT_AVAILABLE !== '1',
    'livekit-server is not available on this machine',
  );

  async function audioContexts(cdp: CDPSession): Promise<number> {
    await cdp.send('HeapProfiler.collectGarbage');
    const { result: prototype } = await cdp.send('Runtime.evaluate', {
      expression: 'AudioContext.prototype',
    });
    const { objects } = await cdp.send('Runtime.queryObjects', {
      prototypeObjectId: prototype.objectId!,
    });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: objects.objectId!,
      functionDeclaration: 'function () { return this.length; }',
      returnByValue: true,
    });
    await cdp.send('Runtime.releaseObject', { objectId: objects.objectId! });
    await cdp.send('Runtime.releaseObject', { objectId: prototype.objectId! });
    return result.value as number;
  }

  async function deviceListeners(cdp: CDPSession): Promise<number> {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'navigator.mediaDevices',
    });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId!,
    });
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId! });
    return listeners.filter((listener) => listener.type === 'devicechange').length;
  }

  async function joinAndLeave(page: Page) {
    await page.getByRole('button', { name: /^General Voice/ }).click();
    await expect(page.getByTestId('voice-state')).toHaveText('Voice connected', {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Leave voice' }).click();
    await expect(page.getByTestId('voice-state')).toHaveCount(0);
  }

  test('a call leaves nothing behind when it ends', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['microphone'] });
    const page = await context.newPage();
    await signIn(page, USERS.alice);
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('Runtime.enable');

    await joinAndLeave(page);
    let settled = 0;
    await expect
      .poll(async () => (settled = await audioContexts(cdp)), { timeout: 15_000 })
      .toBeLessThanOrEqual(2);
    const listeners = await deviceListeners(cdp);

    for (let i = 0; i < 5; i++) await joinAndLeave(page);

    await expect.poll(() => audioContexts(cdp), { timeout: 15_000 }).toBeLessThanOrEqual(settled);
    expect(await deviceListeners(cdp)).toBeLessThanOrEqual(listeners);

    await context.close();
  });
});
