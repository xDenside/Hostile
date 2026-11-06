import { describe, expect, it } from 'vitest';
import { BRAND, DESKTOP_ORIGIN } from '@hostile/shared';
import { join, resolve } from 'node:path';
import { ConfigError, loadConfig } from '../../src/config.js';
import { DEFAULT_DATA_DIR } from '../../src/env.js';

const SECRET = 'x9f2Kq7Lm4Rz8Tv1Bn6Cw3Hy5Jd0Ps2Ae';
const LK_SECRET = 'Qz4Vb8Nm2Kc6Xy1Hf9Tr3Ws7Pd5Lg0Ja';

function devEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOSTILE_ENV: 'development',
    PUBLIC_APP_URL: 'http://localhost:5190',
    SESSION_SECRET: SECRET,
    ...over,
  };
}

function prodEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOSTILE_ENV: 'production',
    API_HOST: '127.0.0.1',
    PUBLIC_APP_URL: 'http://127.0.0.1:4300',
    DATA_DIR: '/srv/hostile',
    SESSION_SECRET: SECRET,
    TRUST_PROXY: 'loopback',
    LIVEKIT_API_KEY: 'APIz7Qk3Vm9Ld2',
    LIVEKIT_API_SECRET: LK_SECRET,
    LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:7880',
    LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:7880',
    ...over,
  };
}

const HOSTING = { hosting: true, gatewayToken: 'g'.repeat(43), ownerSecret: 'o'.repeat(43) };
const loadHosted = (env: NodeJS.ProcessEnv) => loadConfig(env, HOSTING);

function problems(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env, env.HOSTILE_ENV === 'production' ? HOSTING : {});
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
  throw new Error('expected loadConfig to reject this configuration');
}

function expectProblem(env: NodeJS.ProcessEnv, pattern: RegExp): void {
  const list = problems(env);
  expect(
    list.some((p) => pattern.test(p)),
    `no problem matching ${pattern} in ${JSON.stringify(list)}`,
  ).toBe(true);
}

describe('loadConfig: the name of the server', () => {
  it('is Hostile when nobody has chosen one', () => {
    expect(loadConfig(devEnv()).communityName).toBe('Hostile');
    expect(loadHosted(prodEnv()).communityName).toBe('Hostile');
    expect(loadConfig(devEnv({ COMMUNITY_NAME: 'The Basement' })).communityName).toBe(
      'The Basement',
    );
  });
});

describe('loadConfig: data folder', () => {
  it('defaults to the git-ignored .local directory in the repository, outside production', () => {
    expect(loadConfig(devEnv()).dataDir).toBe(DEFAULT_DATA_DIR);
    expect(DEFAULT_DATA_DIR.endsWith(join('.local', 'data'))).toBe(true);
    expect(loadConfig(devEnv({ DATA_DIR: '' })).dataDir).toBe(DEFAULT_DATA_DIR);
  });

  it('takes the variable, as an absolute path', () => {
    expect(loadHosted(prodEnv({ DATA_DIR: '/srv/room' })).dataDir).toBe('/srv/room');
    expect(loadConfig(devEnv({ DATA_DIR: 'relative' })).dataDir).toBe(resolve('relative'));
  });

  it('has to be named in production, where there is no repository to default to', () => {
    expectProblem(prodEnv({ DATA_DIR: '' }), /DATA_DIR/);
  });
});

describe('loadConfig: uploads directory', () => {
  it('defaults to uploads/ inside the data folder', () => {
    expect(loadConfig(devEnv()).uploadsDir).toBe(join(DEFAULT_DATA_DIR, 'uploads'));
    expect(loadHosted(prodEnv()).uploadsDir).toBe(join('/srv/hostile', 'uploads'));
    expect(loadConfig(devEnv({ UPLOADS_DIR: '' })).uploadsDir).toBe(
      join(DEFAULT_DATA_DIR, 'uploads'),
    );
  });

  it('takes the variable, as an absolute path', () => {
    expect(loadHosted(prodEnv({ UPLOADS_DIR: '/srv/uploads' })).uploadsDir).toBe('/srv/uploads');
    expect(loadConfig(devEnv({ UPLOADS_DIR: 'relative' })).uploadsDir).toBe(resolve('relative'));
  });
});

describe('loadConfig: accepted configurations', () => {
  it('accepts the local development defaults', () => {
    const cfg = loadConfig(devEnv());
    expect(cfg.env).toBe('development');
    expect(cfg.isProduction).toBe(false);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(4191);
    expect(cfg.publicAppUrl).toBe('http://localhost:5190');
    expect(cfg.livekit.configured).toBe(false);
  });

  it('accepts a complete production configuration', () => {
    const cfg = loadHosted(prodEnv());
    expect(cfg.isProduction).toBe(true);
    expect(cfg.livekit.configured).toBe(true);
    expect(cfg.livekit.publicUrl).toBe('ws://127.0.0.1:7880');
    expect(
      loadHosted(prodEnv({ LIVEKIT_INTERNAL_URL: 'ws://127.0.0.1:7880' })).livekit.internalUrl,
    ).toBe('http://127.0.0.1:7880');
  });

  it('parses TRUST_PROXY into the three shapes Express accepts', () => {
    expect(loadConfig(devEnv()).trustProxy).toBe(false);
    expect(loadConfig(devEnv({ TRUST_PROXY: 'true' })).trustProxy).toBe(true);
    expect(loadConfig(devEnv({ TRUST_PROXY: '1' })).trustProxy).toBe(1);
    expect(loadConfig(devEnv({ TRUST_PROXY: 'loopback' })).trustProxy).toBe('loopback');
  });
});

describe('loadConfig: allowed origins', () => {
  it('always contains the app origin and the desktop origin', () => {
    expect(loadConfig(devEnv()).allowedOrigins).toEqual(
      expect.arrayContaining(['http://localhost:5190', DESKTOP_ORIGIN]),
    );
    expect(loadHosted(prodEnv()).allowedOrigins).toEqual(
      expect.arrayContaining(['http://127.0.0.1:4300', DESKTOP_ORIGIN]),
    );
  });

  it('drops the desktop origin when ALLOW_DESKTOP_ORIGIN is off', () => {
    const cfg = loadConfig(devEnv({ ALLOW_DESKTOP_ORIGIN: 'false' }));
    expect(cfg.allowedOrigins).not.toContain(DESKTOP_ORIGIN);
    expect(cfg.allowedOrigins).toEqual(['http://localhost:5190']);
  });

  it('reduces extra entries to origins and de-duplicates them', () => {
    const cfg = loadConfig(
      devEnv({ ALLOWED_ORIGINS: ' http://127.0.0.1:5190/some/path , http://localhost:5190 ' }),
    );
    expect(cfg.allowedOrigins).toEqual([
      'http://localhost:5190',
      'http://127.0.0.1:5190',
      DESKTOP_ORIGIN,
    ]);
  });

  it('rejects entries that are not origins', () => {
    expectProblem(devEnv({ ALLOWED_ORIGINS: 'not-a-url' }), /not a valid origin/);
  });

  it('rejects a plain-http allowed origin in production', () => {
    expectProblem(
      prodEnv({ ALLOWED_ORIGINS: 'http://legacy.example.com' }),
      /is not https in production/,
    );
    expect(() => loadHosted(prodEnv({ ALLOWED_ORIGINS: 'http://127.0.0.1:4400' }))).not.toThrow();
  });
});

describe('loadConfig: production refuses development settings', () => {
  it('refuses to run at all without hosting: a server of its own has no code', () => {
    const complete = prodEnv({
      PUBLIC_APP_URL: 'https://chat.example.com',
      LIVEKIT_PUBLIC_URL: 'wss://turn.example.com',
    });
    expect(() => loadConfig(complete)).toThrow(/only runs inside the host app/);
    expect(() => loadConfig(prodEnv())).toThrow(/only runs inside the host app/);
  });

  it('refuses the test-only ways in, which keep working where there is no code', () => {
    expectProblem(prodEnv({ JOIN_AUTO_ADMIT: 'true' }), /JOIN_AUTO_ADMIT is not allowed/);
    expectProblem(prodEnv({ OWNER_SECRET: 'o'.repeat(43) }), /OWNER_SECRET is not allowed/);
    expect(loadConfig(devEnv({ JOIN_AUTO_ADMIT: 'true' })).joinAutoAdmit).toBe(true);
    expect(loadConfig(devEnv({ OWNER_SECRET: 'o'.repeat(43) })).ownerSecret).toBe('o'.repeat(43));
    expect(loadConfig(devEnv()).joinAutoAdmit).toBe(false);
  });

  it('refuses a LiveKit URL that could not be written into a CSP header', () => {
    expectProblem(
      prodEnv({ LIVEKIT_PUBLIC_URL: 'ws://127.0.0.1:7880;' }),
      /must not contain whitespace/,
    );
    expectProblem(
      devEnv({ LIVEKIT_PUBLIC_URL: "ws://localhost:17890 'unsafe-inline'" }),
      /must not contain whitespace/,
    );
  });

  it('refuses a partially configured LiveKit', () => {
    expectProblem(prodEnv({ LIVEKIT_PUBLIC_URL: '' }), /LiveKit must be fully configured/);
    expectProblem(prodEnv({ LIVEKIT_API_KEY: '' }), /LiveKit must be fully configured/);
  });

  it('refuses short secrets', () => {
    expectProblem(prodEnv({ SESSION_SECRET: 'too-short' }), /SESSION_SECRET must be at least 32/);
    expectProblem(devEnv({ SESSION_SECRET: 'too-short' }), /SESSION_SECRET must be at least 32/);
    expectProblem(
      prodEnv({ LIVEKIT_API_SECRET: 'devsecret' }),
      /LIVEKIT_API_SECRET must be at least 32/,
    );
  });

  it('refuses placeholder secrets', () => {
    expectProblem(
      prodEnv({ SESSION_SECRET: 'change-me-change-me-change-me-change-me' }),
      /SESSION_SECRET still has a development\/placeholder value/,
    );
    expectProblem(
      prodEnv({ LIVEKIT_API_SECRET: 'dev-only-dev-only-dev-only-dev-only' }),
      /LIVEKIT_API_SECRET still has a development\/placeholder value/,
    );
    expectProblem(
      prodEnv({ LIVEKIT_API_KEY: 'devkey' }),
      /LIVEKIT_API_KEY still has a development\/placeholder value/,
    );
  });

  it('refuses RATE_LIMIT_DISABLED', () => {
    expectProblem(
      prodEnv({ RATE_LIMIT_DISABLED: 'true' }),
      /RATE_LIMIT_DISABLED is not allowed in production/,
    );
    expect(loadConfig(devEnv({ RATE_LIMIT_DISABLED: 'true' })).rateLimitDisabled).toBe(true);
  });
});

describe('loadConfig: development host binding', () => {
  it('refuses a non-loopback API_HOST, with no way round it', () => {
    expectProblem(devEnv({ API_HOST: '0.0.0.0' }), /is not a loopback address/);
    expectProblem(devEnv({ API_HOST: '192.168.1.20' }), /is not a loopback address/);
    expectProblem(devEnv({ API_HOST: '0.0.0.0', LAN_MODE: 'true' }), /is not a loopback address/);
  });

  it('accepts loopback addresses', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(loadConfig(devEnv({ API_HOST: host })).host).toBe(host);
    }
  });
});

describe('loadConfig: session cookie', () => {
  it('uses an unprefixed insecure cookie in development', () => {
    expect(loadConfig(devEnv()).cookie).toEqual({ name: `${BRAND.slug}_session`, secure: false });
  });

  it('uses a __Host- prefixed Secure cookie in production', () => {
    expect(loadHosted(prodEnv()).cookie).toEqual({
      name: `__Host-${BRAND.slug}_session`,
      secure: true,
    });
  });
});

describe('loadConfig: schema failures', () => {
  it('reports every missing required variable at once', () => {
    const list = problems({ HOSTILE_ENV: 'development' });
    expect(list.join('\n')).toMatch(/PUBLIC_APP_URL/);
    expect(list.join('\n')).toMatch(/SESSION_SECRET/);
  });

  it('rejects an unknown environment name', () => {
    expectProblem({ ...devEnv(), HOSTILE_ENV: 'staging' }, /HOSTILE_ENV/);
  });

  it('rejects out-of-range numbers', () => {
    expectProblem(devEnv({ API_PORT: '70000' }), /API_PORT/);
    expectProblem(devEnv({ ACCESS_TOKEN_TTL_SEC: '10' }), /ACCESS_TOKEN_TTL_SEC/);
  });
});
