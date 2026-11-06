import { hmac, safeEqual } from './crypto.js';

export interface AccessTokenClaims {
  sid: string;
  uid: string;
  iat: number;
  exp: number;
}

const PREFIX = 'hsa1';

export function signAccessToken(
  secret: string,
  claims: { sid: string; uid: string },
  ttlSec: number,
  nowMs = Date.now(),
): { token: string; expiresAt: Date } {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSec;
  const payload = Buffer.from(JSON.stringify({ ...claims, iat, exp })).toString('base64url');
  const body = `${PREFIX}.${payload}`;
  return { token: `${body}.${hmac(secret, `access:${body}`)}`, expiresAt: new Date(exp * 1000) };
}

export type AccessTokenResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

export function verifyAccessToken(
  secret: string,
  token: string,
  nowMs = Date.now(),
): AccessTokenResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || token.length > 1024)
    return { ok: false, reason: 'malformed' };
  const body = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(parts[2]!, hmac(secret, `access:${body}`)))
    return { ok: false, reason: 'signature' };
  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as AccessTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof claims.sid !== 'string' ||
    typeof claims.uid !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

export function csrfTokenFor(secret: string, sessionId: string): string {
  return hmac(secret, `csrf:${sessionId}`);
}
