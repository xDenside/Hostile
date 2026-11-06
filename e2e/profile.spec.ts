import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  closeModal,
  joinVoice,
  openDiagnostics,
  openTextChannel,
  sendMessage,
  signIn,
  USERS,
} from './helpers';

const ANIMATED_GIF = Buffer.from(
  'R0lGODlhAQABAPEBAP8AAAAA/wAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQECgAAACwAAAAAAQABAAACAkQBACH5BAQKAAAALAAAAAABAAEAAAICTAEAOw==',
  'base64',
);

function memberRow(page: Page, name: string) {
  return page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name });
}

test.describe('profiles', () => {
  test('a card or menu opened at the edge of the window stays inside it', async ({ browser }) => {
    const viewport = { width: 1280, height: 720 };
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await signIn(page, USERS.alice);

    async function fullyInside(panel: Locator, width: number) {
      await expect
        .poll(async () => (await panel.boundingBox())?.width, { timeout: 5000 })
        .toBeCloseTo(width, 1);
      const box = (await panel.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }

    const ownCard = page.getByTestId('own-card');
    await ownCard.getByRole('button').first().click();
    await fullyInside(page.getByTestId('profile-card'), 320);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('profile-card')).toHaveCount(0);

    await ownCard.getByRole('button').first().click({ button: 'right' });
    await fullyInside(page.getByTestId('member-menu'), 240);
    await context.close();
  });

  test('the status dot sits on the rim of the picture, half on it and half off it', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await signIn(page, USERS.alice);

    await page.getByTestId('own-card').getByRole('button').first().click();
    await expect
      .poll(async () => (await page.getByTestId('profile-card').boundingBox())?.width)
      .toBeCloseTo(320, 1);

    const dots = page.getByTestId('presence-dot');
    expect(await dots.count()).toBeGreaterThanOrEqual(3);
    const offsets = await dots.evaluateAll((all) =>
      all.map((dot) => {
        const d = dot.getBoundingClientRect();
        const a = dot.parentElement!.getBoundingClientRect();
        const fromCenter = Math.hypot(
          d.x + d.width / 2 - (a.x + a.width / 2),
          d.y + d.height / 2 - (a.y + a.height / 2),
        );
        return Math.abs(fromCenter - a.width / 2);
      }),
    );
    for (const offset of offsets) expect(offset).toBeLessThan(1.5);
    await context.close();
  });

  test('a card has who this is beside the picture, and shows all of a script name', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await signIn(page, USERS.alice);

    await page.getByTestId('own-card').getByRole('button').first().click();
    const card = page.getByTestId('profile-card');
    await expect.poll(async () => (await card.boundingBox())?.width).toBeCloseTo(320, 1);
    await expect(card.getByTestId('owner-mark')).toBeVisible();
    await expect(card.getByText('Owner', { exact: true })).toHaveCount(0);
    const ring = await card.evaluate((el) => {
      const banner = el.firstElementChild!;
      const painted = el.querySelector('[data-testid="presence-dot"]')!.parentElement!
        .parentElement!;
      const box = painted.getBoundingClientRect();
      return {
        paint: getComputedStyle(painted).backgroundColor,
        hole: getComputedStyle(banner).maskImage,
        fromCardLeft: box.left + box.width / 2 - el.getBoundingClientRect().left,
        belowBanner: box.top + box.height / 2 - banner.getBoundingClientRect().bottom,
      };
    });
    expect(ring.paint).toBe('rgba(0, 0, 0, 0)');
    expect(ring.hole).toContain('circle at 58px calc(100% + 18px)');
    expect(ring.fromCardLeft).toBe(58);
    expect(ring.belowBanner).toBe(18);
    const layout = await card.evaluate((el) => {
      const avatar = el.querySelector('[data-testid="presence-dot"]')!.parentElement!;
      const name = el.querySelector('[data-text]')!;
      const span = (test: (text: string) => boolean) =>
        [...el.querySelectorAll('span')].find((s) => test(s.textContent ?? ''))!;
      const picture = avatar.getBoundingClientRect();
      return {
        pictureOverBanner: el.firstElementChild!.getBoundingClientRect().bottom - picture.top,
        pictureAboveTags:
          span((t) => t === 'Online').getBoundingClientRect().bottom - picture.bottom,
        gap: name.getBoundingClientRect().left - avatar.getBoundingClientRect().right,
        tagsBelowName:
          span((t) => t === 'Online').getBoundingClientRect().top -
          name.getBoundingClientRect().bottom,
        markAfterName:
          el.querySelector('[data-testid="owner-mark"]')!.getBoundingClientRect().left -
          name.getBoundingClientRect().right,
      };
    });
    expect(layout.gap).toBeGreaterThan(0);
    expect(layout.tagsBelowName).toBeGreaterThanOrEqual(-1);
    expect(layout.markAfterName).toBeGreaterThanOrEqual(0);
    expect(layout.pictureOverBanner).toBeGreaterThan(0);
    expect(Math.abs(layout.pictureAboveTags)).toBeLessThan(1);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(page.getByTestId('profile-preview')).toBeVisible();
    await page.getByLabel('Nickname').fill('Brambli');
    await expect(page.getByTestId('profile-preview')).toContainText('Brambli');
    await page.evaluate(() => document.fonts.ready);
    const cutOff = await page.evaluate(() => {
      const canvas = document.createElement('canvas').getContext('2d')!;
      return [...document.querySelectorAll<HTMLElement>('[role="dialog"] [data-text]')]
        .filter((el) => {
          const style = getComputedStyle(el);
          canvas.font = style.font;
          canvas.letterSpacing = style.letterSpacing;
          const ink = canvas.measureText(el.dataset.text!);
          const left = parseFloat(style.paddingLeft);
          return ink.actualBoundingBoxRight > el.getBoundingClientRect().width - left + 0.5;
        })
        .map((el) => getComputedStyle(el).fontFamily);
    });
    expect(cutOff).toEqual([]);

    const preview = page.getByTestId('profile-preview');
    const fonts = page.getByRole('radio', { name: /^Brambli/ });
    const fontCount = await fonts.count();
    expect(fontCount).toBeGreaterThanOrEqual(9);
    const drifts: number[] = [];
    for (let i = 0; i < 9; i++) {
      await fonts.nth(i).click();
      await page.evaluate(() => document.fonts.ready);
      drifts.push(
        await preview.evaluate((el) => {
          const name = el.querySelector('[data-text]')!;
          const probe = document.createElement('span');
          probe.style.cssText = 'display:inline-block;width:0;height:0';
          name.prepend(probe);
          const baseline = probe.getBoundingClientRect().bottom;
          probe.remove();
          const mark = el.querySelector('[data-testid="owner-mark"]')!;
          return mark.getBoundingClientRect().bottom - baseline;
        }),
      );
      expect(Math.abs(drifts[i]! - drifts[0]!), `font ${i}`).toBeLessThan(1);

      const shortBy = await preview.evaluate((el) => {
        const name = el.querySelector<HTMLElement>('[data-text]')!;
        const style = getComputedStyle(name);
        const canvas = document.createElement('canvas').getContext('2d')!;
        canvas.font = style.font;
        canvas.letterSpacing = style.letterSpacing;
        return (
          canvas.measureText(name.dataset.text!).actualBoundingBoxRight -
          (name.getBoundingClientRect().width - parseFloat(style.paddingLeft))
        );
      });
      expect(shortBy, `font ${i} in the card`).toBeLessThanOrEqual(0.5);
    }

    await page.getByLabel('Nickname').fill('N'.repeat(48));
    await page.getByLabel('Custom status').fill('x'.repeat(48));
    const past = await preview.evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      const edge = (id: string) =>
        el.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().right - right;
      return { mark: edge('owner-mark'), status: edge('status-chip') };
    });
    expect(past.mark).toBeLessThan(0);
    expect(past.status).toBeLessThan(0);
    await context.close();
  });

  test('a card names the voice channel someone is in, ending in an ellipsis if it must', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext({ permissions: ['microphone'] });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);
    await joinVoice(bob, 'General Voice');

    await memberRow(alice, 'Bob').click();
    const card = alice.getByTestId('profile-card');
    const tag = card.getByTitle('General Voice');
    await expect(tag).toHaveText('General Voice', { timeout: 15_000 });
    await expect.poll(async () => (await card.boundingBox())?.width).toBeCloseTo(320, 1);

    const fit = await card.evaluate((el) => {
      const tagBox = el.querySelector<HTMLElement>('[title="General Voice"]')!;
      const text = tagBox.querySelector<HTMLElement>('span')!;
      const status = el.querySelector<HTMLElement>('[data-testid="status-chip"]')!;
      const offLine = () =>
        Math.abs(tagBox.getBoundingClientRect().top - status.getBoundingClientRect().top);
      text.textContent = 'A channel with the longest name that one may have';
      const long = {
        icon: tagBox.querySelector('svg')!.getBoundingClientRect().width,
        cut: text.scrollWidth > text.clientWidth,
        ending: getComputedStyle(text).textOverflow,
        offLine: offLine(),
        pastEdge: tagBox.getBoundingClientRect().right - el.getBoundingClientRect().right,
      };
      text.textContent = 'General Voice';
      status.firstElementChild!.textContent = 'Reading a rather long book by the window';
      return {
        ...long,
        dropped: offLine() > 1,
        shownInFull: text.scrollWidth <= text.clientWidth,
      };
    });
    expect(fit.icon).toBeCloseTo(12, 0);
    expect(fit.cut).toBe(true);
    expect(fit.ending).toBe('ellipsis');
    expect(fit.offLine).toBeLessThan(1);
    expect(fit.pastEdge).toBeLessThan(0);
    expect(fit.dropped).toBe(true);
    expect(fit.shownInFull).toBe(true);
    await bobContext.close();
    await aliceContext.close();
  });

  test('a status replaces Online for everyone, and goes away with its owner', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);

    async function setStatus(page: Page, text: string) {
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await page.getByRole('button', { name: 'Profile', exact: true }).click();
      await page.getByLabel('Custom status').fill(text);
      await expect(page.getByTestId('profile-preview').getByTestId('status-chip')).toHaveText(
        text || 'Online',
      );
      await page.getByTestId('profile-save').click();
      await expect(page.getByTestId('profile-save')).toBeDisabled();
    }

    const longest = 'Ш'.repeat(12) + ' читаю длинную книгу у окна, вернусь скоро'.slice(0, 36);
    expect(longest).toHaveLength(48);
    await setStatus(bob, longest);
    const fit = await bob.getByTestId('profile-preview').evaluate((card) => {
      const chip = card.querySelector<HTMLElement>('[data-testid="status-chip"]')!;
      const text = chip.firstElementChild as HTMLElement;
      return {
        past: chip.getBoundingClientRect().right - card.getBoundingClientRect().right,
        hidden: text.scrollHeight - text.clientHeight,
        lines: text.getClientRects()[0]!.height / parseFloat(getComputedStyle(text).lineHeight),
      };
    });
    expect(fit.past).toBeLessThan(0);
    expect(fit.lines).toBeLessThanOrEqual(2.01);
    expect(fit.hidden).toBeLessThanOrEqual(0);
    await closeModal(bob);

    await memberRow(alice, 'Bob').click();
    const chip = alice.getByTestId('profile-card').getByTestId('status-chip');
    await expect(chip).toHaveText(longest);

    await setStatus(bob, 'В игре 🎮');
    await closeModal(bob);
    await expect(chip).toHaveText('В игре 🎮');

    await bobContext.close();
    await expect(chip).toHaveText('Offline', { timeout: 45_000 });
    await alice.keyboard.press('Escape');

    const backContext = await browser.newContext();
    const back = await backContext.newPage();
    await signIn(back, USERS.bob);
    await memberRow(alice, 'Bob').click();
    await expect(chip).toHaveText('В игре 🎮');

    await setStatus(back, '');
    await expect(chip).toHaveText('Online');
    await backContext.close();
    await aliceContext.close();
  });

  test('the owner has a mark beside their name in chat, and nobody else does', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);
    await openTextChannel(alice, 'general');
    await openTextChannel(bob, 'general');
    const stamp = Date.now();
    await sendMessage(bob, 'general', `before the owner ${stamp}`);
    await expect(alice.getByText(`before the owner ${stamp}`)).toBeVisible();
    await sendMessage(alice, 'general', `from the owner ${stamp}`);
    await expect(bob.getByText(`from the owner ${stamp}`)).toBeVisible();
    await sendMessage(bob, 'general', `from a member ${stamp}`);
    await expect(alice.getByText(`from a member ${stamp}`)).toBeVisible();

    const owners = alice.getByTestId('message').filter({ hasText: `from the owner ${stamp}` });
    const members = alice.getByTestId('message').filter({ hasText: `from a member ${stamp}` });
    await expect(owners.getByTestId('owner-mark')).toHaveCount(1);
    await expect(owners.getByText('Owner', { exact: true })).toHaveCount(0);
    await expect(members.getByTestId('owner-mark')).toHaveCount(0);

    await memberRow(alice, 'Bob').click();
    await expect(alice.getByTestId('profile-card')).toBeVisible();
    await expect(alice.getByTestId('profile-card').getByTestId('owner-mark')).toHaveCount(0);
    await bobContext.close();
    await aliceContext.close();
  });

  test('right-clicking a member opens a menu with their volume, and clicking opens their card', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const alice = await context.newPage();
    await signIn(alice, USERS.alice);
    await openTextChannel(alice, 'general');

    await memberRow(alice, 'Bob').click({ button: 'right' });
    const menu = alice.getByTestId('member-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'View profile' })).toBeVisible();

    const slider = menu.getByRole('slider', { name: 'User volume' });
    await slider.fill('0.5');
    await expect(menu.getByTestId('user-volume')).toContainText('50%');
    await alice.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    await memberRow(alice, 'Bob').click({ button: 'right' });
    await expect(menu.getByTestId('user-volume')).toContainText('50%');
    await menu.getByRole('slider', { name: 'User volume' }).fill('1');
    await alice.keyboard.press('Escape');

    await alice.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await alice.getByRole('button', { name: 'Voice & audio' }).click();
    await expect(alice.getByText('Per-person volume')).toHaveCount(0);
    await closeModal(alice);

    await memberRow(alice, 'Bob').click();
    const card = alice.getByTestId('profile-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(USERS.bob.displayName);
    await expect(card).not.toContainText('@');
    await expect(card.getByRole('slider', { name: 'User volume' })).toBeVisible();
    await alice.keyboard.press('Escape');
    await expect(card).toHaveCount(0);

    await context.close();
  });

  test('a GIF avatar, a background and a name style reach other members live', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);
    await openTextChannel(bob, 'general');

    await alice.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await alice.getByRole('button', { name: 'Profile', exact: true }).click();

    const gif = { name: 'avatar.gif', mimeType: 'image/gif', buffer: ANIMATED_GIF };
    const avatarUpload = alice.waitForResponse(
      (r) => r.url().includes('/profile/media/avatar') && r.request().method() === 'PUT',
    );
    await alice.getByTestId('upload-avatar').setInputFiles(gif);
    expect((await avatarUpload).status()).toBe(200);
    const bannerUpload = alice.waitForResponse(
      (r) => r.url().includes('/profile/media/banner') && r.request().method() === 'PUT',
    );
    await alice.getByTestId('upload-banner').setInputFiles(gif);
    expect((await bannerUpload).status()).toBe(200);

    await alice
      .getByRole('radiogroup', { name: 'Name font' })
      .getByRole('radio', { name: /Pacifico/ })
      .click();
    await alice
      .getByRole('radiogroup', { name: 'Name highlight' })
      .getByRole('radio', { name: /Gradient/ })
      .click();
    await alice.getByTestId('profile-save').click();
    await expect(alice.getByText('Profile updated.')).toBeVisible();
    await closeModal(alice);

    await memberRow(bob, 'Alice').click();
    const card = bob.getByTestId('profile-card');
    await expect(card).toBeVisible();
    const images = card.locator('img');
    await expect(images).toHaveCount(2, { timeout: 15_000 });
    for (const src of await images.evaluateAll((els) =>
      els.map((el) => (el as HTMLImageElement).src),
    )) {
      expect(src).toContain('/api/media/');
      const res = await bob.request.get(src);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('image/gif');
    }
    const fontFamily = await card
      .getByText('Alice (dev)', { exact: true })
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily).toContain('Pacifico');
    await bob.keyboard.press('Escape');

    await alice.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await alice.getByRole('button', { name: 'Profile', exact: true }).click();
    await alice.getByRole('button', { name: 'Remove' }).first().click();
    await expect(alice.getByRole('button', { name: 'Remove' })).toHaveCount(1);
    await alice.getByRole('button', { name: 'Remove' }).click();
    await expect(alice.getByRole('button', { name: 'Remove' })).toHaveCount(0);
    await alice
      .getByRole('radiogroup', { name: 'Name font' })
      .getByRole('radio', { name: /Default/ })
      .click();
    await alice
      .getByRole('radiogroup', { name: 'Name highlight' })
      .getByRole('radio', { name: /Plain/ })
      .click();
    await alice.getByTestId('profile-save').click();
    await closeModal(alice);

    await aliceContext.close();
    await bobContext.close();
  });

  test('every call sound is a real file the browser can decode', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, USERS.alice);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('button', { name: 'Voice & audio' }).click();

    const heard = new Map<string, string>();
    page.on('response', (r) => {
      if (/\.mp3(\?|$)/.test(r.url())) heard.set(r.url(), r.headers()['content-type'] ?? '');
    });
    const previews = [
      'Someone joins',
      'Someone leaves',
      'Mute',
      'Unmute',
      'Deafen',
      'Undeafen',
      'Screen share starts',
      'Screen share stops',
      'Someone joins your stream',
    ];
    for (const name of previews) {
      await page.getByRole('button', { name, exact: true }).click();
    }
    await expect.poll(() => heard.size, { timeout: 15_000 }).toBe(previews.length);

    const durations = await page.evaluate(
      async (urls) => {
        const ctx = new OfflineAudioContext(1, 44100, 44100);
        return Promise.all(
          urls.map(async (url) => {
            const bytes = await (await fetch(url)).arrayBuffer();
            return (await ctx.decodeAudioData(bytes)).duration;
          }),
        );
      },
      [...heard.keys()],
    );
    for (const duration of durations) {
      expect(duration).toBeGreaterThan(0.05);
      expect(duration).toBeLessThan(1);
    }

    await context.close();
  });
});

test.describe('voice channel chat and stream ducking', () => {
  test.setTimeout(240_000);
  test.skip(
    process.env.E2E_LIVEKIT_AVAILABLE !== '1',
    'livekit-server is not available on this machine',
  );

  test('a voice channel has its own chat, beside the call', async ({ browser }) => {
    const aliceContext = await browser.newContext({ permissions: ['microphone'] });
    const bobContext = await browser.newContext({ permissions: ['microphone'] });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);
    await joinVoice(alice, 'General Voice');
    await openTextChannel(bob, 'general');

    const text = `voice chat ${test.info().repeatEachIndex}-${test.info().retry}-${Date.now()}`;
    const composer = alice.getByLabel('Message General Voice');
    await expect(composer).toBeVisible();
    await composer.fill(text);
    await composer.press('Enter');
    await expect(alice.getByTestId('message').filter({ hasText: text })).toBeVisible();
    await expect(alice.getByTestId('voice-state')).toHaveText('Voice connected');

    await expect(bob.getByTestId('message').filter({ hasText: text })).toHaveCount(0);
    await expect(
      bob.getByRole('button', { name: /^General Voice/ }).getByLabel('Unread messages'),
    ).toBeVisible({ timeout: 15_000 });

    await bob.getByRole('button', { name: /^General Voice/ }).click();
    await expect(bob.getByTestId('message').filter({ hasText: text })).toBeVisible();

    await alice.getByTestId('voice-chat-toggle').click();
    await expect(composer).toHaveCount(0);
    await alice.getByTestId('voice-chat-toggle').click();
    await expect(composer).toBeVisible();

    await aliceContext.close();
    await bobContext.close();
  });

  test('a stream drops while someone else talks, and never for your own voice', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext({ permissions: ['microphone'] });
    const bobContext = await browser.newContext({ permissions: ['microphone'] });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await alice.addInitScript(() => {
      const devices = navigator.mediaDevices;
      const capture = devices.getDisplayMedia.bind(devices);
      devices.getDisplayMedia = async (options) => {
        const stream = await capture({ ...options, audio: false });
        const ctx = new AudioContext();
        const destination = ctx.createMediaStreamDestination();
        const tone = ctx.createOscillator();
        tone.connect(destination);
        tone.start();
        for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
        return stream;
      };
    });

    await signIn(alice, USERS.alice);
    await signIn(bob, USERS.bob);
    await joinVoice(alice, 'General Voice');
    await joinVoice(bob, 'General Voice');
    await expect(bob.getByTestId('participant-tile')).toHaveCount(2, { timeout: 30_000 });

    await alice.getByRole('button', { name: 'Mute microphone' }).click();
    await alice.getByRole('button', { name: 'Share your screen' }).click();
    await alice.getByRole('button', { name: 'Start sharing' }).click();
    const share = bob.getByTestId('share-tile-remote');
    await expect(share).toBeVisible({ timeout: 30_000 });

    await share.click({ button: 'right' });
    await bob.getByTestId('share-menu-ducking').click();
    await bob.keyboard.press('Escape');

    await openDiagnostics(bob);
    const volume = () =>
      bob
        .getByTestId('diag-stream-volume')
        .first()
        .innerText()
        .then((text) => Number(text));
    await expect.poll(volume, { timeout: 30_000 }).toBe(1);

    await expect(bob.getByTestId('diag-audio-sent')).not.toHaveText('no microphone published');
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      samples.push(await volume());
      await bob.waitForTimeout(400);
    }
    expect(Math.min(...samples)).toBe(1);

    await alice.getByRole('button', { name: 'Unmute microphone' }).click();
    await expect.poll(volume, { timeout: 20_000 }).toBeLessThan(0.4);

    await alice.getByRole('button', { name: 'Mute microphone' }).click();
    await expect.poll(volume, { timeout: 20_000 }).toBe(1);

    await aliceContext.close();
    await bobContext.close();
  });
});
