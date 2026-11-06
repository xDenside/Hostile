import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { contentSecurityPolicy, developmentContentSecurityPolicy, type CspInputs } from './csp.js';

const DIRECTIVES = [
  'default-src',
  'script-src',
  'style-src',
  'img-src',
  'media-src',
  'font-src',
  'connect-src',
  'worker-src',
  'object-src',
  'base-uri',
  'frame-ancestors',
];

const directiveNames = (policy: string): string[] =>
  policy.split(';').map((part) => part.trim().split(/\s+/)[0] ?? '');

const connectSrc = (policy: string): string =>
  policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('connect-src ')) ?? '';

const INJECTIONS = [
  'wss://x;sandbox',
  'wss://lk.example.com;',
  'wss://x;upgrade-insecure-requests',
  'wss://a,b',
  "wss://x'y",
  'wss://x"y',
  'wss://x*',
];

describe('contentSecurityPolicy', () => {
  it('names the configured server and its websocket twin', () => {
    const policy = contentSecurityPolicy({
      serverOrigin: 'https://chat.example.com',
      livekitUrl: 'wss://lk.example.com',
    });
    assert.deepEqual(directiveNames(policy), DIRECTIVES);
    assert.equal(
      connectSrc(policy),
      "connect-src 'self' https://chat.example.com wss://chat.example.com " +
        'wss://lk.example.com https://lk.example.com',
    );
  });

  it('allows WebAssembly compilation, and only that, for the noise suppressor', () => {
    const policy = contentSecurityPolicy({ serverOrigin: null, livekitUrl: null });
    assert.ok(policy.includes("script-src 'self' 'wasm-unsafe-eval'"));
    assert.ok(!policy.includes("'unsafe-eval'"));
  });

  it('emits exactly the intended directives before anything is configured', () => {
    const policy = contentSecurityPolicy({ serverOrigin: null, livekitUrl: null });
    assert.deepEqual(directiveNames(policy), DIRECTIVES);
    assert.equal(connectSrc(policy), "connect-src 'self'");
  });

  it('cannot be made to add a directive through the media URL', () => {
    for (const livekitUrl of INJECTIONS) {
      const policy = contentSecurityPolicy({ serverOrigin: 'https://srv.example', livekitUrl });
      assert.deepEqual(directiveNames(policy), DIRECTIVES, livekitUrl);
      assert.equal(
        connectSrc(policy),
        "connect-src 'self' https://srv.example wss://srv.example",
        livekitUrl,
      );
    }
  });

  it('cannot be made to add a directive through the server address', () => {
    for (const host of ['x;sandbox', 'a,b', "x'y", 'x"y', 'x*']) {
      const policy = contentSecurityPolicy({
        serverOrigin: `https://${host}`,
        livekitUrl: 'wss://lk.example.com',
      });
      assert.deepEqual(directiveNames(policy), DIRECTIVES, host);
      assert.equal(
        connectSrc(policy),
        "connect-src 'self' wss://lk.example.com https://lk.example.com",
        host,
      );
    }
  });
});

describe('developmentContentSecurityPolicy', () => {
  it('adds the dev server and nothing else', () => {
    const inputs: CspInputs = { serverOrigin: 'http://127.0.0.1:4191', livekitUrl: null };
    const policy = developmentContentSecurityPolicy(inputs, 'http://127.0.0.1:5190');
    assert.deepEqual(directiveNames(policy), DIRECTIVES);
    assert.ok(
      policy.includes("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' http://127.0.0.1:5190"),
    );
    assert.ok(!policy.includes("'unsafe-eval'"));
    assert.equal(
      connectSrc(policy),
      "connect-src 'self' http://127.0.0.1:5190 ws://127.0.0.1:5190 " +
        'http://127.0.0.1:4191 ws://127.0.0.1:4191',
    );
  });

  it('keeps its directives when a media URL carries a policy of its own', () => {
    const policy = developmentContentSecurityPolicy(
      { serverOrigin: 'http://127.0.0.1:4191', livekitUrl: 'wss://x;sandbox' },
      'http://127.0.0.1:5190',
    );
    assert.deepEqual(directiveNames(policy), DIRECTIVES);
    assert.ok(!policy.includes('sandbox'));
  });
});
