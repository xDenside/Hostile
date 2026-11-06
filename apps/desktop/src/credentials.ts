import { mkdirSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import { log, messageOf } from './log.js';

export interface StoredCredential {
  serverUrl: string;
  refreshToken: string;
}

export interface CredentialStore {
  readonly persistent: boolean;
  load(): Promise<StoredCredential | null>;
  save(credential: StoredCredential): Promise<void>;
  clear(): void;
}

type Mode = 'async' | 'sync' | 'memory';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseCredential(json: string): StoredCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { serverUrl, refreshToken } = parsed;
  if (typeof serverUrl !== 'string' || typeof refreshToken !== 'string') return null;
  if (!serverUrl || !refreshToken) return null;
  return { serverUrl, refreshToken };
}

export function createCredentialStore(userDataDir: string): CredentialStore {
  const file = join(userDataDir, 'credentials.bin');
  let mode: Mode | null = null;
  let probing: Promise<Mode> | null = null;
  let memory: StoredCredential | null = null;
  let generation = 0;

  const probe = async (): Promise<Mode> => {
    let detected: Mode;
    try {
      const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null;
      if (backend === 'basic_text') detected = 'memory';
      else if (await safeStorage.isAsyncEncryptionAvailable()) detected = 'async';
      else if (safeStorage.isEncryptionAvailable()) detected = 'sync';
      else detected = 'memory';
    } catch (err) {
      log.warn(`safeStorage unavailable (${messageOf(err)}); keeping credentials in memory only`);
      detected = 'memory';
    }
    if (detected === 'memory') {
      log.warn(
        'No OS-encrypted storage available: the session is kept in memory and made again after every restart.',
      );
    } else {
      log.info(`credential storage: safeStorage (${detected} API)`);
    }
    return detected;
  };

  const detectMode = (): Promise<Mode> => {
    if (mode) return Promise.resolve(mode);
    probing ??= probe().then((detected) => {
      mode = detected;
      probing = null;
      return detected;
    });
    return probing;
  };

  const decrypt = async (blob: Buffer, using: Mode): Promise<string> =>
    using === 'async'
      ? (await safeStorage.decryptStringAsync(blob)).result
      : safeStorage.decryptString(blob);

  const encrypt = async (plain: string, using: Mode): Promise<Buffer> =>
    using === 'async'
      ? await safeStorage.encryptStringAsync(plain)
      : safeStorage.encryptString(plain);

  const removeFile = () => {
    try {
      rmSync(file, { force: true });
      return;
    } catch (err) {
      log.warn(`could not remove the stored credential: ${messageOf(err)}`);
    }
    try {
      truncateSync(file);
    } catch (err) {
      log.warn(
        `the stored credential could not be emptied either (${messageOf(err)}); ` +
          'it will be used again the next time the app starts',
      );
    }
  };

  return {
    get persistent() {
      return mode !== null && mode !== 'memory';
    },

    async load() {
      const using = await detectMode();
      if (memory) return memory;
      if (using === 'memory') return null;
      let blob: Buffer;
      try {
        blob = readFileSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`could not read the stored credential: ${messageOf(err)}`);
        }
        return null;
      }
      if (blob.length === 0) return null;
      try {
        const credential = parseCredential(await decrypt(blob, using));
        if (!credential) {
          log.warn('stored credential is unreadable; removing it');
          removeFile();
        }
        return credential;
      } catch (err) {
        log.warn(`stored credential could not be decrypted (${messageOf(err)}); removing it`);
        removeFile();
        return null;
      }
    },

    async save(credential) {
      const using = await detectMode();
      const mine = ++generation;
      memory = credential;
      if (using === 'memory') return;
      try {
        const blob = await encrypt(JSON.stringify(credential), using);
        if (mine !== generation) return;
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, blob, { mode: 0o600 });
        renameSync(tmp, file);
      } catch (err) {
        if (mine !== generation) return;
        mode = 'memory';
        removeFile();
        log.warn(
          `could not store the credential (${messageOf(err)}); keeping it in memory for this ` +
            'session only, so the next start gets a new one',
        );
      }
    },

    clear() {
      generation++;
      memory = null;
      removeFile();
    },
  };
}
