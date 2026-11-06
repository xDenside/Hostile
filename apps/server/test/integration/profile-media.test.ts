import { randomUUID } from 'node:crypto';
import { LIMITS } from '@hostile/shared';
import type { ClientToServerEvents, ServerToClientEvents, UserPublic } from '@hostile/shared';
import { PGlite } from '@electric-sql/pglite';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  bearerAuth,
  createUser,
  loginDesktop,
  loginWeb,
  webAuth,
  type DesktopSession,
  type WebSession,
} from '../support/factories.js';
import {
  resetDatabase,
  startTestApi,
  TEST_APP_ORIGIN,
  waitFor,
  type TestApi,
} from '../support/harness.js';
import { buildPng, jpegSegment, REAL_IMAGES } from '../support/images.js';
import { REAL_LOCATED } from '../support/located-files.js';
import {
  EXIF_PREFIX,
  hasGpsPointer,
  jpegWith,
  orientationIn,
} from '../support/location-builders.js';

let api: TestApi;

const AVATAR_LIMIT = LIMITS.avatarMaxBytes;
const SMALL_PNG = REAL_IMAGES.png;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(async () => {
  api = await startTestApi();
  await resetDatabase(api.ctx);
});

afterAll(async () => {
  await api?.stop();
});

async function member(): Promise<{ id: string; session: DesktopSession }> {
  const user = await createUser(api.ctx);
  return {
    id: user.id,
    session: await loginDesktop(api, user),
  };
}

interface Sent {
  status: number;
  body: {
    user: UserPublic & { createdAt: string };
    error: { code: string; message: string; issues?: { path: string }[] };
  };
}

async function put(
  kind: string,
  body: RequestInit['body'],
  headers: Record<string, string>,
  init: RequestInit = {},
): Promise<Sent> {
  const res = await fetch(`${api.baseUrl}/api/auth/profile/media/${kind}`, {
    method: 'PUT',
    headers,
    body,
    ...init,
  });
  return { status: res.status, body: (await res.json()) as Sent['body'] };
}

async function remove(kind: string, headers: Record<string, string>): Promise<Sent> {
  const res = await fetch(`${api.baseUrl}/api/auth/profile/media/${kind}`, {
    method: 'DELETE',
    headers,
  });
  return { status: res.status, body: (await res.json()) as Sent['body'] };
}

const getMedia = (path: string, init: RequestInit = {}) => fetch(`${api.baseUrl}${path}`, init);

const mediaRows = (ownerId: string) =>
  api.ctx.db.profileMedia.findMany({
    where: { ownerId },
    select: { id: true, kind: true },
  });

describe('upload and fetch', () => {
  for (const [name, image] of Object.entries(REAL_IMAGES)) {
    test(`${name} round-trips byte for byte, with every header`, async () => {
      const me = await member();
      const sent = await put('avatar', image.bytes, bearerAuth(me.session));
      expect(sent.status).toBe(200);
      const url = sent.body.user.avatarUrl!;
      expect(url).toMatch(/^\/api\/media\//);

      const res = await getMedia(url);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(image.bytes)).toBe(true);
      expect(res.headers.get('content-type')).toBe(image.type);
      expect(res.headers.get('content-length')).toBe(String(image.bytes.length));
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(res.headers.get('etag')).toBe(`"${url.split('/').pop()}"`);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  }

  test('every Origin gets the same answer, so a long-lived cache entry suits them all', async () => {
    const me = await member();
    const url = (await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session))).body.user.avatarUrl!;
    for (const origin of [undefined, TEST_APP_ORIGIN, 'https://elsewhere.example']) {
      const res = await getMedia(url, origin ? { headers: { Origin: origin } } : {});
      expect(res.status, origin).toBe(200);
      expect(res.headers.get('access-control-allow-origin'), origin).toBe('*');
      expect(res.headers.get('vary'), origin).toBeNull();
    }
  });

  test('the stored row says what the file says, under a random v4 id', async () => {
    const me = await member();
    const sent = await put('banner', REAL_IMAGES.webpExtended.bytes, bearerAuth(me.session));
    expect(sent.status).toBe(200);
    expect(sent.body.user.id).toBe(me.id);
    expect(sent.body.user.createdAt).toEqual(expect.any(String));
    expect(sent.body.user.avatarUrl).toBeNull();

    const id = sent.body.user.bannerUrl!.split('/').pop()!;
    expect(id).toMatch(UUID_V4);
    const row = await api.ctx.db.profileMedia.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      ownerId: me.id,
      kind: 'banner',
      contentType: 'image/webp',
      byteSize: REAL_IMAGES.webpExtended.bytes.length,
      width: 37,
      height: 11,
    });
  });

  test('a revalidation with the ETag gets a 304 and no body', async () => {
    const me = await member();
    const url = (await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session))).body.user.avatarUrl!;
    const etag = (await getMedia(url)).headers.get('etag')!;

    const res = await api.http().get(url).set('If-None-Match', etag);
    expect(res.status).toBe(304);
    expect(res.text ?? '').toBe('');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['etag']).toBe(etag);
  });

  test('HEAD reports the image without sending it', async () => {
    const me = await member();
    const url = (await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session))).body.user.avatarUrl!;
    const res = await getMedia(url, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('');
  });

  test('the type comes from the bytes, whatever the request claims', async () => {
    const me = await member();
    for (const claimed of ['image/gif', 'text/html', 'application/octet-stream']) {
      const sent = await put('avatar', SMALL_PNG.bytes, {
        ...bearerAuth(me.session),
        'Content-Type': claimed,
      });
      expect(sent.status, claimed).toBe(200);
      const res = await getMedia(sent.body.user.avatarUrl!);
      expect(res.headers.get('content-type'), claimed).toBe('image/png');
    }
  });

  test('a body labelled JSON is still an image, even past the JSON size limit', async () => {
    const me = await member();
    const bytes = buildPng(16, 16, LIMITS.jsonBodyBytes + 1024);
    const sent = await put('avatar', bytes, {
      ...bearerAuth(me.session),
      'Content-Type': 'application/json',
    });
    expect(sent.status).toBe(200);
    const res = await getMedia(sent.body.user.avatarUrl!);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  test('the JSON limit and parser still apply everywhere else', async () => {
    const me = await member();
    const res = await api
      .http()
      .patch('/api/auth/profile')
      .set(bearerAuth(me.session))
      .send({ displayName: 'x'.repeat(LIMITS.jsonBodyBytes + 1) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  test('avatar and banner are independent', async () => {
    const me = await member();
    await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session));
    const both = await put('banner', REAL_IMAGES.jpeg.bytes, bearerAuth(me.session));
    expect(both.body.user.avatarUrl).not.toBeNull();
    expect(both.body.user.bannerUrl).not.toBeNull();
    expect(both.body.user.avatarUrl).not.toBe(both.body.user.bannerUrl);

    const cleared = await remove('avatar', bearerAuth(me.session));
    expect(cleared.body.user.avatarUrl).toBeNull();
    expect(cleared.body.user.bannerUrl).toBe(both.body.user.bannerUrl);
    expect(await mediaRows(me.id)).toEqual([{ id: expect.any(String), kind: 'banner' }]);
  });
});

describe('fetching media', () => {
  const expectPlain404 = async (res: Response) => {
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Image not found.' },
    });
  };

  test('an unknown id and a malformed one get the same plain 404, never cached', async () => {
    await expectPlain404(await getMedia(`/api/media/${randomUUID()}`));
    await expectPlain404(await getMedia('/api/media/not-a-uuid'));
    await expectPlain404(await getMedia("/api/media/'%20OR%201=1--"));
  });

  test('a disabled member keeps their images, because old messages still show them', async () => {
    const me = await member();
    const url = (await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session))).body.user.avatarUrl!;
    await api.ctx.db.user.update({ where: { id: me.id }, data: { disabledAt: new Date() } });
    expect((await getMedia(url)).status).toBe(200);
  });

  test('a stale cookie does not get in the way of an image', async () => {
    const me = await member();
    const url = (await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session))).body.user.avatarUrl!;
    const res = await getMedia(url, { headers: { Cookie: 'hostile_session=expired-nonsense' } });
    expect(res.status).toBe(200);
  });

  test('only GET and HEAD reach the image; nothing can write to it by id', async () => {
    const me = await member();
    const url = (await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session))).body.user.avatarUrl!;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await getMedia(url, { method, headers: bearerAuth(me.session) });
      expect(res.status, method).toBe(404);
    }
    expect((await getMedia(url)).status).toBe(200);
  });
});

describe('replacing and clearing', () => {
  test('replacing an image deletes the old row, and the old URL stops working', async () => {
    const me = await member();
    const first = await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session));
    const firstUrl = first.body.user.avatarUrl!;

    const second = await put('avatar', REAL_IMAGES.gif87.bytes, bearerAuth(me.session));
    expect(second.status).toBe(200);
    const secondUrl = second.body.user.avatarUrl!;
    expect(secondUrl).not.toBe(firstUrl);

    const rows = await mediaRows(me.id);
    expect(rows).toEqual([{ id: secondUrl.split('/').pop(), kind: 'avatar' }]);
    expect((await getMedia(firstUrl)).status).toBe(404);
    expect((await getMedia(secondUrl)).status).toBe(200);
  });

  test('uploads racing for one account leave exactly one image, the one in use', async () => {
    const me = await member();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => put('avatar', SMALL_PNG.bytes, bearerAuth(me.session))),
    );
    for (const result of results) expect(result.status).toBe(200);

    const user = await api.ctx.db.user.findUniqueOrThrow({ where: { id: me.id } });
    const rows = await mediaRows(me.id);
    expect(rows).toEqual([{ id: user.avatarMediaId, kind: 'avatar' }]);
  });

  test('an upload racing a delete leaves no orphan either way', async () => {
    const me = await member();
    await Promise.all([
      put('avatar', SMALL_PNG.bytes, bearerAuth(me.session)),
      remove('avatar', bearerAuth(me.session)),
      put('avatar', SMALL_PNG.bytes, bearerAuth(me.session)),
      remove('avatar', bearerAuth(me.session)),
    ]);
    const user = await api.ctx.db.user.findUniqueOrThrow({ where: { id: me.id } });
    const rows = await mediaRows(me.id);
    expect(rows.map((r) => r.id)).toEqual(user.avatarMediaId ? [user.avatarMediaId] : []);
  });

  test('delete clears the image and removes the row, and is safe to repeat', async () => {
    const me = await member();
    const url = (await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session))).body.user.avatarUrl!;

    const cleared = await remove('avatar', bearerAuth(me.session));
    expect(cleared.status).toBe(200);
    expect(cleared.body.user.avatarUrl).toBeNull();
    expect(cleared.body.user.createdAt).toEqual(expect.any(String));
    expect(await mediaRows(me.id)).toEqual([]);
    expect((await getMedia(url)).status).toBe(404);

    const again = await remove('avatar', bearerAuth(me.session));
    expect(again.status).toBe(200);
    expect(again.body.user.avatarUrl).toBeNull();
  });
});

describe('refused uploads', () => {
  const refused: [string, Buffer | string, number, string][] = [
    ['HTML', '<!doctype html><script>alert(1)</script>', 415, 'is not a PNG, JPEG, GIF or WebP'],
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg"/>', 415, 'is not a PNG, JPEG, GIF or WebP'],
    ['a cut-off PNG', SMALL_PNG.bytes.subarray(0, 60), 400, 'damaged or incomplete'],
    ['a PNG too wide', buildPng(LIMITS.profileImageMaxEdge + 1, 1), 400, 'pixels on a side'],
  ];

  for (const [name, body, status, message] of refused) {
    test(`${name} is refused with ${status}, and nothing changes`, async () => {
      const me = await member();
      const before = await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session));

      const sent = await put('avatar', body, {
        ...bearerAuth(me.session),
        'Content-Type': 'image/gif',
      });
      expect(sent.status).toBe(status);
      expect(sent.body.error.code).toBe('validation_error');
      expect(sent.body.error.message).toContain(message);

      const user = await api.ctx.db.user.findUniqueOrThrow({ where: { id: me.id } });
      expect(`/api/media/${user.avatarMediaId}`).toBe(before.body.user.avatarUrl);
      expect(await mediaRows(me.id)).toHaveLength(1);
    });
  }

  test('an empty body is refused with a message that says what to do', async () => {
    const me = await member();
    const sent = await put('avatar', Buffer.alloc(0), bearerAuth(me.session));
    expect(sent.status).toBe(400);
    expect(sent.body.error.code).toBe('validation_error');
    expect(sent.body.error.message).toBe('Choose an image to upload.');
  });

  test('a request with no body at all is refused the same way', async () => {
    const me = await member();
    const sent = await put('avatar', null, bearerAuth(me.session));
    expect(sent.status).toBe(400);
    expect(sent.body.error.message).toBe('Choose an image to upload.');
  });

  test('an unknown kind is refused, for upload and for delete', async () => {
    const me = await member();
    const upload = await put('wallpaper', SMALL_PNG.bytes, bearerAuth(me.session));
    expect(upload.status).toBe(400);
    expect(upload.body.error.code).toBe('validation_error');
    const del = await remove('wallpaper', bearerAuth(me.session));
    expect(del.status).toBe(400);
    expect(del.body.error.code).toBe('validation_error');
    expect(await mediaRows(me.id)).toEqual([]);
  });

  test('a compressed body is refused as the client error it is', async () => {
    const me = await member();
    const sent = await put('avatar', SMALL_PNG.bytes, {
      ...bearerAuth(me.session),
      'Content-Encoding': 'gzip',
    });
    expect(sent.status).toBe(415);
    expect(sent.body.error.code).toBe('validation_error');
  });
});

describe('size limits', () => {
  test('an avatar of exactly the limit is accepted, and one byte more is a 413', async () => {
    const me = await member();
    const atLimit = buildPng(64, 64, AVATAR_LIMIT);
    const accepted = await put('avatar', atLimit, bearerAuth(me.session));
    expect(accepted.status).toBe(200);

    const over = await put('avatar', buildPng(64, 64, AVATAR_LIMIT + 1), bearerAuth(me.session));
    expect(over.status).toBe(413);
    expect(over.body.error).toEqual({
      code: 'payload_too_large',
      message: 'That image is too large. An avatar can be up to 5 MB.',
    });
    expect(await mediaRows(me.id)).toHaveLength(1);
  });

  test('the banner has its own, larger limit', async () => {
    const me = await member();
    const atLimit = buildPng(64, 64, LIMITS.bannerMaxBytes);
    const accepted = await put('banner', atLimit, bearerAuth(me.session));
    expect(accepted.status).toBe(200);
    const res = await getMedia(accepted.body.user.bannerUrl!);
    expect(Buffer.from(await res.arrayBuffer()).equals(atLimit)).toBe(true);

    const over = await put(
      'banner',
      buildPng(64, 64, LIMITS.bannerMaxBytes + 1),
      bearerAuth(me.session),
    );
    expect(over.status).toBe(413);
    expect(over.body.error.message).toBe('That image is too large. A banner can be up to 10 MB.');
  });

  test('a body with no length is cut off at the limit too', async () => {
    const me = await member();
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > AVATAR_LIMIT + 1024 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const over = await put('avatar', stream, bearerAuth(me.session), {
      duplex: 'half',
    } as RequestInit);
    expect(over.status).toBe(413);
    expect(over.body.error.code).toBe('payload_too_large');
  });
});

describe('who may upload', () => {
  const tooLarge = buildPng(64, 64, AVATAR_LIMIT + 1);

  test('an unauthenticated upload or delete is refused', async () => {
    for (const body of [SMALL_PNG.bytes, tooLarge]) {
      const sent = await put('avatar', body, {});
      expect(sent.status).toBe(401);
      expect(sent.body.error.code).toBe('unauthenticated');
    }
    const del = await remove('avatar', {});
    expect(del.status).toBe(401);
  });

  test('a bad bearer token is refused', async () => {
    const sent = await put('avatar', SMALL_PNG.bytes, { Authorization: 'Bearer hsa1.nope.nope' });
    expect(sent.status).toBe(401);
  });

  const patchProfile = (headers: Record<string, string>) =>
    fetch(`${api.baseUrl}/api/auth/profile`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nameFont: 'pixel' }),
    });

  test('a cookie session needs the CSRF token, exactly as the profile route does', async () => {
    const me = await member();
    const web: WebSession = await loginWeb(api, me);

    const profile = await patchProfile({ Cookie: web.cookie });
    expect(profile.status).toBe(403);
    const profileBody = (await profile.json()) as Sent['body'];
    expect(profileBody.error.code).toBe('csrf_failed');

    for (const body of [SMALL_PNG.bytes, tooLarge]) {
      const upload = await put('avatar', body, { Cookie: web.cookie });
      expect(upload.status).toBe(403);
      expect(upload.body.error).toEqual(profileBody.error);
    }
    const del = await remove('avatar', { Cookie: web.cookie });
    expect(del.status).toBe(403);
    expect(del.body.error).toEqual(profileBody.error);

    const wrong = await put('avatar', SMALL_PNG.bytes, {
      Cookie: web.cookie,
      'X-CSRF-Token': 'not-the-token',
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('csrf_failed');

    const withToken = await put('avatar', SMALL_PNG.bytes, webAuth(web));
    expect(withToken.status).toBe(200);
    expect(await mediaRows(me.id)).toHaveLength(1);
    expect((await remove('avatar', webAuth(web))).status).toBe(200);
  });

  test('a foreign Origin is refused, exactly as on the profile route', async () => {
    const me = await member();
    const foreign = { ...bearerAuth(me.session), Origin: 'https://evil.example' };

    const profile = await patchProfile(foreign);
    expect(profile.status).toBe(403);
    const profileBody = (await profile.json()) as Sent['body'];
    expect(profileBody.error.code).toBe('origin_not_allowed');

    for (const body of [SMALL_PNG.bytes, tooLarge]) {
      const upload = await put('avatar', body, foreign);
      expect(upload.status).toBe(403);
      expect(upload.body.error).toEqual(profileBody.error);
    }
    const del = await remove('avatar', foreign);
    expect(del.status).toBe(403);
    expect(del.body.error).toEqual(profileBody.error);
    expect(await mediaRows(me.id)).toEqual([]);

    const allowed = { ...bearerAuth(me.session), Origin: TEST_APP_ORIGIN };
    expect((await put('avatar', SMALL_PNG.bytes, allowed)).status).toBe(200);
  });

  test('an upload changes only the uploader, and there is no way to name anyone else', async () => {
    const [alice, bob] = await Promise.all([member(), member()]);
    const before = await put('avatar', SMALL_PNG.bytes, bearerAuth(alice.session));
    const aliceUrl = before.body.user.avatarUrl!;

    const bobUpload = await put('avatar', REAL_IMAGES.gif87.bytes, bearerAuth(bob.session));
    expect(bobUpload.body.user.id).toBe(bob.id);
    const bobDelete = await remove('avatar', bearerAuth(bob.session));
    expect(bobDelete.body.user.id).toBe(bob.id);

    const alicesRow = await api.ctx.db.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(`/api/media/${alicesRow.avatarMediaId}`).toBe(aliceUrl);
    expect((await getMedia(aliceUrl)).status).toBe(200);
    expect(await mediaRows(alice.id)).toHaveLength(1);

    const hijack = await getMedia(aliceUrl, { method: 'DELETE', headers: bearerAuth(bob.session) });
    expect(hijack.status).toBe(404);
    expect((await getMedia(aliceUrl)).status).toBe(200);
  });
});

describe('fan-out', () => {
  const open: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];

  afterEach(() => {
    for (const socket of open.splice(0)) socket.disconnect();
  });

  async function listen(session: DesktopSession) {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(api.baseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      auth: { token: session.accessToken },
    });
    open.push(socket);
    const events: UserPublic[] = [];
    socket.on('member:upserted', (user) => events.push(user));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return events;
  }

  test('other members learn of an upload, a delete and a profile change', async () => {
    const [me, watcher] = await Promise.all([member(), member()]);
    const events = await listen(watcher.session);

    const uploaded = await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session));
    const onUpload = await waitFor('member:upserted after the upload', () => events[0]);
    expect(onUpload.id).toBe(me.id);
    expect(onUpload.avatarUrl).toBe(uploaded.body.user.avatarUrl);
    expect(onUpload).not.toHaveProperty('createdAt');

    await remove('avatar', bearerAuth(me.session));
    const onDelete = await waitFor('member:upserted after the delete', () => events[1]);
    expect(onDelete.avatarUrl).toBeNull();

    await api
      .http()
      .patch('/api/auth/profile')
      .set(bearerAuth(me.session))
      .send({ nameEffect: 'neon' })
      .expect(200);
    const onPatch = await waitFor('member:upserted after the patch', () => events[2]);
    expect(onPatch.nameEffect).toBe('neon');
  });

  test('a refused upload tells nobody', async () => {
    const [me, watcher] = await Promise.all([member(), member()]);
    const events = await listen(watcher.session);
    await put('avatar', 'not an image', bearerAuth(me.session));
    await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session));
    const first = await waitFor('member:upserted after the good upload', () => events[0]);
    expect(first.avatarUrl).not.toBeNull();
    expect(events).toHaveLength(1);
  });
});

describe('profile fields', () => {
  const patch = (session: DesktopSession, body: object) =>
    api.http().patch('/api/auth/profile').set(bearerAuth(session)).send(body);

  test('a new account starts on the defaults', async () => {
    const me = await member();
    const res = await api.http().get('/api/auth/session').set(bearerAuth(me.session));
    expect(res.body.user).toMatchObject({
      avatarUrl: null,
      bannerUrl: null,
      bannerColor: null,
      nameFont: 'default',
      nameEffect: 'none',
      nameColor: null,
      nameColor2: null,
      customStatus: null,
    });
  });

  test('the fields are stored, and reach the other members through the bootstrap', async () => {
    const [me, other] = await Promise.all([member(), member()]);
    const res = await patch(me.session, {
      bannerColor: '#112233',
      nameFont: 'unbounded',
      nameEffect: 'gradient',
      nameColor: '#AABBCC',
      nameColor2: '#00ff00',
    });
    expect(res.status).toBe(200);
    const expected = {
      bannerColor: '#112233',
      nameFont: 'unbounded',
      nameEffect: 'gradient',
      nameColor: '#aabbcc',
      nameColor2: '#00ff00',
    };
    expect(res.body.user).toMatchObject(expected);

    const bootstrap = await api.http().get('/api/bootstrap').set(bearerAuth(other.session));
    const listed = bootstrap.body.members.find((m: { id: string }) => m.id === me.id);
    expect(listed).toMatchObject(expected);
  });

  test('null clears a field, and leaving a field out leaves it alone', async () => {
    const me = await member();
    await patch(me.session, {
      displayName: 'Keeps This',
      bannerColor: '#112233',
      nameColor: '#445566',
      nameColor2: '#778899',
      nameFont: 'mono',
    }).expect(200);

    const res = await patch(me.session, { nameColor: null, nameColor2: null });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      displayName: 'Keeps This',
      bannerColor: '#112233',
      nameColor: null,
      nameColor2: null,
      nameFont: 'mono',
    });

    const untouched = await patch(me.session, {});
    expect(untouched.body.user.bannerColor).toBe('#112233');
  });

  test('a custom status is stored trimmed, reaches the others, and can be cleared', async () => {
    const [me, other] = await Promise.all([member(), member()]);
    const saved = await patch(me.session, { customStatus: '  В игре 🎮  ' });
    expect(saved.status).toBe(200);
    expect(saved.body.user.customStatus).toBe('В игре 🎮');

    const listed = async () => {
      const res = await api.http().get('/api/bootstrap').set(bearerAuth(other.session));
      return res.body.members.find((m: { id: string }) => m.id === me.id).customStatus;
    };
    expect(await listed()).toBe('В игре 🎮');

    await patch(me.session, { nameFont: 'pixel' });
    expect(await listed()).toBe('В игре 🎮');

    await patch(me.session, { customStatus: '   ' });
    expect(await listed()).toBeNull();
    await patch(me.session, { customStatus: 'back' });
    await patch(me.session, { customStatus: null });
    expect(await listed()).toBeNull();
  });

  const invalid: [string, object, string][] = [
    ['a status over the limit', { customStatus: 'x'.repeat(49) }, 'customStatus'],
    ['a status with a line break', { customStatus: 'two\nlines' }, 'customStatus'],
    ['a status that reorders text', { customStatus: 'a\u202Eb' }, 'customStatus'],
    ['a status that is not text', { customStatus: 7 }, 'customStatus'],
    ['a color that is not hex', { bannerColor: 'red' }, 'bannerColor'],
    ['a short hex color', { nameColor: '#fff' }, 'nameColor'],
    ['CSS smuggled into a color', { nameColor2: '#fff;background:url(x)' }, 'nameColor2'],
    ['an unknown font', { nameFont: 'comic-sans' }, 'nameFont'],
    ['an unknown effect', { nameEffect: 'blink' }, 'nameEffect'],
    ['null for a font', { nameFont: null }, 'nameFont'],
    ['null for an effect', { nameEffect: null }, 'nameEffect'],
  ];
  for (const [name, body, path] of invalid) {
    test(`refuses ${name}`, async () => {
      const me = await member();
      const res = await patch(me.session, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(res.body.error.issues.map((i: { path: string }) => i.path)).toContain(path);
    });
  }

  test('refuses a field that is not in the schema, such as the media pointer', async () => {
    const me = await member();
    const res = await patch(me.session, { avatarMediaId: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

describe('the bytes stay out of the way', () => {
  function statementIn(message: Uint8Array): string[] {
    const bytes = Buffer.from(message);
    const start = bytes[0] === 0x50 ? bytes.indexOf(0, 5) + 1 : bytes[0] === 0x51 ? 5 : -1;
    return start < 0 ? [] : [bytes.toString('utf8', start, bytes.indexOf(0, start))];
  }

  async function sqlDuring(action: () => Promise<unknown>): Promise<string[]> {
    const spy = vi.spyOn(PGlite.prototype, 'execProtocolRawSync');
    try {
      await action();
      return spy.mock.calls.flatMap(([message]) => statementIn(message));
    } finally {
      spy.mockRestore();
    }
  }

  test('nothing that maps a user reads the media table, even for a member with images', async () => {
    const [owner, me] = await Promise.all([
      createUser(api.ctx, { role: 'OWNER' }).then(async (user) => ({
        session: await loginDesktop(api, user),
      })),
      member(),
    ]);
    await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session));
    await put('banner', REAL_IMAGES.jpeg.bytes, bearerAuth(me.session));

    const statements = await sqlDuring(async () => {
      await api.http().get('/api/auth/session').set(bearerAuth(me.session)).expect(200);
      await api.http().get('/api/bootstrap').set(bearerAuth(me.session)).expect(200);
      await api.http().get('/api/admin/users').set(bearerAuth(owner.session)).expect(200);
      await api
        .http()
        .patch('/api/auth/profile')
        .set(bearerAuth(me.session))
        .send({ nameFont: 'pixel' })
        .expect(200);
    });

    expect(statements.some((sql) => sql.includes('"users"'))).toBe(true);
    expect(statements.filter((sql) => sql.includes('profile_media'))).toEqual([]);
  });

  test('an upload never reads the bytes back, not even from its own insert', async () => {
    const me = await member();
    await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session));

    const statements = await sqlDuring(() =>
      put('avatar', REAL_IMAGES.gif87.bytes, bearerAuth(me.session)),
    );
    const touchingBytes = statements.filter((sql) => sql.includes('"bytes"'));
    expect(touchingBytes).toHaveLength(1);
    expect(touchingBytes[0]).toMatch(/^INSERT INTO/);
    expect(touchingBytes[0]!.split('RETURNING')[1]).not.toContain('"bytes"');
  });

  test('only serving an image selects the bytes', async () => {
    const me = await member();
    const url = (await put('avatar', SMALL_PNG.bytes, bearerAuth(me.session))).body.user.avatarUrl!;
    const statements = await sqlDuring(() => getMedia(url).then((res) => res.arrayBuffer()));
    expect(statements.filter((sql) => sql.includes('"bytes"'))).toHaveLength(1);
  });
});

describe('location data in a profile image', () => {
  const images = [
    ['avatar', REAL_LOCATED.pillowJpeg],
    ['banner', REAL_LOCATED.appleJpeg],
    ['avatar', REAL_LOCATED.pillowPng],
    ['banner', REAL_LOCATED.pillowWebp],
    ['avatar', REAL_LOCATED.xmpGif],
  ] as const;

  for (const [kind, image] of images) {
    test(`a ${kind} in ${image.type} is stored and served without it`, async () => {
      const me = await member();
      const sent = await put(kind, image.bytes, bearerAuth(me.session));
      expect(sent.status).toBe(200);
      const url = kind === 'avatar' ? sent.body.user.avatarUrl! : sent.body.user.bannerUrl!;
      const served = Buffer.from(await (await getMedia(url)).arrayBuffer());
      expect(served.length).toBe(image.bytes.length);
      expect(served.equals(image.bytes)).toBe(false);
      for (const text of ['Paris', 'France', 'Champ de Mars', 'GPSLatitude']) {
        expect(served.includes(Buffer.from(text)), text).toBe(false);
      }
      if (image.type !== 'image/gif') {
        expect(hasGpsPointer(served)).toBe(false);
        expect(orientationIn(served)).toBe(6);
      }
      const rows = await api.ctx.db.profileMedia.findMany({
        where: { ownerId: me.id },
        select: { byteSize: true },
      });
      expect(rows).toEqual([{ byteSize: image.bytes.length }]);
    });
  }

  test('a turned photo records the size it is drawn at', async () => {
    const me = await member();
    await put('avatar', REAL_LOCATED.appleJpeg.bytes, bearerAuth(me.session));
    const [row] = await api.ctx.db.profileMedia.findMany({
      where: { ownerId: me.id },
      select: { width: true, height: true },
    });
    expect(row).toEqual({ width: 32, height: 64 });
  });

  test('one that does not parse as expected is stored as it came, and logged with no value in it', async () => {
    const warn = vi.spyOn(api.ctx.log, 'warn');
    const me = await member();
    const coordinates = 'lat 48.8584 lon 2.2945';
    const broken = jpegWith(
      jpegSegment(0xe1, Buffer.concat([EXIF_PREFIX, Buffer.from(coordinates, 'latin1')])),
    );
    const sent = await put('avatar', broken, bearerAuth(me.session));
    expect(sent.status).toBe(200);
    const served = Buffer.from(await (await getMedia(sent.body.user.avatarUrl!)).arrayBuffer());
    expect(served.equals(broken)).toBe(true);
    const calls = warn.mock.calls.filter(([fields]) =>
      JSON.stringify(fields).includes('exif_malformed'),
    );
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain('48.8584');
    warn.mockRestore();
  });
});
