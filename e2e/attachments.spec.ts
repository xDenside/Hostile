import { expect, test, type Page } from '@playwright/test';
import { buildFtyp, expectAtBottom, png, pngFile, REAL_VIDEOS, user } from './attachment-fixtures';
import { answerDelete, openTextChannel, sendMessage, USERS } from './helpers';

const UPLOADS = '**/api/channels/*/attachments*';
const FILES = '**/api/attachments/*';
const PHONE = { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true };

const webm = (name: string) => ({
  name,
  mimeType: 'video/webm',
  buffer: REAL_VIDEOS.webm.bytes,
});

const attach = (page: Page, files: Parameters<Page['setInputFiles']>[1]) =>
  page.getByTestId('attach-input').setInputFiles(files);

const rowWithImage = (page: Page, name: string) =>
  page.getByTestId('message').filter({ has: page.locator(`img[alt="${name}"]`) });

async function expectDrawn(page: Page, name: string) {
  await expect
    .poll(() =>
      page
        .locator(`img[alt="${name}"]`)
        .first()
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBeGreaterThan(0);
}

async function pair(browser: Parameters<typeof user>[0], channel = 'general') {
  const a = await user(browser, USERS.alice);
  const b = await user(browser, USERS.bob);
  await openTextChannel(a.page, channel);
  await openTextChannel(b.page, channel);
  return {
    alice: a.page,
    bob: b.page,
    close: () => Promise.all([a.context.close(), b.context.close()]),
  };
}

test.describe('sending a file', () => {
  test('an image with text reaches the other member live, survives a reload, and opens in the viewer', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const composer = alice.getByLabel('Message #general');
    const text = `Look at this ${Date.now()}`;
    const name = `view-${Date.now()}.png`;

    await attach(alice, pngFile(name, 1600, 900));
    await expect(alice.getByTestId('tray-file')).toContainText(name);
    await composer.fill(text);
    await composer.press('Enter');

    await expect(composer).toHaveValue('');
    await expect(alice.getByTestId('attachment-tray')).toHaveCount(0);

    const bobRow = rowWithImage(bob, name);
    await expect(bobRow).toContainText(text);
    await expectDrawn(bob, name);
    await expect(alice.getByTestId('pending-message')).toHaveCount(0);
    await expect(rowWithImage(alice, name)).toContainText(text);

    await bob.reload();
    await expect(rowWithImage(bob, name)).toContainText(text);
    await expectDrawn(bob, name);

    const open = rowWithImage(bob, name).getByRole('button', { name: `Open image ${name}` });
    await open.click();
    const viewer = bob.getByTestId('image-viewer');
    await expect(viewer).toBeVisible();
    await expect
      .poll(() => viewer.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBe(1600);
    expect(await bob.evaluate(() => document.getElementById('root')!.inert)).toBe(true);
    for (let i = 0; i < 6; i++) {
      await bob.keyboard.press('Tab');
      expect(
        await bob.evaluate(() => !!document.activeElement?.closest('[data-testid="image-viewer"]')),
      ).toBe(true);
    }
    const download = viewer.getByRole('link', { name: 'Download' });
    await expect(download).toHaveAttribute('download', name);

    await bob.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    expect(await bob.evaluate(() => document.getElementById('root')!.inert)).toBe(false);
    await expect(open).toBeFocused();

    await open.click();
    await viewer.locator('img').click();
    await expect(viewer).toBeVisible();
    await viewer.click({ position: { x: 8, y: 400 } });
    await expect(viewer).toHaveCount(0);
    await close();
  });

  test('several images go through the viewer by button and arrow key, with the page behind it still', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const stamp = Date.now();
    const names = [`one-${stamp}.png`, `two-${stamp}.png`, `three-${stamp}.png`];
    await attach(
      alice,
      names.map((name, i) => pngFile(name, 600, 600, i + 1)),
    );
    await alice.getByLabel('Message #general').press('Enter');

    const row = rowWithImage(bob, names[0]!);
    await expect(row.locator('img')).toHaveCount(3);
    expect(
      await row.locator('img').evaluateAll((all) => all.map((i) => i.getAttribute('alt'))),
    ).toEqual(names);

    await row.getByRole('button', { name: `Open image ${names[1]}` }).click();
    const viewer = bob.getByTestId('image-viewer');
    await expect(viewer).toContainText('2 of 3');
    await bob.keyboard.press('ArrowRight');
    await expect(viewer).toContainText('3 of 3');
    await expect(viewer.locator('img')).toHaveAttribute('alt', names[2]!);
    await viewer.getByRole('button', { name: 'Next image' }).click();
    await expect(viewer).toContainText('1 of 3');
    await bob.keyboard.press('ArrowLeft');
    await expect(viewer).toContainText('3 of 3');
    await viewer.getByRole('button', { name: 'Previous image' }).click();
    await expect(viewer).toContainText('2 of 3');

    const list = bob.getByRole('log');
    const before = await list.evaluate((el) => el.scrollTop);
    await bob.mouse.move(640, 400);
    await bob.mouse.wheel(0, -500);
    await bob.waitForTimeout(150);
    expect(await list.evaluate((el) => el.scrollTop)).toBe(before);

    await bob.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await close();
  });

  test('a file with no text sends from the button, and leaves no empty line', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const name = `silent-${Date.now()}.png`;

    await expect(alice.getByRole('button', { name: 'Send message' })).toHaveCount(0);
    const composer = alice.getByLabel('Message #general');
    await composer.press('Enter');
    await alice.waitForTimeout(100);
    expect(await alice.getByTestId('pending-message').count()).toBe(0);

    await attach(alice, pngFile(name));
    await alice.getByRole('button', { name: 'Send message' }).click();
    await expect(rowWithImage(bob, name)).toBeVisible();
    await expect(rowWithImage(bob, name).getByTestId('message-text')).toHaveCount(0);
    await expect(alice.getByRole('button', { name: 'Send message' })).toHaveCount(0);
    await close();
  });

  test('a video in a voice channel chat loads for the other member, with a duration and a seek', async ({
    browser,
  }) => {
    const a = await user(browser, USERS.alice);
    const b = await user(browser, USERS.bob);
    const alice = a.page;
    const bob = b.page;
    for (const page of [alice, bob]) {
      await page.getByRole('button', { name: /^General Voice/ }).click();
      await expect(page.getByTestId('voice-state')).toHaveText('Voice connected', {
        timeout: 30_000,
      });
    }
    const name = `clip-${Date.now()}.webm`;
    const measured = alice.waitForRequest((r) => r.url().includes('/attachments?'));
    await attach(alice, webm(name));
    await alice.getByLabel('Message General Voice').fill('From the call');
    await alice.getByLabel('Message General Voice').press('Enter');
    expect(new URL((await measured).url()).searchParams.get('width')).toBe('32');

    const aside = bob.getByRole('complementary', { name: 'Chat in General Voice' });
    const video = aside.locator(`video[aria-label="${name}"]`);
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 })
      .toBeGreaterThan(0);
    const { duration, seeked } = await video.evaluate(async (v: HTMLVideoElement) => {
      const target = v.duration / 2;
      await new Promise((resolve) => {
        v.addEventListener('seeked', resolve, { once: true });
        v.currentTime = target;
      });
      return { duration: v.duration, seeked: v.currentTime };
    });
    expect(Number.isFinite(duration)).toBe(true);
    expect(seeked).toBeGreaterThan(0);

    const list = aside.getByRole('log');
    expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const panel = (await aside.boundingBox())!;
    const frame = (await aside.getByTestId('attachment-video').last().boundingBox())!;
    expect(frame.x + frame.width).toBeLessThanOrEqual(panel.x + panel.width);
    expect(Math.abs(frame.width / frame.height - 16 / 9)).toBeLessThan(0.05);

    const imageName = `in-call-${Date.now()}.png`;
    await attach(alice, pngFile(imageName));
    await alice.getByLabel('Message General Voice').press('Enter');
    await aside.getByRole('button', { name: `Open image ${imageName}` }).click();
    await expect(bob.getByTestId('image-viewer')).toBeVisible();
    await bob.keyboard.press('ControlOrMeta+Shift+KeyM');
    await bob.keyboard.press('Escape');
    await expect(bob.getByRole('button', { name: 'Unmute microphone' }).first()).toBeVisible();

    await Promise.all([a.context.close(), b.context.close()]);
  });

  test('uploading: real progress, on with the chat meanwhile, and leaving the channel does not stop it', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const composer = alice.getByLabel('Message #general');
    const session = await alice.context().newCDPSession(alice);
    await session.send('Network.enable');
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: 256 * 1024,
    });
    const name = `slow-${Date.now()}.webm`;
    const padded = Buffer.concat([REAL_VIDEOS.webm.bytes, Buffer.alloc(2_000_000)]);
    await attach(alice, { name, mimeType: 'video/webm', buffer: padded });
    await composer.fill('The slow one');
    await composer.press('Enter');

    const pending = alice.getByTestId('pending-message');
    await expect(pending).toContainText('Uploading…');
    const bar = pending.getByRole('progressbar');
    await expect
      .poll(async () => Number(await bar.getAttribute('aria-valuenow')), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(Number(await bar.getAttribute('aria-valuenow'))).toBeLessThan(100);
    await expect(pending).toContainText(/Uploading… \d+%/);

    const quick = `Meanwhile ${Date.now()}`;
    await sendMessage(alice, 'general', quick);
    await expect(bob.getByText(quick)).toBeVisible();
    await expect(pending).toBeVisible();

    await alice.getByRole('button', { name: /^gaming\b/ }).click();
    await expect(alice.getByLabel('Message #gaming')).toBeVisible();
    await alice.getByRole('button', { name: /^general\b/ }).click();

    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await expect(alice.getByTestId('pending-message')).toHaveCount(0, { timeout: 30_000 });
    await expect(bob.locator(`video[aria-label="${name}"]`)).toBeVisible();
    await expect(bob.getByText('The slow one').last()).toBeVisible();
    await close();
  });
});

test.describe('choosing a file', () => {
  test('a pasted image joins the tray, and a paste with no file stays a text paste', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const composer = alice.getByLabel('Message #general');
    const name = `pasted-${Date.now()}.png`;
    const bytes = png(320, 200).toString('base64');

    const paste = (data: { file?: string; text?: string; html?: string }) =>
      composer.evaluate(
        (el, { data, bytes }) => {
          const transfer = new DataTransfer();
          if (data.file) {
            const raw = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
            transfer.items.add(new File([raw], data.file, { type: 'image/png' }));
          }
          if (data.text) transfer.setData('text/plain', data.text);
          if (data.html) transfer.setData('text/html', data.html);
          const event = new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(event);
          return event.defaultPrevented;
        },
        { data, bytes },
      );

    expect(await paste({ text: 'just words' })).toBe(false);
    await expect(alice.getByTestId('tray-file')).toHaveCount(0);

    expect(await paste({ file: 'sheet.png', text: 'a cell', html: '<td>a cell</td>' })).toBe(false);
    await expect(alice.getByTestId('tray-file')).toHaveCount(0);

    expect(await paste({ file: name })).toBe(true);
    await expect(alice.getByTestId('tray-file')).toContainText(name);
    await composer.press('Enter');
    await expect(rowWithImage(bob, name)).toBeVisible();
    await close();
  });

  test('dropped files: an overlay says where they go, and only files bring it up', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const name = `dropped-${Date.now()}.png`;
    const bytes = png(320, 200).toString('base64');
    const list = alice.getByRole('log');
    const overlay = alice.getByTestId('drop-overlay');
    const withFile = await alice.evaluateHandle(
      ({ name, bytes }) => {
        const transfer = new DataTransfer();
        const raw = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
        transfer.items.add(new File([raw], name, { type: 'image/png' }));
        return transfer;
      },
      { name, bytes },
    );
    const withText = await alice.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'https://example.com/a-link');
      return transfer;
    });

    await list.dispatchEvent('dragenter', { dataTransfer: withText });
    await list.dispatchEvent('dragover', { dataTransfer: withText });
    await alice.waitForTimeout(100);
    expect(await overlay.count()).toBe(0);
    await list.dispatchEvent('drop', { dataTransfer: withText });
    await expect(alice.getByTestId('tray-file')).toHaveCount(0);

    await alice.evaluate(() => window.dispatchEvent(new DragEvent('dragstart')));
    await list.dispatchEvent('dragenter', { dataTransfer: withFile });
    await alice.waitForTimeout(100);
    expect(await overlay.count()).toBe(0);
    await alice.evaluate(() => window.dispatchEvent(new DragEvent('dragend')));

    const beside = await alice
      .getByRole('navigation', { name: 'Channels' })
      .evaluate((el, transfer) => {
        const over = new DragEvent('dragover', {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(over);
        const drop = new DragEvent('drop', {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(drop);
        return [over.defaultPrevented, drop.defaultPrevented];
      }, withFile);
    expect(beside).toEqual([true, true]);
    await alice.waitForTimeout(100);
    expect(await alice.getByTestId('tray-file').count()).toBe(0);

    await list.dispatchEvent('dragenter', { dataTransfer: withFile });
    await expect(overlay).toContainText('Drop to add to #general');
    await overlay.dispatchEvent('dragleave', { dataTransfer: withFile });
    await expect(overlay).toHaveCount(0);

    await list.dispatchEvent('dragenter', { dataTransfer: withFile });
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveCount(0, { timeout: 4000 });

    await list.dispatchEvent('dragenter', { dataTransfer: withFile });
    await overlay.dispatchEvent('dragover', { dataTransfer: withFile });
    await overlay.dispatchEvent('drop', { dataTransfer: withFile });
    await expect(overlay).toHaveCount(0);
    await expect(alice.getByTestId('tray-file')).toContainText(name);
    await expect(alice.getByTestId('pending-message')).toHaveCount(0);

    await alice.getByRole('button', { name: 'Send message' }).click();
    await expect(rowWithImage(bob, name)).toBeVisible();
    await close();
  });

  test('anything too large, of the wrong type or over the limit stays out, with nothing sent', async ({
    browser,
  }) => {
    const { alice, close } = await pair(browser);
    const uploads: string[] = [];
    alice.on('request', (r) => {
      if (r.method() === 'POST' && /\/attachments/.test(r.url())) uploads.push(r.url());
    });
    const tray = alice.getByTestId('tray-file');
    const notice = alice.getByRole('alert');

    await attach(alice, {
      name: 'huge.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await expect(notice).toContainText('"huge.png" is too large. An image can be up to 10 MB.');
    await expect(tray).toHaveCount(0);

    await attach(alice, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    await expect(notice).toContainText('"notes.txt" is not a PNG, JPEG, GIF or WebP image');
    await expect(tray).toHaveCount(0);

    await attach(alice, {
      name: 'iphone.heic',
      mimeType: 'image/heic',
      buffer: Buffer.from('heic'),
    });
    await expect(notice).toContainText('"iphone.heic" is not a PNG');
    await attach(alice, { name: 'blank.png', mimeType: 'image/png', buffer: Buffer.alloc(0) });
    await expect(notice).toContainText('"blank.png" is empty.');
    await expect(tray).toHaveCount(0);

    const eleven = Array.from({ length: 11 }, (_, i) => pngFile(`${i}.png`, 40, 40, i));
    await attach(alice, eleven);
    await expect(tray).toHaveCount(10);
    await expect(notice).toContainText('A message can have at most 10 files, so one was left out.');

    await alice.getByRole('button', { name: 'Remove 0.png' }).click();
    await expect(tray).toHaveCount(9);
    await attach(alice, pngFile('tenth.png', 40, 40));
    await expect(tray).toHaveCount(10);
    await expect(notice).toHaveCount(0);

    await expect(alice.getByTestId('pending-message')).toHaveCount(0);
    expect(uploads).toEqual([]);
    await close();
  });

  test('the tray belongs to its channel, survives a switch, and lets go of its previews', async ({
    browser,
  }) => {
    const a = await user(browser, USERS.alice);
    const alice = a.page;
    await a.context.addInitScript(() => {
      const revoked: string[] = [];
      (window as unknown as { revoked: string[] }).revoked = revoked;
      const native = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => {
        revoked.push(url);
        native(url);
      };
    });
    await alice.reload();
    await expect(alice.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await openTextChannel(alice, 'general');
    await attach(alice, [pngFile('keep.png'), pngFile('drop.png'), webm('clip.webm')]);
    const tray = alice.getByTestId('tray-file');
    await expect(tray).toHaveCount(3);

    const keep = tray.filter({ hasText: 'keep.png' });
    await expect
      .poll(() => keep.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBe(640);
    await expect(keep).toContainText(/\d+(\.\d+)? (KB|MB)/);
    await expect
      .poll(() =>
        tray
          .filter({ hasText: 'clip.webm' })
          .locator('video')
          .evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBe(32);

    await alice.getByRole('button', { name: /^gaming\b/ }).click();
    await expect(alice.getByLabel('Message #gaming')).toBeVisible();
    await expect(tray).toHaveCount(0);
    await alice.getByRole('button', { name: /^general\b/ }).click();
    await expect(tray).toHaveCount(3);

    const src = await tray.filter({ hasText: 'drop.png' }).locator('img').getAttribute('src');
    await alice.getByRole('button', { name: 'Remove drop.png' }).click();
    await expect(tray).toHaveCount(2);
    await expect(alice.getByLabel('Message #general')).toBeFocused();
    expect(
      await alice.evaluate(() => (window as unknown as { revoked: string[] }).revoked),
    ).toContain(src);
    await a.context.close();
  });
});

test.describe('when an upload goes wrong', () => {
  test('a failure says why, Retry uploads only what is missing, and the message arrives once', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const stamp = Date.now();
    const first = `first-${stamp}.png`;
    const second = `second-${stamp}.png`;
    let attempts = 0;
    await alice.route(UPLOADS, (route) => {
      attempts++;
      return attempts === 2 ? route.abort('connectionreset') : route.continue();
    });

    await attach(alice, [pngFile(first), pngFile(second)]);
    await alice.getByLabel('Message #general').fill(`Retried ${stamp}`);
    await alice.getByLabel('Message #general').press('Enter');

    const pending = alice.getByTestId('pending-message');
    await expect(pending).toContainText(`Not sent: "${second}": The connection was lost`);
    await expect(pending).toContainText(`Retried ${stamp}`);
    await alice.waitForTimeout(1500);
    expect(attempts).toBe(2);

    await pending.getByRole('button', { name: 'Retry' }).click();
    await expect(pending).toHaveCount(0);
    expect(attempts).toBe(3);

    const row = rowWithImage(bob, first);
    await expect(row.locator('img')).toHaveCount(2);
    await expect(bob.getByText(`Retried ${stamp}`)).toHaveCount(1);
    await close();
  });

  test('a refusal shows the server words, and Discard takes back what was uploaded', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const stamp = Date.now();
    const kept = `kept-${stamp}.png`;
    let attempts = 0;
    const words = 'The server is nearly out of disk space.';
    await alice.route(UPLOADS, (route) => {
      attempts++;
      if (attempts === 1) return route.continue();
      return route.fulfill({
        status: 507,
        json: { error: { code: 'uploads_unavailable', message: words } },
      });
    });
    const uploaded = alice.waitForResponse(
      (r) => r.url().includes('/attachments?') && r.status() === 201,
    );
    await attach(alice, [pngFile(kept), pngFile(`refused-${stamp}.png`)]);
    await alice.getByRole('button', { name: 'Send message' }).click();
    const { attachment } = (await (await uploaded).json()) as { attachment: { id: string } };

    const pending = alice.getByTestId('pending-message');
    await expect(pending).toContainText(words);
    expect((await alice.request.get(`/api/attachments/${attachment.id}`)).status()).toBe(200);

    await pending.getByRole('button', { name: 'Discard' }).click();
    await expect(pending).toHaveCount(0);
    await expect
      .poll(async () => (await alice.request.get(`/api/attachments/${attachment.id}`)).status())
      .toBe(404);
    await expect(rowWithImage(bob, kept)).toHaveCount(0);
    await close();
  });

  test('Cancel stops an upload in flight and leaves nothing behind', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const name = `canceled-${Date.now()}.png`;
    await alice.route(UPLOADS, () => undefined);
    await attach(alice, pngFile(name));
    await alice.getByRole('button', { name: 'Send message' }).click();

    const pending = alice.getByTestId('pending-message');
    await expect(pending).toContainText('Uploading…');
    await pending.getByRole('button', { name: 'Cancel' }).click();
    await expect(pending).toHaveCount(0);
    await alice.waitForTimeout(300);
    await expect(rowWithImage(bob, name)).toHaveCount(0);
    await close();
  });

  test('Cancel puts the words back in the message box, ready to send without the file', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const words = `Words to keep ${Date.now()}`;
    await alice.route(UPLOADS, () => undefined);
    await attach(alice, pngFile(`canceled-${Date.now()}.png`));
    const composer = alice.getByLabel('Message #general');
    await composer.fill(words);
    await composer.press('Enter');
    await expect(composer).toHaveValue('');

    const pending = alice.getByTestId('pending-message');
    await expect(pending).toContainText('Uploading…');
    await pending.getByRole('button', { name: 'Cancel' }).click();
    await expect(pending).toHaveCount(0);
    await expect(composer).toHaveValue(words);
    await expect(composer).toBeFocused();

    await composer.press('Enter');
    await expect(bob.getByText(words)).toBeVisible();
    await expect(composer).toHaveValue('');
    await close();
  });

  test('a reload mid-upload fails clearly, keeps the words, and offers no Retry that could not work', async ({
    browser,
  }) => {
    const { alice, close } = await pair(browser);
    const stamp = Date.now();
    const done = `done-${stamp}.png`;
    const lost = `lost-${stamp}.png`;
    let attempts = 0;
    await alice.route(UPLOADS, (route) => {
      attempts++;
      return attempts === 1 ? route.continue() : undefined;
    });
    const uploaded = alice.waitForResponse(
      (r) => r.url().includes('/attachments?') && r.status() === 201,
    );
    await attach(alice, [pngFile(done), pngFile(lost)]);
    const composer = alice.getByLabel('Message #general');
    await composer.fill(`Words worth keeping ${stamp}`);
    await composer.press('Enter');
    const { attachment } = (await (await uploaded).json()) as { attachment: { id: string } };
    const pending = alice.getByTestId('pending-message');
    await expect(pending).toContainText('Uploading…');
    await expect(pending.getByRole('progressbar')).toHaveCount(1);

    await alice.reload();
    await expect(alice.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await expect(pending).toContainText(`Words worth keeping ${stamp}`);
    await expect(pending).toContainText('Not sent: The page closed before its files finished');
    await expect(pending.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(pending.getByRole('button', { name: 'Send what got through' })).toBeVisible();
    await expectDrawn(alice, done);
    await expect(pending.getByTestId('attachment-card')).toContainText(lost);

    await pending.getByRole('button', { name: 'Discard' }).click();
    await expect(pending).toHaveCount(0);
    await expect(composer).toHaveValue(`Words worth keeping ${stamp}`);
    await expect
      .poll(async () => (await alice.request.get(`/api/attachments/${attachment.id}`)).status())
      .toBe(404);
    await alice.reload();
    await expect(alice.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await expect(pending).toHaveCount(0);
    await close();
  });

  test('after a reload mid-upload, Send what got through delivers the words and that file', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const stamp = Date.now();
    const done = `done-${stamp}.png`;
    const lost = `lost-${stamp}.png`;
    const words = `Sent without the rest ${stamp}`;
    let attempts = 0;
    await alice.route(UPLOADS, (route) => {
      attempts++;
      return attempts === 1 ? route.continue() : undefined;
    });
    const uploaded = alice.waitForResponse(
      (r) => r.url().includes('/attachments?') && r.status() === 201,
    );
    await attach(alice, [pngFile(done), pngFile(lost)]);
    const composer = alice.getByLabel('Message #general');
    await composer.fill(words);
    await composer.press('Enter');
    await uploaded;
    const pending = alice.getByTestId('pending-message');
    await expect(pending.getByRole('progressbar')).toHaveCount(1);

    await alice.reload();
    await expect(alice.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await pending.getByRole('button', { name: 'Send what got through' }).click();
    await expect(pending).toHaveCount(0);
    await expect(composer).toHaveValue('');

    const row = rowWithImage(bob, done);
    await expect(row).toBeVisible();
    await expect(row).toContainText(words);
    await expect(rowWithImage(bob, lost)).toHaveCount(0);
    expect(attempts).toBe(2);
    await close();
  });

  test('files already uploaded survive a reload, and Retry only has to send the message', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const name = `waiting-${Date.now()}.png`;
    let uploads = 0;
    await alice.route(UPLOADS, (route) => {
      uploads++;
      return route.continue();
    });
    await alice.route('**/api/channels/*/messages', (route) =>
      route.request().method() === 'POST' ? undefined : route.continue(),
    );
    await attach(alice, pngFile(name));
    await alice.getByRole('button', { name: 'Send message' }).click();
    const pending = alice.getByTestId('pending-message');
    await expect(pending).toContainText('Sending…');

    await alice.unroute('**/api/channels/*/messages');
    await alice.reload();
    await expect(alice.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await expect(pending).toContainText('Not sent');
    await pending.getByRole('button', { name: 'Retry' }).click();
    await expect(pending).toHaveCount(0);
    await expect(rowWithImage(bob, name)).toBeVisible();
    expect(uploads).toBe(1);
    await close();
  });
});

test.describe('in the message', () => {
  test('deleting a message removes it and its file', async ({ browser }) => {
    const { alice, bob, close } = await pair(browser);
    const name = `doomed-${Date.now()}.png`;
    await attach(alice, pngFile(name));
    await alice.getByRole('button', { name: 'Send message' }).click();
    await expectDrawn(bob, name);
    const src = (await bob.locator(`img[alt="${name}"]`).getAttribute('src'))!;
    expect((await bob.request.get(src)).status()).toBe(200);

    const row = rowWithImage(alice, name);
    await row.hover();
    await row.getByRole('button', { name: 'Delete message' }).click();
    await answerDelete(alice);
    await expect(rowWithImage(bob, name)).toHaveCount(0);
    await expect(rowWithImage(alice, name)).toHaveCount(0);
    await expect.poll(async () => (await bob.request.get(src)).status()).toBe(404);
    await close();
  });

  test('a message with an image can be edited down to no text, and one without cannot', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const name = `caption-${Date.now()}.png`;
    const caption = `A caption ${Date.now()}`;
    await attach(alice, pngFile(name));
    await alice.getByLabel('Message #general').fill(caption);
    await alice.getByLabel('Message #general').press('Enter');
    const row = rowWithImage(alice, name);
    await expect(row).toContainText(caption);
    await expect(rowWithImage(bob, name)).toContainText(caption);

    await row.hover();
    await row.getByRole('button', { name: 'Edit message' }).click();
    const edit = row.getByLabel('Edit message');
    await expect(edit).toBeFocused();
    await expect(row.locator(`img[alt="${name}"]`)).toBeVisible();
    await edit.fill('');
    await edit.press('Enter');

    const bobRow = rowWithImage(bob, name);
    await expect(bobRow.getByTestId('message-text')).toHaveCount(0);
    await expect(bobRow.getByText('(edited)')).toBeVisible();
    await expectDrawn(bob, name);
    await expect(row.getByTestId('message-text')).toHaveCount(0);

    const plain = `Only words ${Date.now()}`;
    await sendMessage(alice, 'general', plain);
    const textRow = alice.getByTestId('message').filter({ hasText: plain });
    await expect(textRow).toBeVisible();
    let edits = 0;
    alice.on('request', (r) => {
      if (r.method() === 'PATCH') edits++;
    });
    await textRow.hover();
    await textRow.getByRole('button', { name: 'Edit message' }).click();
    const box = alice.getByRole('textbox', { name: 'Edit message' });
    await box.fill('   ');
    await box.press('Enter');
    await expect(box).toHaveCount(0);
    await expect(textRow).toContainText(plain);
    expect(edits).toBe(0);
    await close();
  });

  test('room is reserved before a file arrives, so nothing moves and the chat stays at the bottom', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    let release!: () => void;
    const hold = () => {
      const held = new Promise<void>((resolve) => (release = resolve));
      return bob.route(FILES, async (route) => {
        await held;
        await route.continue();
      });
    };
    const stamp = Date.now();

    for (const [label, files, shape] of [
      ['landscape', [pngFile(`wide-${stamp}.png`, 1600, 900)], { w: 420, h: 236 }],
      ['portrait', [pngFile(`tall-${stamp}.png`, 900, 1600)], { w: 180, h: 320 }],
      ['smaller than the box', [pngFile(`tiny-${stamp}.png`, 120, 80)], { w: 120, h: 80 }],
      [
        'grid',
        [pngFile(`g1-${stamp}.png`), pngFile(`g2-${stamp}.png`), pngFile(`g3-${stamp}.png`)],
        null,
      ],
    ] as const) {
      await hold();
      await attach(alice, [...files]);
      await alice.getByRole('button', { name: 'Send message' }).click();
      const name = files[0]!.name;
      const row = rowWithImage(bob, name);
      await expect(row, label).toBeVisible();
      await expectAtBottom(bob);
      expect(
        await bob.locator(`img[alt="${name}"]`).evaluate((i: HTMLImageElement) => i.naturalWidth),
        label,
      ).toBe(0);
      const before = (await row.boundingBox())!.height;
      if (shape) {
        const box = (await row.getByTestId('attachment-image').boundingBox())!;
        expect(Math.round(box.width), label).toBe(shape.w);
        expect(Math.round(box.height), label).toBe(shape.h);
      }

      release();
      await expectDrawn(bob, name);
      await expect
        .poll(() => row.boundingBox().then((b) => b!.height), label)
        .toBeCloseTo(before, 1);
      await expectAtBottom(bob);
      await bob.unroute(FILES);
    }
    await close();
  });

  test('a video with no measured size keeps its box from before its metadata to after it', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const name = `unmeasured-${Date.now()}.webm`;
    await alice.route(UPLOADS, (route) => {
      const url = new URL(route.request().url());
      url.searchParams.delete('width');
      url.searchParams.delete('height');
      return route.continue({ url: url.toString() });
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await bob.route(FILES, async (route) => {
      await held;
      await route.continue();
    });
    await attach(alice, webm(name));
    await alice.getByRole('button', { name: 'Send message' }).click();
    const frame = bob.getByTestId('attachment-video').last();
    await expect(frame.locator(`video[aria-label="${name}"]`)).toBeVisible();
    const before = (await frame.boundingBox())!;
    expect(Math.round(before.width)).toBe(420);
    release();
    await expect
      .poll(() => frame.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBe(32);
    expect((await frame.boundingBox())!.height).toBeCloseTo(before.height, 1);
    await expectAtBottom(bob);
    await close();
  });

  test('a photo the browser turns by its EXIF orientation takes the shape it is drawn in', async ({
    browser,
  }) => {
    const { alice, close } = await pair(browser);
    const short = await user(browser, USERS.bob, { viewport: { width: 1000, height: 340 } });
    const bob = short.page;
    await openTextChannel(bob, 'general');
    const name = `rotated-${Date.now()}.jpg`;
    const jpeg = await alice.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 300;
      const paint = canvas.getContext('2d')!;
      paint.fillStyle = '#556677';
      paint.fillRect(0, 0, 600, 300);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/jpeg'),
      );
      const body = new Uint8Array(await blob.arrayBuffer());
      const exif = [
        0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00,
        0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ];
      return [...body.slice(0, 2), ...exif, ...body.slice(2)];
    });
    await attach(alice, { name, mimeType: 'image/jpeg', buffer: Buffer.from(jpeg) });
    await alice.getByRole('button', { name: 'Send message' }).click();
    const row = rowWithImage(bob, name);
    await expectDrawn(bob, name);
    await expect
      .poll(async () => {
        const box = (await row.getByTestId('attachment-image').boundingBox())!;
        return Math.round(box.width / box.height);
      })
      .toBe(1);
    const box = (await row.getByTestId('attachment-image').boundingBox())!;
    expect(box.height).toBeGreaterThan(box.width);
    expect(await bob.getByRole('log').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
      true,
    );
    await expectAtBottom(bob);
    await short.context.close();
    await close();
  });

  test('a video this browser cannot play becomes a card with a Download link', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const name = `undecodable-${Date.now()}.mp4`;
    const buffer = Buffer.concat([buildFtyp('isom'), Buffer.alloc(4096, 0x5a)]);
    await attach(alice, { name, mimeType: 'video/mp4', buffer });
    await alice.getByRole('button', { name: 'Send message' }).click();

    const card = bob.getByTestId('attachment-card').filter({ hasText: name });
    await expect(card).toContainText('This browser cannot play it.');
    await expect(card).toContainText('4 KB');
    const download = card.getByRole('link', { name: 'Download' });
    await expect(download).toHaveAttribute('download', name);
    expect((await bob.request.get((await download.getAttribute('href'))!)).status()).toBe(200);
    await close();
  });

  test('a file that is gone from the server becomes a quiet card saying so', async ({
    browser,
  }) => {
    const { alice, bob, close } = await pair(browser);
    const stamp = Date.now();
    const image = `gone-${stamp}.png`;
    const inGrid = `gone-grid-${stamp}.png`;
    const video = `gone-${stamp}.webm`;
    await attach(alice, pngFile(image));
    await alice.getByRole('button', { name: 'Send message' }).click();
    await expect(rowWithImage(alice, image)).toBeVisible();
    await attach(alice, [pngFile(inGrid), pngFile(`gone-grid-2-${stamp}.png`)]);
    await alice.getByRole('button', { name: 'Send message' }).click();
    await expect(rowWithImage(alice, inGrid)).toBeVisible();
    await attach(alice, webm(video));
    await alice.getByRole('button', { name: 'Send message' }).click();
    await expect(alice.locator(`video[aria-label="${video}"]`)).toBeVisible();

    await bob.route(FILES, (route) => route.fulfill({ status: 404, body: '' }));
    await bob.reload();
    await expect(bob.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await expect(bob.getByTestId('attachment-card').filter({ hasText: image })).toContainText(
      'This image could not be loaded.',
    );
    const videoCard = bob.getByTestId('attachment-card').filter({ hasText: video });
    await expect(videoCard).toContainText('This video could not be loaded.');
    await expect(videoCard.getByRole('link')).toHaveCount(0);
    await expect(bob.getByText(`${inGrid}: This image could not be loaded.`)).toHaveCount(1);
    await expectAtBottom(bob);
    await close();
  });
});

test.describe('on a phone', () => {
  async function noSidewaysScroll(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      PHONE.viewport.width,
    );
    expect(await page.getByRole('log').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  }

  async function atLeast40(page: Page, name: string | RegExp) {
    const button = page.getByRole('button', { name }).first();
    const edge = async () => {
      const box = (await button.boundingBox())!;
      return Math.min(box.width, box.height);
    };
    await expect.poll(edge, String(name)).toBeGreaterThanOrEqual(40);
  }

  test('the tray and the send button fit and work, and the viewer closes with a tap', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    await expect(page.getByLabel('Message #general')).toBeVisible();
    const long = `a-very-long-name-straight-from-the-camera-roll-${Date.now()}.png`;
    const others = Array.from({ length: 9 }, (_, i) => pngFile(`more-${i}.png`, 80, 80, i));
    await attach(page, [pngFile(long, 1200, 1600), ...others]);
    const tray = page.getByTestId('attachment-tray');
    await expect(page.getByTestId('tray-file')).toHaveCount(10);

    await noSidewaysScroll(page);
    const rowBox = (await tray.boundingBox())!;
    expect(rowBox.x).toBeGreaterThanOrEqual(0);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(PHONE.viewport.width);
    expect(await tray.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toBeInViewport();
    await atLeast40(page, 'Send message');
    await atLeast40(page, 'Attach files');
    await atLeast40(page, /^Remove /);
    await tray.getByRole('button', { name: `Remove ${long}` }).tap();
    await expect(page.getByTestId('tray-file')).toHaveCount(9);
    await attach(page, pngFile(long, 1200, 1600));

    await send.tap();
    await expect(page.getByTestId('pending-message')).toHaveCount(0, { timeout: 30_000 });
    await noSidewaysScroll(page);

    const row = rowWithImage(page, long);
    await expect(row.locator('img')).toHaveCount(10);
    await row.getByRole('button', { name: `Open image ${long}` }).tap();
    const viewer = page.getByTestId('image-viewer');
    await expect(viewer).toBeVisible();
    await atLeast40(page, 'Close');
    await atLeast40(page, 'Next image');
    await atLeast40(page, 'Previous image');
    await expect(viewer.getByRole('link', { name: 'Download' })).toBeVisible();
    await expect(viewer).toContainText('10 of 10');
    await viewer.getByRole('button', { name: 'Next image' }).tap();
    await expect(viewer).toContainText('1 of 10');
    await viewer.locator('img').tap();
    await expect(viewer).toHaveCount(0);
    await context.close();
  });

  test('the voice chat cover takes files just the same, with Retry and Discard in reach', async ({
    browser,
  }) => {
    const { context, page } = await user(browser, USERS.bob, PHONE);
    await page.getByTestId('nav-toggle').tap();
    await page
      .getByRole('button', { name: /^Gaming Voice/ })
      .first()
      .tap();
    await page.getByRole('button', { name: 'Show chat' }).tap();
    const composer = page.getByLabel('Message Gaming Voice');
    await expect(composer).toBeVisible();

    await page.route(UPLOADS, (route) => route.abort('connectionreset'));
    const long = `IMG_${'0123456789'.repeat(12)}.png`;
    await attach(page, [pngFile(long, 1600, 900), webm('cover.webm')]);
    await expect(page.getByTestId('tray-file')).toHaveCount(2);
    await noSidewaysScroll(page);
    await page.getByRole('button', { name: 'Send message' }).tap();
    const pending = page.getByTestId('pending-message');
    await expect(pending).toContainText('Not sent');
    await noSidewaysScroll(page);
    const failure = (await pending.getByText('Not sent').boundingBox())!;
    expect(failure.x + failure.width).toBeLessThanOrEqual(PHONE.viewport.width);
    await atLeast40(page, 'Retry');
    await atLeast40(page, 'Discard');

    await page.unroute(UPLOADS);
    await pending.getByRole('button', { name: 'Retry' }).tap();
    await expect(pending).toHaveCount(0, { timeout: 30_000 });
    await expect(rowWithImage(page, long)).toBeVisible();
    await expect(page.locator('video[aria-label="cover.webm"]')).toBeVisible();
    await noSidewaysScroll(page);
    await context.close();
  });
});
