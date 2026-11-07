import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { parseRoomCode, roomCodeInput } from '@hostile/shared';

mock.module('electron', {
  namedExports: { app: { isPackaged: false }, safeStorage: {} },
});

const { renderLivekitConfig } = await import('./host/livekit-config.js');
const { HOST_TRUST_PROXY, hostServerEnv } = await import('./host/server-env.js');
const { createHostSecretStore, roomCodeFor } = await import('./host/secrets.js');

const KNOWN_KEY = Buffer.from([4, ...Array.from({ length: 64 }, (_, i) => i + 1)]);
const KNOWN_SALT = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xa0 + i));
const KNOWN_CODE = 'A4N3G-NB092-0C2YQ-RH1FE-GNR5Q-8GH8';

async function commitment(publicKey: string, salt: string) {
  const input = roomCodeInput(Buffer.from(publicKey, 'base64url'), Buffer.from(salt, 'base64url'));
  const hash = await crypto.subtle.digest('SHA-256', input);
  return Buffer.from(hash).subarray(0, 16).toString('hex');
}

async function assertCodeNamesKey(secrets: {
  identityPublicKey: string;
  codeSalt: string;
  roomCode: string;
}) {
  assert.equal(
    parseRoomCode(secrets.roomCode),
    await commitment(secrets.identityPublicKey, secrets.codeSalt),
  );
}

describe('a hosted room', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostile-secrets-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('ties TRUST_PROXY to the gateway: the server is told loopback, or it would not start', () => {
    assert.equal(HOST_TRUST_PROXY, 'loopback');
    const env = hostServerEnv('/data', { api: 1, livekit: 2, gateway: 3 });
    assert.equal(env.TRUST_PROXY, 'loopback');
    assert.equal(env.API_HOST, '127.0.0.1');
  });

  it('says in its own words why macOS is asked about the local network', () => {
    const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
    assert.match(builder, /^ {4}NSLocalNetworkUsageDescription: \S.* local network /m);
  });

  it('keeps signalling on loopback, one UDP port, no TCP fallback, and the external address on', () => {
    const yaml = renderLivekitConfig({ port: 11, udpPort: 22, key: 'k', secret: 's', apiPort: 33 });
    for (const line of [
      'port: 11',
      '  - "127.0.0.1"',
      '  udp_port: 22',
      '  tcp_port: 0',
      '  use_external_ip: true',
      '  use_ice_lite: false',
      '  k: s',
      '    - "http://127.0.0.1:33/api/livekit/webhook"',
      '  enabled: false',
    ]) {
      assert.ok(yaml.split('\n').includes(line), line);
    }
  });

  it('gives the same 16 code bytes from node:crypto as from WebCrypto, and a code that reads back', async () => {
    const code = roomCodeFor(KNOWN_KEY.toString('base64url'), KNOWN_SALT.toString('base64url'));
    assert.equal(code, KNOWN_CODE);
    assert.equal(parseRoomCode(code), '512a3855604880c17af8885ee85705ba');
    assert.equal(
      parseRoomCode(code),
      await commitment(KNOWN_KEY.toString('base64url'), KNOWN_SALT.toString('base64url')),
    );
  });

  it('makes secrets once, owner-only, keeps them across opens, and a new code replaces only the salt and code', async () => {
    const hostDir = join(dir, 'host');
    const first = createHostSecretStore(hostDir);
    const made = first.get();
    assert.ok(parseRoomCode(made.roomCode));
    assert.equal(Buffer.from(made.identityPublicKey, 'base64url').length, 65);
    assert.equal(Buffer.from(made.codeSalt, 'base64url').length, 32);
    await assertCodeNamesKey(made);
    const signer = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(made.identityPrivateKey, 'base64url'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const verifier = await crypto.subtle.importKey(
      'raw',
      Buffer.from(made.identityPublicKey, 'base64url'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const words = new TextEncoder().encode('signed by the host');
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, words);
    assert.ok(
      await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, signature, words),
    );
    assert.equal(statSync(hostDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(hostDir, 'secrets.json')).mode & 0o777, 0o600);
    assert.deepEqual(createHostSecretStore(hostDir).get(), made);
    const code = first.newRoomCode();
    const renewed = first.get();
    assert.notEqual(code, made.roomCode);
    assert.notEqual(renewed.codeSalt, made.codeSalt);
    assert.equal(renewed.identityPrivateKey, made.identityPrivateKey);
    await assertCodeNamesKey(renewed);
    assert.deepEqual(
      { ...renewed, roomCode: '', codeSalt: '' },
      { ...made, roomCode: '', codeSalt: '' },
    );
    assert.deepEqual(createHostSecretStore(hostDir).get(), renewed);
    first.setUdpPort(5000);
    assert.equal(createHostSecretStore(hostDir).get().udpPort, 5000);
  });

  it('upgrades a file from before the host key, keeping every other secret', async () => {
    const hostDir = join(dir, 'old');
    mkdirSync(hostDir, { recursive: true });
    const old = {
      sessionSecret: 's'.repeat(64),
      livekitKey: 'hostabc123',
      livekitSecret: 'l'.repeat(64),
      ownerSecret: 'o'.repeat(64),
      roomCode: KNOWN_CODE,
      udpPort: 7000,
    };
    writeFileSync(join(hostDir, 'secrets.json'), JSON.stringify(old), { mode: 0o644 });
    const upgraded = createHostSecretStore(hostDir).get();
    assert.deepEqual(
      {
        sessionSecret: upgraded.sessionSecret,
        livekitKey: upgraded.livekitKey,
        livekitSecret: upgraded.livekitSecret,
        ownerSecret: upgraded.ownerSecret,
        udpPort: upgraded.udpPort,
      },
      {
        sessionSecret: old.sessionSecret,
        livekitKey: old.livekitKey,
        livekitSecret: old.livekitSecret,
        ownerSecret: old.ownerSecret,
        udpPort: old.udpPort,
      },
    );
    assert.notEqual(upgraded.roomCode, old.roomCode);
    await assertCodeNamesKey(upgraded);
    assert.equal(statSync(join(hostDir, 'secrets.json')).mode & 0o777, 0o600);
    assert.deepEqual(createHostSecretStore(hostDir).get(), upgraded);
  });

  it('gives a code that no longer matches its key a new salt, and keeps the key', async () => {
    const hostDir = join(dir, 'mismatch');
    const made = createHostSecretStore(hostDir).get();
    writeFileSync(
      join(hostDir, 'secrets.json'),
      JSON.stringify({ ...made, roomCode: KNOWN_CODE }),
      { mode: 0o600 },
    );
    const repaired = createHostSecretStore(hostDir).get();
    assert.equal(repaired.identityPrivateKey, made.identityPrivateKey);
    assert.equal(repaired.ownerSecret, made.ownerSecret);
    assert.notEqual(repaired.codeSalt, made.codeSalt);
    assert.notEqual(repaired.roomCode, KNOWN_CODE);
    await assertCodeNamesKey(repaired);
  });
});
