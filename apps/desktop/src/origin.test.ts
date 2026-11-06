import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isSafeOriginHost, isSameOrigin, originOf, safeOriginOf } from './origin.js';

describe('isSafeOriginHost', () => {
  it('accepts what a parsed host can really contain', () => {
    for (const host of [
      'chat.example.com',
      'srv',
      'localhost:4191',
      '127.0.0.1:4191',
      '[::1]:4191',
      'my_host.internal',
      'xn--bcher-kva.example',
    ]) {
      assert.equal(isSafeOriginHost(host), true, host);
    }
  });

  it('rejects characters that cannot appear in an origin', () => {
    for (const host of ['x;sandbox', 'x,y', "x'y", 'x"y', 'x y', 'x\ty', 'x\ny', 'x/y', 'x*', '']) {
      assert.equal(isSafeOriginHost(host), false, JSON.stringify(host));
    }
  });
});

describe('safeOriginOf', () => {
  it('rebuilds the origin from the parsed parts', () => {
    assert.equal(safeOriginOf('wss://lk.example.com/rtc'), 'wss://lk.example.com');
    assert.equal(safeOriginOf('https://chat.example.com'), 'https://chat.example.com');
    assert.equal(safeOriginOf('http://127.0.0.1:4191'), 'http://127.0.0.1:4191');
    assert.equal(safeOriginOf('hostile://hostile/index.html'), 'hostile://hostile');
  });

  it('refuses a host that could rewrite a policy header', () => {
    assert.equal(safeOriginOf('wss://x;sandbox'), null);
    assert.equal(safeOriginOf('https://evil.example;sandbox'), null);
    assert.equal(safeOriginOf('wss://lk.example.com;'), null);
    assert.equal(safeOriginOf('https://a,b'), null);
    assert.equal(safeOriginOf('not a url'), null);
    assert.equal(safeOriginOf('file:///etc/passwd'), null);
  });
});

describe('originOf and isSameOrigin', () => {
  it('treats the app scheme as a real origin', () => {
    assert.equal(originOf('hostile://hostile/index.html'), 'hostile://hostile');
    assert.equal(isSameOrigin('hostile://hostile/', 'hostile://hostile'), true);
    assert.equal(isSameOrigin('hostile://other/', 'hostile://hostile'), false);
    assert.equal(isSameOrigin(null, 'hostile://hostile'), false);
  });
});
