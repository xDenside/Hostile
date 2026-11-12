import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFirstOwner } from '../../src/auth/first-owner.js';
import { loadConfig } from '../../src/config.js';
import { GATEWAY_TOKEN_HEADER } from '../../src/http/gateway-address.js';
import { createUser, createChannel, loginDesktop, sessionCookie } from '../support/factories.js';
import {
  resetDatabase,
  startTestApi,
  TEST_OWNER_SECRET,
  type TestApi,
} from '../support/harness.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});
afterAll(async () => {
  await api.stop();
});
beforeEach(async () => {
  await resetDatabase(api.ctx);
  api.ctx.joinRequests.stop();
});

const ask = (nickname = 'Sam', picture = false) =>
  api.http().post('/api/join').send({ nickname, picture });

async function ownerSession() {
  return loginDesktop(api, await createUser(api.ctx, { role: 'OWNER' }));
}

describe('asking to join', () => {
  it('turned away: no person, session or file exists afterwards, and they may ask again', async () => {
    const owner = await ownerSession();
    const before = await api.ctx.db.user.count();
    const asked = await ask('Sam', true);
    expect(asked.status).toBe(201);
    const { ticket } = asked.body as { ticket: string };
    const uploaded = await api
      .http()
      .put(`/api/join/${ticket}/picture`)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG);
    expect(uploaded.status).toBe(204);
    const list = await api
      .http()
      .get('/api/admin/join-requests')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.body.requests).toHaveLength(1);
    const id = list.body.requests[0].id as string;
    expect(
      (
        await api
          .http()
          .post(`/api/admin/join-requests/${id}/turn-away`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({})
      ).status,
    ).toBe(204);
    expect((await api.http().get(`/api/join/${ticket}`)).body).toEqual({ status: 'turned-away' });
    expect(await api.ctx.db.user.count()).toBe(before);
    expect(await api.ctx.db.profileMedia.count()).toBe(0);
    expect((await ask('Sam')).status).toBe(201);
  });

  it('let in: a person with the picture, and a lost answer gives the same session again', async () => {
    const owner = await ownerSession();
    const { ticket } = (await ask('Sam', true)).body as { ticket: string };
    await api
      .http()
      .put(`/api/join/${ticket}/picture`)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG);
    const id = api.ctx.joinRequests.list()[0]!.id;
    await api
      .http()
      .post(`/api/admin/join-requests/${id}/let-in`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    const first = await api.http().get(`/api/join/${ticket}`);
    const second = await api.http().get(`/api/join/${ticket}`);
    expect(first.body.status).toBe('admitted');
    expect(first.body.user.avatarUrl).toBeTruthy();
    const cookie = sessionCookie(first.headers['set-cookie'] as unknown as string[]);
    expect(sessionCookie(second.headers['set-cookie'] as unknown as string[])).toBe(cookie);
    const session = await api.http().get('/api/auth/session').set('Cookie', cookie);
    expect(session.status).toBe(200);
    expect(session.body.user.displayName).toBe('Sam');
  });

  it('a refused picture ends the attempt, and nothing is held', async () => {
    const { ticket } = (await ask('Sam', true)).body as { ticket: string };
    const refused = await api
      .http()
      .put(`/api/join/${ticket}/picture`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('this is no image'));
    expect(refused.status).toBe(415);
    expect((await api.http().get(`/api/join/${ticket}`)).body).toEqual({ status: 'unknown' });
  });

  it('two people may share a nickname, and each is their own', async () => {
    const owner = await ownerSession();
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const made: string[] = [];
    for (let i = 0; i < 2; i++) {
      await ask('Same name');
      const id = api.ctx.joinRequests.list()[0]!.id;
      await api.http().post(`/api/admin/join-requests/${id}/let-in`).set(auth).send({});
      made.push(id);
    }
    const users = await api.ctx.db.user.findMany({ where: { displayName: 'Same name' } });
    expect(users).toHaveLength(2);
    expect(users[0]!.id).not.toBe(users[1]!.id);
  });

  it('only the owner can see or answer requests', async () => {
    const member = await loginDesktop(api, await createUser(api.ctx));
    await ask('Sam');
    const id = api.ctx.joinRequests.list()[0]!.id;
    const auth = { Authorization: `Bearer ${member.accessToken}` };
    expect((await api.http().get('/api/admin/join-requests').set(auth)).status).toBe(403);
    expect(
      (await api.http().post(`/api/admin/join-requests/${id}/let-in`).set(auth).send({})).status,
    ).toBe(403);
    expect((await api.http().get('/api/admin/join-requests')).status).toBe(401);
  });

  it('someone not let in reaches no room data', async () => {
    await createChannel(api.ctx);
    const refused = [
      '/api/bootstrap',
      '/api/auth/session',
      '/api/admin/users',
      '/api/auth/sessions',
    ];
    for (const path of refused) expect((await api.http().get(path)).status, path).toBe(401);
    expect((await api.http().post('/api/voice/token').send({})).status).toBeGreaterThanOrEqual(401);
    expect((await api.http().get('/api/health')).status).toBe(200);
  });
});

describe('the first owner', () => {
  const NOT_A_PICTURE = new Uint8Array(Buffer.from('this is no image at all'));

  it.each(['avatar', 'banner'] as const)(
    'a refused %s writes nothing, and the next try makes the owner with the good one',
    async (kind) => {
      const { db, log } = api.ctx;
      await expect(
        createFirstOwner(db, log, { displayName: 'Room Host', [kind]: NOT_A_PICTURE }),
      ).rejects.toThrow(/not a PNG/);
      expect(await db.user.count()).toBe(0);

      const owner = await createFirstOwner(db, log, {
        displayName: 'Room Host',
        [kind]: new Uint8Array(PNG),
      });
      expect(owner.role).toBe('OWNER');
      expect(kind === 'avatar' ? owner.avatarMediaId : owner.bannerMediaId).toBeTruthy();
    },
  );
});

describe('the owner exchange', () => {
  it('gives the owner a session for the right secret, and refuses a wrong one', async () => {
    await createUser(api.ctx, { role: 'OWNER' });
    const good = await api
      .http()
      .post('/api/auth/owner')
      .send({ secret: TEST_OWNER_SECRET, client: 'desktop' });
    expect(good.status).toBe(200);
    expect(good.body.user.role).toBe('owner');
    const wrong = await api
      .http()
      .post('/api/auth/owner')
      .send({ secret: 'x'.repeat(TEST_OWNER_SECRET.length), client: 'desktop' });
    expect(wrong.status).toBe(403);
  });
});

describe('sessions do not end by themselves', () => {
  it('a session years old still works, and a refresh does not replace its token', async () => {
    const user = await createUser(api.ctx);
    const session = await loginDesktop(api, user);
    const long_ago = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
    await api.ctx.db.session.updateMany({
      where: { userId: user.id },
      data: { createdAt: long_ago, lastUsedAt: long_ago },
    });
    for (let lostAnswer = 0; lostAnswer < 2; lostAnswer++) {
      const res = await api
        .http()
        .post('/api/auth/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(res.status).toBe(200);
      expect(res.body.refreshToken).toBeUndefined();
    }
  });

  it('removing someone ends them, and their token is refused from then on', async () => {
    const owner = await ownerSession();
    const member = await createUser(api.ctx);
    const session = await loginDesktop(api, member);
    const removed = await api
      .http()
      .post(`/api/admin/users/${member.id}/remove`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    expect(removed.status).toBe(200);
    expect(
      (await api.http().post('/api/auth/refresh').send({ refreshToken: session.refreshToken }))
        .status,
    ).toBe(401);
  });
});

describe('a hosted room believes only its gateway', () => {
  it('refuses to ask without the token, and refuses the owner route with it', () => {
    const base = {
      HOSTILE_ENV: 'production',
      PUBLIC_APP_URL: 'http://127.0.0.1:1',
      DATA_DIR: '/tmp/x',
      SESSION_SECRET: 'a'.repeat(48),
      LIVEKIT_API_KEY: 'hostkey',
      LIVEKIT_API_SECRET: 'b'.repeat(48),
      LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:2',
      LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:2',
      TRUST_PROXY: 'loopback',
      ALLOW_DESKTOP_ORIGIN: 'true',
    };
    expect(() => loadConfig(base)).toThrowError(/only runs inside the host app/);
    expect(() => loadConfig(base, { hosting: true, gatewayToken: 'g'.repeat(40) })).toThrowError(
      /owner secret/,
    );
    expect(() =>
      loadConfig(
        { ...base, JOIN_AUTO_ADMIT: 'true' },
        {
          hosting: true,
          gatewayToken: 'g'.repeat(40),
          ownerSecret: 'o'.repeat(40),
        },
      ),
    ).toThrowError(/JOIN_AUTO_ADMIT/);
    expect(GATEWAY_TOKEN_HEADER).toBe('x-hostile-gateway-token');
  });
});

describe('a guest whose device holds the key', () => {
  const device = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
      key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      sign: (text: string) =>
        sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString(
          'base64url',
        ),
    };
  };
  async function admit(deviceKey?: string) {
    const owner = await ownerSession();
    const asked = await api.http().post('/api/join').send({ nickname: 'Sam', deviceKey });
    const { ticket } = asked.body as { ticket: string };
    const list = await api
      .http()
      .get('/api/admin/join-requests')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    await api
      .http()
      .post(`/api/admin/join-requests/${list.body.requests[0].id as string}/let-in`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    const status = await api.http().get(`/api/join/${ticket}`);
    return { owner, cookie: sessionCookie(status.headers['set-cookie'] as unknown as string[]) };
  }
  async function signIn(d: ReturnType<typeof device>, tamper = false) {
    const { challenge } = (await api.http().post('/api/auth/device/challenge').send({})).body as {
      challenge: string;
    };
    return api
      .http()
      .post('/api/auth/device/sign-in')
      .send({
        deviceKey: d.key,
        challenge,
        signature: d.sign(tamper ? `${challenge}x` : challenge),
      });
  }

  it('signs back in with a fresh challenge, gets the same cookie, and nothing else does', async () => {
    const d = device();
    const { cookie } = await admit(d.key);
    const back = await signIn(d);
    expect(back.status).toBe(200);
    expect(sessionCookie(back.headers['set-cookie'] as unknown as string[])).toBe(cookie);
    expect((await signIn(d, true)).status).toBe(401);
    expect((await signIn(device())).status).toBe(401);
    const { challenge } = (await api.http().post('/api/auth/device/challenge').send({})).body as {
      challenge: string;
    };
    const once = { deviceKey: d.key, challenge, signature: d.sign(challenge) };
    expect((await api.http().post('/api/auth/device/sign-in').send(once)).status).toBe(200);
    expect((await api.http().post('/api/auth/device/sign-in').send(once)).status).toBe(401);
  });

  it('cannot sign in once the host removes the person', async () => {
    const d = device();
    const { owner } = await admit(d.key);
    const user = await api.ctx.db.user.findFirstOrThrow({ where: { role: 'MEMBER' } });
    await api
      .http()
      .post(`/api/admin/users/${user.id}/remove`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    expect((await signIn(d)).status).not.toBe(200);
  });

  it('moves an old stored token onto the key, and in a hosted room the old token stops working', async () => {
    const { cookie } = await admit();
    const legacy = cookie.split('=')[1]!;
    const d = device();
    const config = api.ctx.config as { isProduction: boolean };
    config.isProduction = true;
    try {
      const claimed = await api
        .http()
        .post('/api/auth/device/claim')
        .send({ token: legacy, deviceKey: d.key });
      expect(claimed.status).toBe(200);
    } finally {
      config.isProduction = false;
    }
    expect((await api.http().get('/api/auth/session').set('Cookie', cookie)).status).toBe(401);
    expect((await signIn(d)).status).toBe(200);
  });
});

describe('turning away everyone who asks', () => {
  it('refuses new asks while on, turns away who waits, keeps members in, and lasts until turned off', async () => {
    const owner = await ownerSession();
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const waiting = await ask('Early');
    const { ticket } = waiting.body as { ticket: string };
    const member = await createUser(api.ctx);
    const memberSession = await api.ctx.sessions.create(member, 'WEB', undefined);
    const on = await api
      .http()
      .put('/api/admin/join-requests/closed')
      .set(auth)
      .send({ closed: true });
    expect(on.body).toEqual({ closed: true });
    expect((await api.http().get(`/api/join/${ticket}`)).body).toEqual({ status: 'turned-away' });
    const refused = await ask('Late');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('join_closed');
    expect((await api.ctx.sessions.findByToken(memberSession.token))?.userId).toBe(member.id);
    expect(
      (await api.ctx.db.roomSettings.findUniqueOrThrow({ where: { id: 1 } })).joinRequestsClosed,
    ).toBe(true);
    await api.http().put('/api/admin/join-requests/closed').set(auth).send({ closed: false });
    expect((await ask('Later')).status).toBe(201);
  });
});
