import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';
import { startTunnelGateway } from '../../src/tunnel/gateway.js';

const hosted = {
  HOSTILE_ENV: 'production',
  API_HOST: '127.0.0.1',
  API_PORT: '4300',
  PUBLIC_APP_URL: 'http://127.0.0.1:4300',
  DATA_DIR: '/tmp/hostile-room',
  SESSION_SECRET: 'a'.repeat(48),
  LIVEKIT_API_KEY: 'hostkey',
  LIVEKIT_API_SECRET: 'b'.repeat(48),
  LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:4301',
  LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:4301',
  TRUST_PROXY: 'loopback',
} as NodeJS.ProcessEnv;

const hosting = { hosting: true, gatewayToken: 'c'.repeat(43), ownerSecret: 'd'.repeat(43) };

describe('the hosting rules', () => {
  it('accepts a home host only when the caller asks for them in code', () => {
    const config = loadConfig(hosted, hosting);
    expect(config.hosting).toBe(true);
    expect(config.isProduction).toBe(true);
    expect(config.trustProxy).toBe('loopback');
    expect(config.gatewayToken).toBe(hosting.gatewayToken);
    expect(config.ownerSecret).toBe(hosting.ownerSecret);
    expect(config.joinAutoAdmit).toBe(false);
  });

  it.each([
    ['no token', {}],
    ['a short token', { gatewayToken: 'short' }],
  ])('refuses a hosted room with %s for its gateway', (_name, token) => {
    expect(() =>
      loadConfig(hosted, { hosting: true, ownerSecret: hosting.ownerSecret, ...token }),
    ).toThrow(/gateway token/);
  });

  it.each([
    ['no secret', {}],
    ['a short secret', { ownerSecret: 'short' }],
  ])('refuses a hosted room with %s for its owner', (_name, secret) => {
    expect(() =>
      loadConfig(hosted, { hosting: true, gatewayToken: hosting.gatewayToken, ...secret }),
    ).toThrow(/owner secret/);
  });

  it('leaves an ordinary server without a token, believing whatever its TRUST_PROXY allows', () => {
    const dev = {
      HOSTILE_ENV: 'development',
      PUBLIC_APP_URL: 'http://localhost:5190',
      SESSION_SECRET: 'a'.repeat(48),
    } as NodeJS.ProcessEnv;
    expect(loadConfig(dev).gatewayToken).toBeNull();
  });

  it('cannot be reached from the environment of an ordinary server', () => {
    for (const extra of [{}, { HOSTING: 'true', HOSTILE_HOSTING: '1', HOSTING_MODE: '1' }]) {
      expect(() => loadConfig({ ...hosted, ...extra } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    }
  });

  it.each([
    ['TRUST_PROXY', 'false'],
    ['TRUST_PROXY', ''],
    ['API_HOST', '0.0.0.0'],
    ['PUBLIC_APP_URL', 'https://example.com'],
    ['LIVEKIT_PUBLIC_URL', 'wss://example.com'],
    ['RATE_LIMIT_DISABLED', 'true'],
    ['JOIN_AUTO_ADMIT', 'true'],
    ['OWNER_SECRET', 'e'.repeat(43)],
    ['HOSTILE_ENV', 'development'],
  ])('refuses %s=%s when hosting', (name, value) => {
    expect(() => loadConfig({ ...hosted, [name]: value }, hosting)).toThrow(ConfigError);
  });

  it.each([[false], [true], [1], ['true'], ['']])(
    'the gateway refuses a room server with TRUST_PROXY %s',
    async (roomTrustProxy) => {
      await expect(
        startTunnelGateway({
          roomUrl: 'http://127.0.0.1:1',
          livekitUrl: null,
          origin: 'http://127.0.0.1:1',
          secret: 'x',
          roomTrustProxy,
          roomToken: 'x',
        }),
      ).rejects.toThrow(/TRUST_PROXY=loopback/);
    },
  );

  it('the gateway refuses to start with no token for the room server', async () => {
    await expect(
      startTunnelGateway({
        roomUrl: 'http://127.0.0.1:1',
        livekitUrl: null,
        origin: 'http://127.0.0.1:1',
        secret: 'x',
        roomTrustProxy: 'loopback',
        roomToken: '',
      }),
    ).rejects.toThrow(/token/);
  });
});
