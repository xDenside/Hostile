import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSecrets, forbiddenPath } from './secret-scan.mjs';

test('refuses files that hold secrets by their nature', () => {
  for (const path of [
    '.env',
    '.env.production',
    'apps/server/.env',
    '.local/generated-credentials.log',
    'backups/hostile-backup.dump',
    'certs/server.key',
    'deploy.pem',
    'keys/id_ed25519',
  ]) {
    assert.ok(forbiddenPath(path), `${path} should be refused`);
  }
});

test('leaves the templates and ordinary files alone', () => {
  for (const path of [
    '.env.example',
    'apps/server/.env.example',
    'apps/web/src/env.ts',
    'keyboard.ts',
    'id_rsa.md',
    'docs/LOCAL.md',
  ]) {
    assert.equal(forbiddenPath(path), null, `${path} should pass`);
  }
});

const SAMPLES = {
  'PEM private key': `-----BEGIN ${'RSA PRIVATE'} KEY-----`,
  'GitHub token': `${'ghp_'}${'a1B2'.repeat(9)}`,
  'AWS access key': `${'AKIA'}${'ABCD2345'.repeat(2)}`,
  'Slack token': `${'xoxb-'}${'1234-abcd-'.repeat(3)}`,
  'npm token': `${'npm_'}${'a1B2'.repeat(9)}`,
  'AI provider key': `${'sk-ant-'}${'a1B2'.repeat(10)}`,
};

test('finds each kind of credential, and says where without saying what', () => {
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const found = findSecrets(`first line\nconst value = "${sample}";\n`);
    assert.deepEqual(found, [{ kind, line: 2 }], kind);
    assert.ok(!JSON.stringify(found).includes(sample), 'the report must not repeat the secret');
  }
});

test('is not set off by what this repository really contains', () => {
  for (const text of [
    'SESSION_SECRET=REPLACE_ME_openssl_rand_base64_32',
    'LIVEKIT_API_SECRET=REPLACE_ME_openssl_rand_hex_24',
    'LIVEKIT_API_KEY=devkey',
    'const re = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;',
    'sk-short',
    'task-runner-with-a-rather-long-name-that-goes-on-and-on',
  ]) {
    assert.deepEqual(findSecrets(text), [], text);
  }
});
