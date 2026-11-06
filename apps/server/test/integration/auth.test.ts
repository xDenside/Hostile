import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  bearerAuth,
  createChannel,
  createUser,
  loginDesktop,
  loginWeb,
  webAuth,
} from '../support/factories.js';
import { resetDatabase, startTestApi, TEST_APP_ORIGIN, type TestApi } from '../support/harness.js';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api?.stop();
});

beforeEach(async () => {
  await resetDatabase(api.ctx);
});

describe('anonymous requests', () => {
  test('cannot read the community or mint a voice token', async () => {
    const channelId = randomUUID();
    const responses = await Promise.all([
      api.http().get('/api/bootstrap'),
      api.http().get(`/api/channels/${channelId}/messages`),
      api.http().get(`/api/channels/${channelId}/changes?since=0`),
      api
        .http()
        .post(`/api/channels/${channelId}/messages`)
        .send({ content: 'hi', clientNonce: randomUUID() }),
      api.http().post('/api/voice/token').send({ channelId }),
      api.http().get('/api/voice/status'),
    ]);
    for (const res of responses) {
      expect(res.status, `${res.request.method} ${res.request.url}`).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    }
  });

  test('cannot reach owner-only endpoints, and neither can a member', async () => {
    const owner = await createUser(api.ctx, { role: 'OWNER' });
    const member = await createUser(api.ctx);

    const anonymous = await api.http().get('/api/admin/users');
    expect(anonymous.status).toBe(401);

    const asMember = await api
      .http()
      .get('/api/admin/users')
      .set(bearerAuth(await loginDesktop(api, member)));
    expect(asMember.status).toBe(403);
    expect(asMember.body.error.code).toBe('forbidden');

    const asOwner = await api
      .http()
      .get('/api/admin/users')
      .set(bearerAuth(await loginDesktop(api, owner)));
    expect(asOwner.status).toBe(200);
  });

  test('public endpoints stay open, because a client must be able to probe the server', async () => {
    const res = await api.http().get('/api/public-config');
    expect(res.status).toBe(200);
    expect(res.body.environment).toBe('test');
  });
});

describe('session revocation', () => {
  test('lists your own sessions, naming this one, and ends another by itself', async () => {
    const user = await createUser(api.ctx);
    const here = await loginWeb(api, user);
    const there = await loginWeb(api, user);
    const stays = await loginWeb(api, user);

    const res = await api.http().get('/api/auth/sessions').set(webAuth(here));
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(3);
    const current = res.body.sessions.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);
    expect(Object.keys(res.body.sessions[0]).sort()).toEqual(
      ['client', 'createdAt', 'current', 'id', 'lastUsedAt', 'userAgent'].sort(),
    );

    const seenByThere = await api.http().get('/api/auth/sessions').set(webAuth(there));
    const thereId = seenByThere.body.sessions.find((s: { current: boolean }) => s.current).id;

    const del = await api.http().delete(`/api/auth/sessions/${thereId}`).set(webAuth(here));
    expect(del.status).toBe(204);
    const ended = await api.http().get('/api/auth/session').set('Cookie', there.cookie);
    expect(ended.status).toBe(401);
    expect((await api.http().get('/api/auth/session').set('Cookie', here.cookie)).status).toBe(200);
    expect((await api.http().get('/api/auth/session').set('Cookie', stays.cookie)).status).toBe(
      200,
    );
    const after = await api.http().get('/api/auth/sessions').set(webAuth(here));
    expect(after.body.sessions).toHaveLength(2);
  });

  test("another member's session looks like one that does not exist", async () => {
    const mine = await loginWeb(api, await createUser(api.ctx));
    const theirs = await loginWeb(api, await createUser(api.ctx));
    const list = await api.http().get('/api/auth/sessions').set(webAuth(theirs));
    const theirId = list.body.sessions[0].id;

    const res = await api.http().delete(`/api/auth/sessions/${theirId}`).set(webAuth(mine));
    expect(res.status).toBe(404);
    const missing = await api
      .http()
      .delete(`/api/auth/sessions/${randomUUID()}`)
      .set(webAuth(mine));
    expect(missing.status).toBe(404);
    expect(res.body.error.message).toBe(missing.body.error.message);
    expect((await api.http().get('/api/auth/session').set('Cookie', theirs.cookie)).status).toBe(
      200,
    );
  });

  test('this session cannot be ended by this route, which would leave its cookie behind', async () => {
    const here = await loginWeb(api, await createUser(api.ctx));
    const list = await api.http().get('/api/auth/sessions').set(webAuth(here));
    const res = await api
      .http()
      .delete(`/api/auth/sessions/${list.body.sessions[0].id}`)
      .set(webAuth(here));
    expect(res.status).toBe(409);
    expect((await api.http().get('/api/auth/session').set('Cookie', here.cookie)).status).toBe(200);
  });

  test('both routes need a session', async () => {
    expect((await api.http().get('/api/auth/sessions')).status).toBe(401);
    const res = await api.http().delete(`/api/auth/sessions/${randomUUID()}`);
    expect([401, 403]).toContain(res.status);
  });

  test('logout-others rejects the other session and keeps the current one', async () => {
    const user = await createUser(api.ctx);
    const keep = await loginWeb(api, user);
    const drop = await loginWeb(api, user);

    const res = await api.http().post('/api/auth/logout-others').set(webAuth(keep));
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(1);

    const dropped = await api.http().get('/api/auth/session').set('Cookie', drop.cookie);
    expect(dropped.status).toBe(401);
    expect(dropped.body.error.code).toBe('session_expired');

    expect((await api.http().get('/api/auth/session').set('Cookie', keep.cookie)).status).toBe(200);
  });

  test('refresh only works for a live desktop session', async () => {
    const user = await createUser(api.ctx);
    const desktop = await loginDesktop(api, user);
    const web = await loginWeb(api, user);

    const fresh = await api
      .http()
      .post('/api/auth/refresh')
      .send({ refreshToken: desktop.refreshToken });
    expect(fresh.status).toBe(200);
    expect(fresh.body.accessToken).toBeTypeOf('string');

    const webCookieValue = web.cookie.slice(web.cookie.indexOf('=') + 1);
    const asWeb = await api.http().post('/api/auth/refresh').send({ refreshToken: webCookieValue });
    expect(asWeb.status).toBe(401);
    expect(asWeb.body.error.code).toBe('session_expired');

    await api
      .http()
      .post('/api/auth/logout')
      .send({ refreshToken: desktop.refreshToken })
      .expect(204);
    const afterLogout = await api
      .http()
      .post('/api/auth/refresh')
      .send({ refreshToken: desktop.refreshToken });
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.error.code).toBe('session_expired');
  });
});

describe('removed people', () => {
  test('removing revokes every session', async () => {
    const owner = await createUser(api.ctx, { role: 'OWNER' });
    const member = await createUser(api.ctx);
    const ownerSession = await loginDesktop(api, owner);
    const memberSession = await loginWeb(api, member);

    const removed = await api
      .http()
      .post(`/api/admin/users/${member.id}/remove`)
      .set(bearerAuth(ownerSession));
    expect(removed.status).toBe(200);
    expect(removed.body.user.disabled).toBe(true);

    const sessions = await api.ctx.db.session.findMany({ where: { userId: member.id } });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(sessions.map((s) => s.revokeReason)).toContain('disabled');

    const stale = await api.http().get('/api/bootstrap').set('Cookie', memberSession.cookie);
    expect(stale.status).toBe(401);
  });

  test('a live session for a removed person is refused, including for voice tokens', async () => {
    const member = await createUser(api.ctx);
    const channel = await createChannel(api.ctx, { type: 'VOICE' });
    const session = await loginDesktop(api, member);
    await api.ctx.db.user.update({ where: { id: member.id }, data: { disabledAt: new Date() } });

    const bootstrap = await api.http().get('/api/bootstrap').set(bearerAuth(session));
    expect(bootstrap.status).toBe(403);
    expect(bootstrap.body.error.code).toBe('account_disabled');

    const token = await api
      .http()
      .post('/api/voice/token')
      .set(bearerAuth(session))
      .send({ channelId: channel.id });
    expect(token.status).toBe(403);
    expect(token.body.error.code).toBe('account_disabled');
  });
});

describe('CSRF and Origin', () => {
  test('a cookie-authenticated unsafe request needs the CSRF header', async () => {
    const user = await createUser(api.ctx);
    const channel = await createChannel(api.ctx, { type: 'TEXT' });
    const session = await loginWeb(api, user);
    const body = { content: 'csrf check', clientNonce: randomUUID() };

    const without = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set('Cookie', session.cookie)
      .send(body);
    expect(without.status).toBe(403);
    expect(without.body.error.code).toBe('csrf_failed');

    const wrong = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', 'not-the-token')
      .send(body);
    expect(wrong.status).toBe(403);

    const correct = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(webAuth(session))
      .send(body);
    expect(correct.status).toBe(201);
  });

  test('a bearer-authenticated unsafe request needs no CSRF header', async () => {
    const user = await createUser(api.ctx);
    const channel = await createChannel(api.ctx, { type: 'TEXT' });
    const session = await loginDesktop(api, user);
    const res = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(bearerAuth(session))
      .send({ content: 'bearer send', clientNonce: randomUUID() });
    expect(res.status).toBe(201);
  });

  test('an unsafe request from an unknown Origin is rejected before authentication', async () => {
    const user = await createUser(api.ctx);
    const channel = await createChannel(api.ctx, { type: 'TEXT' });
    const session = await loginWeb(api, user);
    const body = { content: 'origin check', clientNonce: randomUUID() };

    const foreign = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(webAuth(session))
      .set('Origin', 'http://attacker.example')
      .send(body);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('origin_not_allowed');

    const allowed = await api
      .http()
      .post(`/api/channels/${channel.id}/messages`)
      .set(webAuth(session))
      .set('Origin', TEST_APP_ORIGIN)
      .send(body);
    expect(allowed.status).toBe(201);
    expect(allowed.headers['access-control-allow-origin']).toBe(TEST_APP_ORIGIN);
  });

  test('a cross-origin preflight from an unknown Origin is not granted', async () => {
    const res = await api.http().options('/api/bootstrap').set('Origin', 'http://attacker.example');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('asking works with a session cookie present, and answers with that same person', async () => {
    const person = await createUser(api.ctx);
    const here = await loginWeb(api, person);

    const logout = await api.http().post('/api/auth/logout').set('Cookie', here.cookie).send({});
    expect(logout.status).toBe(403);
    expect(logout.body.error.code).toBe('csrf_failed');

    const usersBefore = await api.ctx.db.user.count();
    const res = await api
      .http()
      .post('/api/join')
      .set('Cookie', here.cookie)
      .send({ nickname: 'X' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('admitted');
    expect(res.body.user.id).toBe(person.id);
    expect(await api.ctx.db.user.count()).toBe(usersBefore);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('the exemption covers every spelling Express routes to the join handler', async () => {
    const stale = await loginWeb(api, await createUser(api.ctx));
    for (const path of ['/api/join/', '/API/Join']) {
      const res = await api.http().post(path).set('Cookie', stale.cookie).send({ nickname: 'X' });
      expect([path, res.status]).toEqual([path, 200]);
    }
  });
});
