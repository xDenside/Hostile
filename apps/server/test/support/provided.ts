import { inject } from 'vitest';

export interface IntegrationLivekit {
  apiKey: string;
  apiSecret: string;
  internalUrl: string;
  publicUrl: string;
  running: boolean;
  reason: string | null;
}

export interface IntegrationConfig {
  dataDir: string;
  livekit: IntegrationLivekit;
}

declare module 'vitest' {
  interface ProvidedContext {
    integration: IntegrationConfig;
  }
}

export const integrationConfig = (): IntegrationConfig => inject('integration');
