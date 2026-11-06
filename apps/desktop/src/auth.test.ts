import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import type { StoredCredential } from './credentials.js';
import type { Runtime } from './runtime.js';

interface Call {
  url: string;
  body: Record<string, unknown>;
}

let calls: Call[];
let replies: Map<string, { status: number; body: unknown }>;
let lost: Set<string>;
let stored: StoredCredential | null;
let saved: StoredCredential[];
let cleared: number;
let serverUrl: string | null;

const SECRET = 's'.repeat(64);

const runtime = (): Runtime =>
  ({
    credentialScope: () => serverUrl,
    settings: { get: () => ({ serverUrl, shortcuts: { toggleMute: null, toggleDeafen: null } }) },
    credentials: {
      persistent: true,
      load: () => Promise.resolve(stored),
      save: (credential: StoredCredential) => {
        saved.push(credential);
        stored = credential;
        return Promise.resolve();
      },
      clear: () => {
        cleared += 1;
        stored = null;
      },
    },
  }) as unknown as Runtime;

const net = {
  fetch: (url: string, init: { body?: string }) => {
    const path = new URL(url).pathname;
    calls.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
    if (lost.has(path)) {
      lost.delete(path);
      return Promise.reject(new TypeError('network connection was lost'));
    }
    const reply = replies.get(path) ?? { status: 204, body: null };
    return Promise.resolve(
      new Response(reply.body === null ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  },
};

const ownerResponse = {
  user: { id: 'u1', displayName: 'Bob', role: 'owner' },
  accessToken: 'access-token',
  accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  refreshToken: 'refresh-token',
};

const accessResponse = {
  user: ownerResponse.user,
  accessToken: 'access-token-2',
  accessTokenExpiresAt: ownerResponse.accessTokenExpiresAt,
};

mock.module('electron', { namedExports: { net } });
const { log } = await import('./log.js');
for (const level of ['info', 'warn', 'error'] as const) {
  mock.method(log, level, () => undefined);
}
const { createAuthService } = await import('./auth.js');

const service = (secret: string | null = SECRET) => createAuthService(runtime(), () => secret);

beforeEach(() => {
  calls = [];
  replies = new Map();
  lost = new Set();
  saved = [];
  cleared = 0;
  stored = null;
  serverUrl = 'https://a.example.com';
});

describe("the owner's sign-in", () => {
  it('shows the secret to its own server and stores what comes back for that room', async () => {
    replies.set('/api/auth/owner', { status: 200, body: ownerResponse });
    const result = await service().signInAsOwner();
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      {
        url: 'https://a.example.com/api/auth/owner',
        body: { secret: SECRET, client: 'desktop' },
      },
    ]);
    assert.deepEqual(saved, [
      { serverUrl: 'https://a.example.com', refreshToken: 'refresh-token' },
    ]);
  });

  it('hands the renderer neither the secret nor the refresh token', async () => {
    replies.set('/api/auth/owner', { status: 200, body: ownerResponse });
    const result = await service().signInAsOwner();
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes('refresh-token'), false);
  });

  it('asks nothing of a server when this app hosts no room', async () => {
    const result = await service(null).signInAsOwner();
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
  });

  it('does not store a credential for a room the app has left', async () => {
    replies.set('/api/auth/owner', { status: 200, body: ownerResponse });
    const pending = service().signInAsOwner();
    serverUrl = 'https://b.example.com';
    const result = await pending;

    assert.equal(result.ok, false);
    assert.deepEqual(saved, [], 'nothing may be stored for the old address');
    assert.equal(stored, null);
  });
});

describe('ending the session', () => {
  it('presents the refresh token to the server that issued it', async () => {
    stored = { serverUrl: 'https://a.example.com', refreshToken: 'refresh-token' };
    const result = await service().logout();
    assert.equal(result.serverConfirmed, true);
    assert.deepEqual(
      calls.map((call) => call.url),
      ['https://a.example.com/api/auth/logout'],
    );
    assert.deepEqual(calls[0]?.body, { refreshToken: 'refresh-token' });
    assert.equal(cleared, 1);
  });

  it('never sends a token to another server, and does not claim an end it did not get', async () => {
    stored = { serverUrl: 'https://a.example.com', refreshToken: 'refresh-token' };
    serverUrl = 'https://b.example.com';
    const result = await service().logout();

    assert.deepEqual(calls, [], 'the token must not be presented to B');
    assert.equal(result.serverConfirmed, false, 'nothing was revoked, so nothing is claimed');
    assert.equal(cleared, 1, 'this computer lets go of it either way');
  });

  it('reports an end the server could not confirm', async () => {
    stored = { serverUrl: 'https://a.example.com', refreshToken: 'refresh-token' };
    replies.set('/api/auth/logout', { status: 500, body: null });
    const result = await service().logout();
    assert.equal(result.serverConfirmed, false);
    assert.equal(cleared, 1);
  });
});

describe('access token refresh', () => {
  it('discards a credential issued by another server instead of presenting it', async () => {
    stored = { serverUrl: 'https://a.example.com', refreshToken: 'refresh-token' };
    serverUrl = 'https://b.example.com';
    const result = await service(null).refresh();
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
    assert.equal(cleared, 1);
  });

  it('keeps the credential when the server cannot be reached', async () => {
    stored = { serverUrl: 'https://a.example.com', refreshToken: 'refresh-token' };
    replies.set('/api/auth/refresh', { status: 503, body: null });
    const result = await service().refresh();
    assert.equal(result.ok, false);
    assert.equal(cleared, 0, 'a server that is down must not end the session');
    assert.notEqual(stored, null);
    assert.equal(calls.length, 1, 'and the owner exchange is not needed');
  });

  it('survives a lost answer: the same token works on the next try and nothing is rotated', async () => {
    stored = { serverUrl: 'https://a.example.com', refreshToken: 'refresh-token' };
    replies.set('/api/auth/refresh', { status: 200, body: accessResponse });
    lost.add('/api/auth/refresh');

    const auth = service();
    const first = await auth.refresh();
    assert.equal(first.ok, false, 'the answer never arrived');
    assert.equal(cleared, 0, 'and the credential is untouched');

    const second = await auth.refresh();
    assert.equal(second.ok, true);
    assert.deepEqual(saved, [], 'no new refresh token exists to be lost');
    assert.deepEqual(
      calls.map((call) => call.body.refreshToken),
      ['refresh-token', 'refresh-token'],
    );
  });

  it('goes back to the secret when the server has refused the token', async () => {
    stored = { serverUrl: 'https://a.example.com', refreshToken: 'dead-token' };
    replies.set('/api/auth/refresh', { status: 401, body: null });
    replies.set('/api/auth/owner', { status: 200, body: ownerResponse });
    const result = await service().refresh();
    assert.equal(result.ok, true, 'the owner cannot be locked out of their own room');
    assert.equal(stored?.refreshToken, 'refresh-token');
  });

  it('uses the secret when there is no token yet', async () => {
    replies.set('/api/auth/owner', { status: 200, body: ownerResponse });
    const result = await service().refresh();
    assert.equal(result.ok, true);
    assert.deepEqual(
      calls.map((call) => new URL(call.url).pathname),
      ['/api/auth/owner'],
    );
  });
});
