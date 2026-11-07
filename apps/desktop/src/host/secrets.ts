import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatRoomCode,
  ROOM_CODE_BYTES,
  ROOM_CODE_SALT_BYTES,
  roomCodeInput,
} from '@hostile/shared';
import { log, messageOf } from '../log.js';

interface HostIdentity {
  identityPrivateKey: string;
  identityPublicKey: string;
}

export interface HostSecrets extends HostIdentity {
  sessionSecret: string;
  livekitKey: string;
  livekitSecret: string;
  ownerSecret: string;
  codeSalt: string;
  roomCode: string;
  udpPort: number | null;
}

export interface HostSecretStore {
  get(): HostSecrets;
  newRoomCode(): string;
  setUdpPort(port: number): void;
}

type Kept = Omit<HostSecrets, 'codeSalt' | 'roomCode'>;

function rawPublicKey(key: KeyObject) {
  const { x, y } = key.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(x!, 'base64url'),
    Buffer.from(y!, 'base64url'),
  ]).toString('base64url');
}

function newIdentity(): HostIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    identityPrivateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    identityPublicKey: rawPublicKey(publicKey),
  };
}

const newCodeSalt = () => randomBytes(ROOM_CODE_SALT_BYTES).toString('base64url');

export function roomCodeFor(identityPublicKey: string, codeSalt: string) {
  const input = roomCodeInput(
    Buffer.from(identityPublicKey, 'base64url'),
    Buffer.from(codeSalt, 'base64url'),
  );
  return formatRoomCode(createHash('sha256').update(input).digest().subarray(0, ROOM_CODE_BYTES));
}

const withNewCode = (kept: Kept): HostSecrets => {
  const codeSalt = newCodeSalt();
  return { ...kept, codeSalt, roomCode: roomCodeFor(kept.identityPublicKey, codeSalt) };
};

function fresh(): HostSecrets {
  return withNewCode({
    sessionSecret: randomBytes(48).toString('base64url'),
    livekitKey: `host${randomBytes(12).toString('hex')}`,
    livekitSecret: randomBytes(48).toString('base64url'),
    ownerSecret: randomBytes(48).toString('base64url'),
    ...newIdentity(),
    udpPort: null,
  });
}

type Usable = Pick<HostSecrets, 'sessionSecret' | 'livekitKey' | 'livekitSecret' | 'ownerSecret'> &
  Partial<HostSecrets>;

function isUsable(value: unknown): value is Usable {
  const v = value as Partial<HostSecrets> | null;
  return Boolean(
    v &&
    typeof v.sessionSecret === 'string' &&
    v.sessionSecret.length >= 32 &&
    typeof v.livekitKey === 'string' &&
    /^[A-Za-z0-9]+$/.test(v.livekitKey) &&
    typeof v.livekitSecret === 'string' &&
    v.livekitSecret.length >= 32 &&
    typeof v.ownerSecret === 'string' &&
    v.ownerSecret.length >= 32,
  );
}

function hasIdentity(v: Partial<HostIdentity>): v is HostIdentity {
  if (typeof v.identityPrivateKey !== 'string' || typeof v.identityPublicKey !== 'string')
    return false;
  try {
    const key = createPrivateKey({
      key: Buffer.from(v.identityPrivateKey, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    });
    return (
      key.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
      rawPublicKey(createPublicKey(key)) === v.identityPublicKey
    );
  } catch {
    return false;
  }
}

function codeMatches(v: Usable & HostIdentity) {
  return (
    typeof v.codeSalt === 'string' &&
    Buffer.from(v.codeSalt, 'base64url').length === ROOM_CODE_SALT_BYTES &&
    v.roomCode === roomCodeFor(v.identityPublicKey, v.codeSalt)
  );
}

function repaired(read: Usable): HostSecrets {
  return withNewCode({
    sessionSecret: read.sessionSecret,
    livekitKey: read.livekitKey,
    livekitSecret: read.livekitSecret,
    ownerSecret: read.ownerSecret,
    ...(hasIdentity(read)
      ? { identityPrivateKey: read.identityPrivateKey, identityPublicKey: read.identityPublicKey }
      : newIdentity()),
    udpPort: typeof read.udpPort === 'number' ? read.udpPort : null,
  });
}

export function createHostSecretStore(hostDir: string): HostSecretStore {
  const file = join(hostDir, 'secrets.json');
  mkdirSync(hostDir, { recursive: true, mode: 0o700 });
  chmodSync(hostDir, 0o700);

  const save = (secrets: HostSecrets) => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
    renameSync(tmp, file);
  };

  let current: HostSecrets | null = null;
  try {
    const read = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (isUsable(read)) {
      chmodSync(file, 0o600);
      if (hasIdentity(read) && codeMatches(read)) current = read as HostSecrets;
      else {
        current = repaired(read);
        save(current);
        log.info('the room code now names the host key, so this host has a new code');
      }
    } else log.warn('the host secrets file is not usable; this host starts over with new ones');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      log.warn(`could not read the host secrets (${messageOf(err)}); starting over with new ones`);
  }
  if (!current) {
    current = fresh();
    save(current);
  }
  let secrets = current;

  return {
    get: () => ({ ...secrets }),
    newRoomCode() {
      secrets = withNewCode(secrets);
      save(secrets);
      return secrets.roomCode;
    },
    setUdpPort(port) {
      secrets = { ...secrets, udpPort: port };
      save(secrets);
    },
  };
}
