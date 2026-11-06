import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { CredentialStore, StoredCredential } from './credentials.js';

const MARKER = 'encrypted:';

const safeStorage = {
  isAsyncEncryptionAvailable: () => Promise.resolve(true),
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'kwallet5',
  encryptStringAsync: (plain: string) => Promise.resolve(Buffer.from(`${MARKER}${plain}`, 'utf8')),
  decryptStringAsync: (blob: Buffer) => {
    const text = blob.toString('utf8');
    if (!text.startsWith(MARKER)) throw new Error('cannot decrypt');
    return Promise.resolve({ result: text.slice(MARKER.length) });
  },
  encryptString: (plain: string) => Buffer.from(`${MARKER}${plain}`, 'utf8'),
  decryptString: (blob: Buffer) => {
    const text = blob.toString('utf8');
    if (!text.startsWith(MARKER)) throw new Error('cannot decrypt');
    return text.slice(MARKER.length);
  },
};

const credential: StoredCredential = {
  serverUrl: 'https://chat.example.com',
  refreshToken: 'refresh-token-for-bob',
};

let dir: string;
let createCredentialStore: (userDataDir: string) => CredentialStore;
let logWarnings: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hostile-credentials-'));
  mock.module('electron', { namedExports: { safeStorage } });
  const log = await import('./log.js');
  logWarnings = [];
  mock.method(log.log, 'warn', (message: string) => {
    logWarnings.push(message);
  });
  mock.method(log.log, 'info', () => undefined);
  ({ createCredentialStore } = await import('./credentials.js'));
});

afterEach(() => {
  mock.reset();
  rmSync(dir, { recursive: true, force: true });
});

describe('credential store', () => {
  it('reads back what it wrote, encrypted', async () => {
    const store = createCredentialStore(dir);
    await store.save(credential);
    assert.deepEqual(await store.load(), credential);
    assert.equal(store.persistent, true);

    assert.deepEqual(await createCredentialStore(dir).load(), credential);
    assert.deepEqual(readdirSync(dir), ['credentials.bin']);
  });

  it('keeps the credential for this session when the write fails', async () => {
    chmodSync(dir, 0o500);
    const store = createCredentialStore(dir);
    await store.save(credential);

    assert.deepEqual(await store.load(), credential);
    assert.equal(store.persistent, false, 'a failed write must not be reported as persistent');
    assert.ok(
      logWarnings.some((message) => message.includes('the next start gets a new one')),
      `the warning must say what actually happens: ${logWarnings.join(' | ')}`,
    );
    chmodSync(dir, 0o700);
  });

  it('does not present an earlier sign-in after a failed write', async () => {
    const first = createCredentialStore(dir);
    await first.save({ serverUrl: 'https://chat.example.com', refreshToken: 'alice-token' });

    chmodSync(dir, 0o500);
    const second = createCredentialStore(dir);
    await second.save(credential);
    const loaded = await second.load();
    chmodSync(dir, 0o700);
    assert.deepEqual(loaded, credential, 'the freshest credential wins over the file');

    assert.equal(await createCredentialStore(dir).load(), null);
  });

  it('does not write back a credential that was cleared while it was being encrypted', async () => {
    const original = safeStorage.encryptStringAsync;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    safeStorage.encryptStringAsync = async (plain: string) => {
      await gate;
      return original(plain);
    };
    try {
      const store = createCredentialStore(dir);
      const saving = store.save(credential);
      await new Promise((resolve) => setImmediate(resolve));
      store.clear();
      release();
      await saving;

      assert.equal(await store.load(), null);
      assert.deepEqual(readdirSync(dir), [], 'nothing may reappear on disk after clear()');
    } finally {
      safeStorage.encryptStringAsync = original;
    }
  });

  it('returns nothing when there is no credential, and drops an unreadable one', async () => {
    const store = createCredentialStore(dir);
    assert.equal(await store.load(), null);

    writeFileSync(join(dir, 'credentials.bin'), 'not something we wrote');
    assert.equal(await createCredentialStore(dir).load(), null);
    assert.deepEqual(readdirSync(dir), [], 'an undecryptable file is removed');
  });

  it('forgets the credential on clear, in memory and on disk', async () => {
    const store = createCredentialStore(dir);
    await store.save(credential);
    store.clear();
    assert.equal(await store.load(), null);
    assert.deepEqual(readdirSync(dir), []);
  });
});
