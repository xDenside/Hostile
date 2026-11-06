import { describe, expect, it } from 'vitest';
import { csrfTokenFor, signAccessToken, verifyAccessToken } from '../../src/auth/access-token.js';
import { hmac } from '../../src/auth/crypto.js';

const SECRET = 'x9f2Kq7Lm4Rz8Tv1Bn6Cw3Hy5Jd0Ps2Ae';
const OTHER_SECRET = 'Qz4Vb8Nm2Kc6Xy1Hf9Tr3Ws7Pd5Lg0Ja';
const CLAIMS = {
  sid: '0192d5b0-0000-7000-8000-000000000001',
  uid: '0192d5b0-0000-7000-8000-000000000002',
};
const NOW = 1_770_000_000_000;

function signRaw(secret: string, payloadJson: string): string {
  const body = `hsa1.${Buffer.from(payloadJson).toString('base64url')}`;
  return `${body}.${hmac(secret, `access:${body}`)}`;
}

describe('signAccessToken', () => {
  it('produces a verifiable token with the requested lifetime', () => {
    const { token, expiresAt } = signAccessToken(SECRET, CLAIMS, 600, NOW);
    expect(token.startsWith('hsa1.')).toBe(true);
    expect(token.split('.')).toHaveLength(3);
    expect(expiresAt.getTime()).toBe(NOW + 600_000);

    const result = verifyAccessToken(SECRET, token, NOW);
    expect(result).toEqual({
      ok: true,
      claims: { ...CLAIMS, iat: NOW / 1000, exp: NOW / 1000 + 600 },
    });
  });

  it('carries only the session and user id', () => {
    const { token } = signAccessToken(SECRET, CLAIMS, 600, NOW);
    const result = verifyAccessToken(SECRET, token, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.claims).sort()).toEqual(['exp', 'iat', 'sid', 'uid']);
  });
});

describe('verifyAccessToken', () => {
  it('rejects a tampered payload as a signature failure', () => {
    const { token } = signAccessToken(SECRET, CLAIMS, 600, NOW);
    const [prefix, payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...CLAIMS, uid: 'attacker', iat: NOW / 1000, exp: NOW / 1000 + 600 }),
    ).toString('base64url');
    expect(forged).not.toBe(payload);
    expect(verifyAccessToken(SECRET, `${prefix}.${forged}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('rejects a tampered signature', () => {
    const { token } = signAccessToken(SECRET, CLAIMS, 600, NOW);
    const [prefix, payload, sig] = token.split('.');
    const flipped = `${sig!.slice(0, -1)}${sig!.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyAccessToken(SECRET, `${prefix}.${payload}.${flipped}`, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = signAccessToken(OTHER_SECRET, CLAIMS, 600, NOW);
    expect(verifyAccessToken(SECRET, token, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects an expired token, including exactly at the expiry instant', () => {
    const { token } = signAccessToken(SECRET, CLAIMS, 60, NOW);
    expect(verifyAccessToken(SECRET, token, NOW + 59_000).ok).toBe(true);
    expect(verifyAccessToken(SECRET, token, NOW + 60_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyAccessToken(SECRET, token, NOW + 3_600_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects malformed input without throwing', () => {
    const malformed = [
      '',
      '.',
      'garbage',
      'hsa1.only-two-parts',
      'hsa1.a.b.c',
      'xxxx.abc.def',
      `hsa1.${'a'.repeat(1100)}.sig`,
    ];
    for (const token of malformed) {
      expect(verifyAccessToken(SECRET, token, NOW), token).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('rejects a correctly signed token whose payload is not JSON claims', () => {
    expect(verifyAccessToken(SECRET, signRaw(SECRET, 'not json at all'), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyAccessToken(SECRET, signRaw(SECRET, '"a string"'), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a correctly signed token with missing or mistyped claims', () => {
    const exp = NOW / 1000 + 600;
    const bad = [
      JSON.stringify({ uid: 'u', exp }),
      JSON.stringify({ sid: 's', exp }),
      JSON.stringify({ sid: 's', uid: 'u' }),
      JSON.stringify({ sid: 1, uid: 'u', exp }),
      JSON.stringify({ sid: 's', uid: 'u', exp: `${exp}` }),
    ];
    for (const payload of bad) {
      expect(verifyAccessToken(SECRET, signRaw(SECRET, payload), NOW), payload).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});

describe('csrfTokenFor', () => {
  it('is stable for one session', () => {
    expect(csrfTokenFor(SECRET, 'session-a')).toBe(csrfTokenFor(SECRET, 'session-a'));
  });

  it('differs between sessions and between secrets', () => {
    expect(csrfTokenFor(SECRET, 'session-a')).not.toBe(csrfTokenFor(SECRET, 'session-b'));
    expect(csrfTokenFor(SECRET, 'session-a')).not.toBe(csrfTokenFor(OTHER_SECRET, 'session-a'));
  });

  it('is URL-safe, so it survives headers and query strings', () => {
    expect(csrfTokenFor(SECRET, 'session-a')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
