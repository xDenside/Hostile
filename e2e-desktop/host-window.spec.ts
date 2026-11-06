import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, newUserDir, readCode, removeDir, type Instance } from './host-harness';

const OWNER = { displayName: 'Room Host' };

async function answerCloseDialog(app: ElectronApplication, response: number) {
  await app.evaluate(({ dialog }, answer) => {
    const g = globalThis as unknown as { __asked: string[] };
    g.__asked ??= [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string };
      g.__asked.push(options.message);
      return { response: answer, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
}
const dialogsAsked = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __asked?: string[] }).__asked ?? []);
const closeMainWindow = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.isVisible())
      ?.close();
  });
const visibleWindows = (app: ElectronApplication) =>
  app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
  );

const status = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        hostileDesktop: {
          hosting: { status(): Promise<{ active: boolean; code: string | null }> };
        };
      }
    ).hostileDesktop.hosting.status(),
  );

test.describe.serial('the host window', () => {
  test.setTimeout(240_000);
  const dir = newUserDir('window');
  let host: Instance;
  let code = '';

  test.afterAll(async () => {
    await host?.app.close().catch(() => undefined);
    removeDir(dir);
  });

  test('the first screens, with no password to choose', async () => {
    host = await launch(dir);
    const { page } = host;
    await expect(page.getByRole('button', { name: 'Host a room' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join with a code' })).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: test.info().outputPath('choice.png') });
    await page.getByRole('button', { name: 'Host a room' }).click();
    await expect(page.getByRole('button', { name: 'Create my room' })).toBeDisabled();
    expect(await page.locator('input[type=password]').count()).toBe(0);
    await page.screenshot({ path: test.info().outputPath('host-setup.png') });
    await page.getByLabel('Nickname').fill(OWNER.displayName);
    await page.getByRole('button', { name: 'Create my room' }).click();
    code = await readCode(page);
    await expect(page.getByTestId('hosting-media')).toContainText('Running', { timeout: 30_000 });
    await expect(page.getByTestId('hosting-bridge')).toContainText('Running', { timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: test.info().outputPath('hosting-tab.png') });
    await page.getByRole('button', { name: 'Make a new code' }).click();
    await page.getByRole('button', { name: 'Stop hosting' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: test.info().outputPath('hosting-tab-asking.png') });
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await page.getByTestId('hosting-code').getByRole('button', { name: /Copy/ }).click();
    await expect.poll(() => host.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(code);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: test.info().outputPath('host-app.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    await page.getByRole('button', { name: 'Third-party notices' }).click();
    await expect(page.getByTestId('notices-text')).toContainText('Apache License');
    await expect(page.getByTestId('notices-text')).toContainText('MIT');
    await page.screenshot({ path: test.info().outputPath('diagnostics-tab.png') });
    await page.keyboard.press('Escape');
  });

  test('closing the window asks: cancel stays, keep hosting closes it and the room lives on', async () => {
    const { app } = host;
    await answerCloseDialog(app, 2);
    await closeMainWindow(app);
    await expect.poll(() => dialogsAsked(app)).toEqual(['Stop hosting this room?']);
    expect(await visibleWindows(app)).toBe(1);

    await answerCloseDialog(app, 1);
    await closeMainWindow(app);
    await expect.poll(() => visibleWindows(app)).toBe(0);
    const pid = app.process().pid!;
    expect(execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' })).toContain(
      `pid ${pid}`,
    );

    const opened = app.waitForEvent('window');
    await app.evaluate(({ app: electron }) => {
      electron.emit('activate');
    });
    const page = await opened;
    host.page = page;
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
      timeout: 30_000,
    });
    const now = await status(page);
    expect(now.active).toBe(true);
    expect(now.code).toBe(code);
  });

  test('closing and choosing to stop ends hosting, and hosting again keeps the code', async () => {
    const { app } = host;
    await answerCloseDialog(app, 0);
    await closeMainWindow(app);
    await expect.poll(() => visibleWindows(app), { timeout: 30_000 }).toBe(0);
    const pid = app.process().pid!;
    await expect
      .poll(
        () =>
          execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' }).includes(`pid ${pid}`),
        {
          timeout: 30_000,
        },
      )
      .toBe(false);
    const opened = app.waitForEvent('window');
    await app.evaluate(({ app: electron }) => {
      electron.emit('activate');
    });
    const page = await opened;
    host.page = page;
    await page.getByRole('button', { name: 'Host a room' }).click();
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', {
      timeout: 90_000,
    });
    expect((await status(page)).code).toBe(code);
  });

  test('a room that cannot start says so, in words', async () => {
    await host.app.close();
    renameSync(join(dir, 'host', 'data'), join(dir, 'host', 'data-aside'));
    mkdirSync(join(dir, 'host', 'data-blocker'));
    writeFileSync(join(dir, 'host', 'data'), 'not a folder');
    host = await launch(dir);
    await expect(host.page.getByText('The room could not start')).toBeVisible({ timeout: 90_000 });
    await expect(host.page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await host.page.waitForTimeout(800);
    await host.page.screenshot({ path: test.info().outputPath('host-error.png') });
    await host.page.getByRole('button', { name: 'Try again' }).click();
    await expect(host.page.getByRole('button', { name: 'Try again' })).toBeEnabled({
      timeout: 30_000,
    });
    await host.page.getByRole('button', { name: 'Back to the first screen' }).click();
    await expect(host.page.getByRole('button', { name: 'Host a room' })).toBeVisible({
      timeout: 20_000,
    });
    rmSync(join(dir, 'host', 'data'));
    rmSync(join(dir, 'host', 'data-blocker'), { recursive: true });
    renameSync(join(dir, 'host', 'data-aside'), join(dir, 'host', 'data'));
    await host.page.getByRole('button', { name: 'Host a room' }).click();
    await expect(host.page.getByTestId('connection-state')).toHaveAttribute(
      'data-state',
      'connected',
      { timeout: 90_000 },
    );
    expect((await status(host.page)).code).toBe(code);
  });
});
