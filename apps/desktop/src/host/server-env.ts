export interface HostPorts {
  api: number;
  livekit: number;
  gateway: number;
}

export const HOST_TRUST_PROXY = 'loopback';

export function hostServerEnv(dataDir: string, ports: HostPorts): Record<string, string> {
  return {
    HOSTILE_ENV: 'production',
    API_HOST: '127.0.0.1',
    API_PORT: String(ports.api),
    PUBLIC_APP_URL: `http://127.0.0.1:${ports.api}`,
    ALLOW_DESKTOP_ORIGIN: 'true',
    DATA_DIR: dataDir,
    LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${ports.livekit}`,
    LIVEKIT_PUBLIC_URL: `ws://127.0.0.1:${ports.livekit}`,
    TRUST_PROXY: HOST_TRUST_PROXY,
    LOG_LEVEL: 'warn',
  };
}
