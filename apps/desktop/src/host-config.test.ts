import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { parseRoomCode } from '@hostile/shared';

mock.module('electron', {
  namedExports: { app: { isPackaged: false }, safeStorage: {} },
});

const { renderLivekitConfig } = await import('./host/livekit-config.js');
const { HOST_TRUST_PROXY, hostServerEnv } = await import('./host/server-env.js');
const { createHostSecretStore } = await import('./host/secrets.js');

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

  it('makes secrets once, owner-only, keeps them across opens, and a new code replaces only the code', () => {
    const hostDir = join(dir, 'host');
    const first = createHostSecretStore(hostDir);
    const made = first.get();
    assert.ok(parseRoomCode(made.roomCode));
    assert.equal(statSync(hostDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(hostDir, 'secrets.json')).mode & 0o777, 0o600);
    assert.deepEqual(createHostSecretStore(hostDir).get(), made);
    const code = first.newRoomCode();
    assert.notEqual(code, made.roomCode);
    assert.deepEqual({ ...first.get(), roomCode: '' }, { ...made, roomCode: '' });
    first.setUdpPort(5000);
    assert.equal(createHostSecretStore(hostDir).get().udpPort, 5000);
  });
});
