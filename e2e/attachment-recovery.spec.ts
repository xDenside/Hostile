import { writeFileSync } from 'node:fs';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
} from '@playwright/test';
import { buildBlankPng } from '../apps/server/test/support/images';
import { pngFile, REAL_VIDEOS, user } from './attachment-fixtures';
import { channelButton, sendMessage, signIn, USERS } from './helpers';

const FILES = '**/api/attachments/*';
const PHONE = { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true };

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const webm = (name: string, padding = 0) => ({
  name,
  mimeType: 'video/webm',
  buffer: padding
    ? Buffer.concat([REAL_VIDEOS.webm.bytes, Buffer.alloc(padding)])
    : REAL_VIDEOS.webm.bytes,
});

const attach = (page: Page, files: Parameters<Page['setInputFiles']>[1]) =>
  page.getByTestId('attach-input').setInputFiles(files);

const composerOf = (page: Page, channel: string) => page.getByLabel(`Message #${channel}`);

async function csrf(page: Page): Promise<string> {
  const res = await page.request.get('/api/auth/session');
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

async function newChannel(owner: Page) {
  const res = await owner.request.post('/api/admin/channels', {
    data: { name: `t-${stamp()}`, type: 'text' },
    headers: { 'X-CSRF-Token': await csrf(owner) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { channel: { id: string; name: string } }).channel;
}

async function open(page: Page, name: string) {
  await channelButton(page, name).click();
  await expect(composerOf(page, name)).toBeVisible();
  await expect(page.getByRole('log')).toBeVisible();
}

async function pair(browser: Browser, bobOptions: Parameters<typeof user>[2] = {}) {
  const a = await user(browser, USERS.alice);
  const b = await user(browser, USERS.bob, bobOptions);
  const channel = await newChannel(a.page);
  await open(a.page, channel.name);
  await open(b.page, channel.name);
  return {
    alice: a.page,
    bob: b.page,
    bobContext: b.context,
    channel,
    close: () => Promise.all([a.context.close(), b.context.close()]),
  };
}

async function postFiles(alice: Page, channel: string) {
  const id = stamp();
  const names = {
    single: `single-${id}.png`,
    gridA: `grid-a-${id}.png`,
    gridB: `grid-b-${id}.png`,
    video: `clip-${id}.webm`,
  };
  await attach(alice, pngFile(names.single, 640, 360));
  await composerOf(alice, channel).press('Enter');
  await attach(alice, [pngFile(names.gridA, 300, 300), pngFile(names.gridB, 300, 300, 2)]);
  await composerOf(alice, channel).press('Enter');
  await attach(alice, webm(names.video));
  await composerOf(alice, channel).press('Enter');
  await expect(alice.getByTestId('pending-message')).toHaveCount(0, { timeout: 20_000 });
  return names;
}

async function expectDrawn(page: Page, name: string, timeout?: number) {
  await expect
    .poll(
      () =>
        page
          .locator(`img[alt="${name}"]`)
          .first()
          .evaluate((i: HTMLImageElement) => i.naturalWidth)
          .catch(() => 0),
      { timeout },
    )
    .toBeGreaterThan(0);
}

async function expectVideoLoaded(page: Page, name: string) {
  await expect
    .poll(() =>
      page
        .locator(`video[aria-label="${name}"]`)
        .evaluate((v: HTMLVideoElement) => v.readyState)
        .catch(() => 0),
    )
    .toBeGreaterThanOrEqual(1);
}

const scrollHeight = (page: Page) => page.getByRole('log').evaluate((el) => el.scrollHeight);

const dropAllFiles = (page: Page) => page.route(FILES, (route) => route.abort('connectionfailed'));

test.describe('a file that cannot be reached for now', () => {
  test('a real network loss: it says try again, blames nobody, and comes back by itself', async ({
    browser,
  }) => {
    const { alice, bob, bobContext, channel, close } = await pair(browser);
    await channelButton(bob, 'gaming').click();
    await expect(composerOf(bob, 'gaming')).toBeVisible();
    const names = await postFiles(alice, channel.name);

    await bobContext.setOffline(true);
    await channelButton(bob, channel.name).click();
    await expect(composerOf(bob, channel.name)).toBeVisible();

    await expect(bob.getByTestId('media-retry')).toHaveCount(4, { timeout: 15_000 });
    await expect(bob.getByTestId('attachment-card')).toHaveCount(0);
    await expect(bob.getByText('This browser cannot play it')).toHaveCount(0);
    await expect(bob.getByText('could not be loaded')).toHaveCount(0);
    const height = await scrollHeight(bob);

    await bobContext.setOffline(false);
    await expect(bob.getByTestId('media-retry')).toHaveCount(0, { timeout: 25_000 });
    await expectDrawn(bob, names.single);
    await expectDrawn(bob, names.gridA);
    await expectVideoLoaded(bob, names.video);
    await expect(bob.getByTestId('attachment-card')).toHaveCount(0);
    expect(await scrollHeight(bob)).toBe(height);
    await close();
  });

  test('a tap brings one back at once, and the rest wait their turn', async ({ browser }) => {
    const { alice, bob, channel, close } = await pair(browser);
    const names = await postFiles(alice, channel.name);
    await dropAllFiles(bob);
    await bob.reload();
    await expect(composerOf(bob, channel.name)).toBeVisible();
    await expect(bob.getByTestId('media-retry')).toHaveCount(4, { timeout: 15_000 });

    const single = bob.getByRole('button', { name: `Could not load ${names.single}. Try again` });
    await bob.unroute(FILES);
    await single.click();
    await expectDrawn(bob, names.single, 4000);
    await expect(single).toHaveCount(0);
    await expect(bob.getByRole('button', { name: `Open image ${names.single}` })).toBeVisible();

    await bob.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(bob.getByTestId('media-retry')).toHaveCount(0);
    await expectVideoLoaded(bob, names.video);
    await close();
  });

  test('a brief failure too short to notice is tried again by a timer alone', async ({
    browser,
  }) => {
    const { alice, bob, channel, close } = await pair(browser);
    const names = await postFiles(alice, channel.name);
    await dropAllFiles(bob);
    await bob.reload();
    await expect(bob.getByTestId('media-retry')).toHaveCount(4, { timeout: 15_000 });
    await bob.unroute(FILES);
    await expect(bob.getByTestId('media-retry')).toHaveCount(0, { timeout: 25_000 });
    await expectDrawn(bob, names.gridB);
    await expectVideoLoaded(bob, names.video);
    await close();
  });

  test('a server answering 503 is the same thing, and a 404 is still final', async ({
    browser,
  }) => {
    const { alice, bob, channel, close } = await pair(browser);
    const names = await postFiles(alice, channel.name);
    await bob.route(FILES, (route) => route.fulfill({ status: 503, body: '' }));
    await bob.reload();
    await expect(bob.getByTestId('media-retry')).toHaveCount(4, { timeout: 15_000 });
    await expect(bob.getByTestId('attachment-card')).toHaveCount(0);

    await bob.unroute(FILES);
    await bob.route(FILES, (route) => route.fulfill({ status: 404, body: '' }));
    await bob.evaluate(() => window.dispatchEvent(new Event('online')));
    const card = bob.getByTestId('attachment-card');
    await expect(card.filter({ hasText: names.single })).toContainText(
      'This image could not be loaded.',
    );
    await expect(card.filter({ hasText: names.video })).toContainText(
      'This video could not be loaded.',
    );
    await expect(bob.getByTestId('media-retry')).toHaveCount(0);
    await close();
  });

  test('a server that has only just come back: the load failed but the question got through', async ({
    browser,
  }) => {
    const { alice, bob, channel, close } = await pair(browser);
    const names = await postFiles(alice, channel.name);
    const failedOnce = new Set<string>();
    await bob.route(FILES, (route) => {
      const request = route.request();
      if (request.method() === 'GET' && !failedOnce.has(request.url())) {
        failedOnce.add(request.url());
        return route.fulfill({ status: 502, body: '' });
      }
      return route.continue();
    });
    await bob.reload();
    await expectDrawn(bob, names.single);
    await expectDrawn(bob, names.gridA);
    await expectVideoLoaded(bob, names.video);
    await expect(bob.getByTestId('attachment-card')).toHaveCount(0);
    await expect(bob.getByTestId('media-retry')).toHaveCount(0);
    await close();
  });
});

test.describe('a channel full of videos', () => {
  const VIDEOS = 100;

  async function fillWithVideos(alice: Page, channelId: string, prefix: string) {
    const token = await csrf(alice);
    for (let m = 0; m < VIDEOS / 10; m++) {
      const ids = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const res = await alice.request.post(
            `/api/channels/${channelId}/attachments?name=${prefix}-${m}-${i}.webm&width=32&height=18`,
            {
              data: REAL_VIDEOS.webm.bytes,
              headers: { 'Content-Type': 'video/webm', 'X-CSRF-Token': token },
            },
          );
          expect(res.status(), await res.text()).toBe(201);
          return ((await res.json()) as { attachment: { id: string } }).attachment.id;
        }),
      );
      const res = await alice.request.post(`/api/channels/${channelId}/messages`, {
        data: { content: '', clientNonce: crypto.randomUUID(), attachmentIds: ids },
        headers: { 'X-CSRF-Token': token },
      });
      expect(res.status(), await res.text()).toBe(201);
    }
  }

  const watchVideos = (context: BrowserContext) =>
    context.addInitScript(() => {
      const state = { peak: 0, seen: new Set<HTMLVideoElement>() };
      (window as unknown as { videoWatch: typeof state }).videoWatch = state;
      const count = () => {
        const live = document.querySelectorAll('video');
        state.peak = Math.max(state.peak, live.length);
        live.forEach((v) => state.seen.add(v));
      };
      new MutationObserver(count).observe(document, { childList: true, subtree: true });
    });

  const peakVideos = (page: Page) =>
    page.evaluate(() => (window as unknown as { videoWatch: { peak: number } }).videoWatch.peak);

  async function scrollThrough(page: Page, direction: 'up' | 'down') {
    for (let i = 0; i < 400; i++) {
      const done = await page.getByRole('log').evaluate((el, direction) => {
        el.scrollTop += (direction === 'up' ? -1 : 1) * el.clientHeight;
        return direction === 'up'
          ? el.scrollTop <= 0
          : el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      }, direction);
      await page.waitForTimeout(60);
      if (done) return;
    }
    throw new Error('never reached the end of the list');
  }

  async function openOnEitherSize(page: Page, name: string, phone: boolean) {
    if (phone) await page.getByRole('button', { name: 'Open channel list' }).tap();
    await channelButton(page, name).click();
  }

  for (const [where, options, ceiling] of [
    ['on a phone', PHONE, 25],
    ['on a desktop', {}, 30],
  ] as const) {
    test(`${where}: only what is near the screen has a player, and every box keeps its place`, async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const a = await user(browser, USERS.alice);
      const channel = await newChannel(a.page);
      const prefix = `cap-${stamp()}`;
      await fillWithVideos(a.page, channel.id, prefix);
      await a.context.close();

      const context = await browser.newContext(options);
      await watchVideos(context);
      const page = await context.newPage();
      const complaints: string[] = [];
      page.on('console', (message: ConsoleMessage) => {
        if (/WebMediaPlayer|Player load failure/i.test(message.text()))
          complaints.push(message.text());
      });
      const mediaRequests = new Set<string>();
      page.on('request', (request: Request) => {
        if (request.url().includes('/api/attachments/') && request.resourceType() === 'media')
          mediaRequests.add(request.url());
      });
      await signIn(page, USERS.bob);

      await openOnEitherSize(page, channel.name, where === 'on a phone');
      const boxes = page.getByTestId('attachment-video');
      await expect(boxes).toHaveCount(VIDEOS);
      const last = page.locator(`video[aria-label="${prefix}-9-9.webm"]`);
      await expect(last).toBeVisible();
      await expectVideoLoaded(page, `${prefix}-9-9.webm`);

      const opened = await page.locator('video').count();
      expect(opened).toBeGreaterThan(0);
      expect(opened).toBeLessThanOrEqual(ceiling);
      expect(mediaRequests.size).toBeLessThanOrEqual(ceiling);
      const offScreen = await page.getByRole('log').evaluate((list) => {
        const top = list.getBoundingClientRect().top;
        return [...list.querySelectorAll('video')].filter(
          (v) => v.getBoundingClientRect().bottom < top,
        ).length;
      });
      expect(offScreen).toBeGreaterThan(0);
      const heightAtBottom = await scrollHeight(page);

      await scrollThrough(page, 'up');
      const first = `${prefix}-0-0.webm`;
      await expect(page.locator(`video[aria-label="${first}"]`)).toBeVisible();
      await expectVideoLoaded(page, first);
      await scrollThrough(page, 'down');
      await scrollThrough(page, 'up');

      expect(await peakVideos(page)).toBeLessThanOrEqual(ceiling);
      expect(await scrollHeight(page)).toBe(heightAtBottom);
      await expect(page.getByTestId('attachment-card')).toHaveCount(0);
      expect(complaints).toEqual([]);

      const released = await page.evaluate(() => {
        const { seen } = (window as unknown as { videoWatch: { seen: Set<HTMLVideoElement> } })
          .videoWatch;
        const gone = [...seen].filter((v) => !v.isConnected);
        return {
          gone: gone.length,
          stillHolding: gone.filter((v) => v.networkState !== 0 || v.getAttribute('src')).length,
        };
      });
      expect(released.gone).toBeGreaterThan(VIDEOS / 2);
      expect(released.stillHolding).toBe(0);
      await context.close();
    });
  }

  test('one being played stays while it plays, and a paused one comes back where it was', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const a = await user(browser, USERS.alice);
    const channel = await newChannel(a.page);
    const prefix = `play-${stamp()}`;
    await fillWithVideos(a.page, channel.id, prefix);
    await channelButton(a.page, channel.name).click();
    const name = `${prefix}-9-9.webm`;
    const video = a.page.locator(`video[aria-label="${name}"]`);
    await expect(video).toBeVisible();
    await expectVideoLoaded(a.page, name);

    await video.evaluate(async (v: HTMLVideoElement) => {
      v.muted = true;
      v.loop = true;
      await v.play();
    });
    await a.page.getByRole('log').evaluate((el) => (el.scrollTop = 0));
    await a.page.waitForTimeout(500);
    await expect(a.page.locator(`video[aria-label="${prefix}-0-0.webm"]`)).toBeVisible();
    expect(await video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);

    await video.evaluate((v: HTMLVideoElement) => {
      v.loop = false;
      v.pause();
      v.currentTime = 0.15;
    });
    await expect(video).toHaveCount(0);

    await a.page.getByRole('log').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(0.1);
    await a.context.close();
  });
});

test.describe('the line for uploading', () => {
  test('two at a time, the rest visibly waiting, with the chat itself still free', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { alice, bob, channel, close } = await pair(browser);
    const session = await alice.context().newCDPSession(alice);
    await session.send('Network.enable');
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: 150 * 1024,
    });

    const inFlight = new Set<Request>();
    const startedNames: string[] = [];
    let peak = 0;
    const isUpload = (r: Request) => r.method() === 'POST' && r.url().includes('/attachments');
    alice.on('request', (r) => {
      if (!isUpload(r)) return;
      inFlight.add(r);
      peak = Math.max(peak, inFlight.size);
      startedNames.push(new URL(r.url()).searchParams.get('name')!);
    });
    alice.on('response', (r) => inFlight.delete(r.request()));
    alice.on('requestfailed', (r) => inFlight.delete(r));

    const id = stamp();
    const names = Array.from({ length: 7 }, (_, i) => `line-${id}-${i}.webm`);
    for (const name of names) {
      await attach(alice, webm(name, 4_000_000));
      await expect(alice.getByTestId('tray-file')).toHaveCount(1);
      await composerOf(alice, channel.name).press('Enter');
      await expect(alice.getByTestId('tray-file')).toHaveCount(0);
    }

    const rows = alice.getByTestId('pending-message');
    await expect(rows).toHaveCount(7);
    await expect(rows.filter({ hasText: 'Uploading…' })).toHaveCount(2);
    const waiting = rows.filter({ hasText: 'Waiting for other uploads to finish' });
    await expect(waiting).toHaveCount(5);
    await expect(waiting.first().getByRole('progressbar')).toHaveCount(0);
    await expect
      .poll(() => alice.getByTestId('pending-file').locator('video').count())
      .toBeLessThan(7);
    await expect(alice.getByTestId('pending-file')).toHaveCount(7);

    const quickly = async () =>
      alice.evaluate(async () => {
        const started = performance.now();
        await fetch('/api/health', { cache: 'no-store' });
        return performance.now() - started;
      });
    expect(await quickly()).toBeLessThan(3000);
    const words = `Past the line ${id}`;
    await sendMessage(alice, channel.name, words);
    await expect(bob.getByText(words)).toBeVisible({ timeout: 5000 });
    expect(peak).toBeLessThanOrEqual(2);

    await waiting.last().getByRole('button', { name: 'Cancel' }).click();
    await expect(rows).toHaveCount(6);

    const uploading = rows.filter({ hasText: 'Uploading…' });
    inFlight.delete([...inFlight][0]!);
    await uploading.first().getByRole('button', { name: 'Cancel' }).click();
    await expect(rows).toHaveCount(5);
    await expect(uploading).toHaveCount(2);
    await expect(waiting).toHaveCount(3);

    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await expect(rows).toHaveCount(0, { timeout: 60_000 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(startedNames).toEqual(names.slice(0, 6));
    await expect(bob.getByTestId('attachment-video')).toHaveCount(5);
    await close();
  });
});

test.describe('closing the tab', () => {
  test('asks first while a file is going up, and not otherwise', async ({ browser }) => {
    const { context, page } = await user(browser, USERS.bob);
    await channelButton(page, 'general').click();

    const idle = await context.newPage();
    await idle.goto('/');
    await expect(idle.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
    await channelButton(idle, 'general').click();
    const idleClosed = idle.waitForEvent('close');
    await idle.close({ runBeforeUnload: true });
    await idleClosed;

    await page.route('**/api/channels/*/attachments*', () => undefined);
    await attach(page, pngFile(`going-up-${stamp()}.png`));
    await page.getByRole('button', { name: 'Send message' }).click();
    const row = page.getByTestId('pending-message');
    await expect(row).toContainText('Uploading…');

    const asked = page.waitForEvent('dialog');
    await page.close({ runBeforeUnload: true });
    const dialog = await asked;
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
    await expect(row).toContainText('Uploading…');

    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row).toHaveCount(0);
    const closed = page.waitForEvent('close');
    await page.close({ runBeforeUnload: true });
    await closed;
    await context.close();
  });
});

test.describe('anything dropped on the app', () => {
  test.describe.configure({ timeout: 120_000 });

  async function realDrop(page: Page, x: number, y: number, data: object) {
    const client = await page.context().newCDPSession(page);
    const send = (type: string) =>
      client.send('Input.dispatchDragEvent', { type, x, y, data } as never);
    await send('dragEnter');
    await send('dragOver');
    await send('drop');
    await page.waitForTimeout(800);
    await client.detach();
  }

  test('in a call with the chat hidden, a file or a link opens nothing and ends nothing', async ({
    browser,
  }, testInfo) => {
    test.skip(process.env.E2E_LIVEKIT_AVAILABLE !== '1', 'needs the real media server');
    const { context, page } = await user(browser, USERS.alice);
    await page.getByRole('button', { name: /^General Voice/ }).click();
    await expect(page.getByTestId('voice-state')).toHaveText('Voice connected', {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Hide chat' }).first().click();
    await expect(page.getByLabel(/^Message /)).toHaveCount(0);

    const file = testInfo.outputPath('dropped.png');
    writeFileSync(file, pngFile('dropped.png').buffer);
    const before = page.url();
    await realDrop(page, 640, 420, { items: [], files: [file], dragOperationsMask: 1 });
    await realDrop(page, 640, 420, {
      items: [{ mimeType: 'text/uri-list', data: 'http://localhost:5290/?dropped-link=1' }],
      dragOperationsMask: 1,
    });

    expect(context.pages()).toHaveLength(1);
    expect(page.url()).toBe(before);
    await expect(page.getByTestId('voice-state')).toHaveText('Voice connected');
    await context.close();
  });

  test('a real file reaches the chat it was dropped on, and a link dropped in the text box is text', async ({
    browser,
  }, testInfo) => {
    const { context, page } = await user(browser, USERS.alice);
    await channelButton(page, 'gaming').click();
    const composer = composerOf(page, 'gaming');
    await expect(composer).toBeVisible();

    const name = `real-drop-${stamp()}.png`;
    const file = testInfo.outputPath(name);
    writeFileSync(file, pngFile(name).buffer);
    const box = (await page.getByRole('log').boundingBox())!;
    await realDrop(page, box.x + box.width / 2, box.y + box.height / 2, {
      items: [],
      files: [file],
      dragOperationsMask: 1,
    });
    await expect(page.getByTestId('tray-file')).toContainText(name);
    expect(context.pages()).toHaveLength(1);
    await page.getByRole('button', { name: `Remove ${name}` }).click();

    const url = 'http://localhost:5290/a-link';
    const field = (await composer.boundingBox())!;
    await realDrop(page, field.x + field.width / 2, field.y + field.height / 2, {
      items: [
        { mimeType: 'text/uri-list', data: url },
        { mimeType: 'text/plain', data: url },
      ],
      dragOperationsMask: 1,
    });
    await expect(composer).toHaveValue(url);
    expect(context.pages()).toHaveLength(1);
    await composer.fill('');
    await context.close();
  });
});

test.describe('files the server no longer has', () => {
  async function sendThenSweep(alice: Page, channel: string, name: string, text: string) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await alice.route('**/api/channels/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await held;
      return route.continue();
    });
    const uploaded = alice.waitForResponse(
      (r) => r.url().includes('/attachments?') && r.status() === 201,
    );
    await attach(alice, pngFile(name));
    await composerOf(alice, channel).fill(text);
    await composerOf(alice, channel).press('Enter');
    const { attachment } = (await (await uploaded).json()) as { attachment: { id: string } };
    const row = alice.getByTestId('pending-message');
    await expect(row).toContainText('Sending…');
    const gone = await alice.request.delete(`/api/attachments/${attachment.id}`, {
      headers: { 'X-CSRF-Token': await csrf(alice) },
    });
    expect(gone.status()).toBe(204);
    return { row, release, attachmentId: attachment.id };
  }

  test('with the files still in this page, Retry uploads them again and the message goes', async ({
    browser,
  }) => {
    const { alice, bob, channel, close } = await pair(browser);
    const id = stamp();
    const name = `swept-${id}.png`;
    const text = `Swept ${id}`;
    const { row, release } = await sendThenSweep(alice, channel.name, name, text);
    let uploads = 0;
    alice.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/attachments')) uploads++;
    });

    release();
    await expect(row).toContainText('Retry uploads them again');
    await expect(row).toContainText(text);
    expect(uploads).toBe(0);

    await row.getByRole('button', { name: 'Retry' }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    expect(uploads).toBe(1);
    await expect(bob.getByText(text)).toHaveCount(1);
    await expectDrawn(bob, name);
    await close();
  });

  test('with the page reloaded since, Retry goes away after the server says so, and stays away', async ({
    browser,
  }) => {
    const { alice, bob, channel, close } = await pair(browser);
    const id = stamp();
    const name = `swept-reload-${id}.png`;
    const text = `Swept and reloaded ${id}`;
    await sendThenSweep(alice, channel.name, name, text);
    await alice.reload();
    await alice.unrouteAll({ behavior: 'ignoreErrors' });
    await expect(composerOf(alice, channel.name)).toBeVisible();

    const row = alice.getByTestId('pending-message');
    await expect(row).toContainText(text);
    await row.getByRole('button', { name: 'Retry' }).click();
    await expect(row).toContainText('Discard this and attach them again');
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Discard' })).toBeVisible();
    await expect(row.getByTestId('attachment-card')).toContainText('Not uploaded');

    await alice.reload();
    await expect(composerOf(alice, channel.name)).toBeVisible();
    await expect(row).toContainText('Discard this and attach them again');
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);

    await row.getByRole('button', { name: 'Discard' }).click();
    await expect(row).toHaveCount(0);
    await expect(bob.getByText(text)).toHaveCount(0);
    await close();
  });
});

test.describe('what an image asks of other people', () => {
  test('a real 4K screenshot of a nearly blank page goes through, and a bomb says why it does not', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { alice, bob, channel, close } = await pair(browser);

    const shooter = await browser.newContext({ viewport: { width: 3840, height: 2160 } });
    const blank = await shooter.newPage();
    await blank.setContent(
      '<body style="background:#fff;margin:60px;font:16px system-ui"><p>One short line.</p>',
    );
    const screenshot = await blank.screenshot();
    await shooter.close();
    expect(screenshot.length).toBeLessThan(80_000);

    const id = stamp();
    const name = `blank-${id}.png`;
    await attach(alice, { name, mimeType: 'image/png', buffer: screenshot });
    await composerOf(alice, channel.name).press('Enter');
    await expectDrawn(bob, name);
    await expect
      .poll(() =>
        bob.locator(`img[alt="${name}"]`).evaluate((i: HTMLImageElement) => i.naturalWidth),
      )
      .toBe(3840);

    const bomb = `bomb-${id}.png`;
    await attach(alice, { name: bomb, mimeType: 'image/png', buffer: buildBlankPng(16384, 16384) });
    await composerOf(alice, channel.name).press('Enter');
    const row = alice.getByTestId('pending-message');
    await expect(row).toContainText('16384 by 16384 pixels in a very small file');
    await row.getByRole('button', { name: 'Discard' }).click();
    await expect(bob.locator(`img[alt="${bomb}"]`)).toHaveCount(0);
    await close();
  });
});
