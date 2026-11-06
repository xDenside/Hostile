import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatRoomCode, parseRoomCode } from '@hostile/shared';
import { log, messageOf } from '../log.js';

export interface HostSecrets {
  sessionSecret: string;
  livekitKey: string;
  livekitSecret: string;
  ownerSecret: string;
  roomCode: string;
  udpPort: number | null;
}

export interface HostSecretStore {
  get(): HostSecrets;
  newRoomCode(): string;
  setUdpPort(port: number): void;
}

const newCode = () => formatRoomCode(randomBytes(16));

function fresh(): HostSecrets {
  return {
    sessionSecret: randomBytes(48).toString('base64url'),
    livekitKey: `host${randomBytes(12).toString('hex')}`,
    livekitSecret: randomBytes(48).toString('base64url'),
    ownerSecret: randomBytes(48).toString('base64url'),
    roomCode: newCode(),
    udpPort: null,
  };
}

function isComplete(value: unknown): value is HostSecrets {
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
    v.ownerSecret.length >= 32 &&
    typeof v.roomCode === 'string' &&
    parseRoomCode(v.roomCode),
  );
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
    if (isComplete(read)) {
      current = read;
      chmodSync(file, 0o600);
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
      secrets = { ...secrets, roomCode: newCode() };
      save(secrets);
      return secrets.roomCode;
    },
    setUdpPort(port) {
      secrets = { ...secrets, udpPort: port };
      save(secrets);
    },
  };
}
