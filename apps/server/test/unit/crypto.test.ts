import { describe, expect, it } from 'vitest';
import { hmac, randomToken, safeEqual, sha256Hex } from '../../src/auth/crypto.js';

describe('hmac, sha256Hex, randomToken and safeEqual', () => {
  it('hmac is stable per (secret, value) and URL-safe', () => {
    expect(hmac('secret', 'a')).toBe(hmac('secret', 'a'));
    expect(hmac('secret', 'a')).not.toBe(hmac('secret', 'b'));
    expect(hmac('secret', 'a')).not.toBe(hmac('other', 'a'));
    expect(hmac('secret', 'a')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sha256Hex hashes UTF-8 input', () => {
    expect(sha256Hex('Алиса')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });

  it('randomToken is URL-safe and unique', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(randomToken());
    expect(randomToken(16)).toHaveLength(22);
  });

  it('safeEqual compares without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'a')).toBe(false);
  });
});
