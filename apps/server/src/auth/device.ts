import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { Db } from '../db.js';
import { hmac, safeEqual, sha256Hex } from './crypto.js';

const CHALLENGE_TTL_MS = 60_000;
const DEVICE_KEY_MAX = 300;

export function isDeviceKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > DEVICE_KEY_MAX || !/^[A-Za-z0-9_-]+$/.test(value))
    return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(value, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

export function deviceToken(secret: string, sessionId: string): string {
  return hmac(secret, `device-session:${sessionId}`);
}

export async function bindDevice(db: Db, secret: string, sessionId: string, deviceKey: string) {
  const token = deviceToken(secret, sessionId);
  await db.$transaction([
    db.session.updateMany({
      where: { deviceKey, id: { not: sessionId } },
      data: { deviceKey: null },
    }),
    db.session.update({
      where: { id: sessionId },
      data: { deviceKey, tokenHash: sha256Hex(token) },
    }),
  ]);
  return token;
}

export class DeviceChallenges {
  private readonly used = new Map<string, number>();

  constructor(private readonly secret: string) {}

  issue(now = Date.now()): string {
    const body = `${now}.${randomBytes(18).toString('base64url')}`;
    return `${body}.${hmac(this.secret, `device-challenge:${body}`)}`;
  }

  consume(challenge: unknown, now = Date.now()): challenge is string {
    if (typeof challenge !== 'string' || challenge.length > 200) return false;
    const parts = challenge.split('.');
    if (parts.length !== 3) return false;
    const body = `${parts[0]}.${parts[1]}`;
    if (!safeEqual(parts[2]!, hmac(this.secret, `device-challenge:${body}`))) return false;
    const issued = Number(parts[0]);
    if (!Number.isFinite(issued) || now - issued > CHALLENGE_TTL_MS || issued - now > 5_000)
      return false;
    for (const [seen, at] of this.used) if (now - at > CHALLENGE_TTL_MS) this.used.delete(seen);
    if (this.used.has(challenge)) return false;
    this.used.set(challenge, now);
    return true;
  }
}

export function signatureHolds(deviceKey: string, challenge: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || signature.length > 200) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(deviceKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      'sha256',
      Buffer.from(challenge, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
