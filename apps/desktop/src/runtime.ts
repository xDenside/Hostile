import { join } from 'node:path';
import { app } from 'electron';
import { DESKTOP_ORIGIN } from '@hostile/shared';
import type { CspInputs } from './csp.js';
import { createCredentialStore, type CredentialStore } from './credentials.js';
import { log } from './log.js';
import { safeOriginOf } from './origin.js';
import { isProofBuild, PROOF_RELAYS } from './proof.js';
import {
  createSettingsStore,
  createWindowStateStore,
  type SettingsStore,
  type WindowStateStore,
} from './store.js';

export interface RendererTarget {
  origin: string;
  url: string;
  devOrigin: string | null;
}

export interface Runtime {
  readonly profile: string;
  readonly userDataDir: string;
  readonly rendererDir: string;
  readonly target: RendererTarget;
  readonly settings: SettingsStore;
  readonly windowState: WindowStateStore;
  readonly credentials: CredentialStore;
  credentialScope(): string | null;
  livekitUrl: string | null;
  cspInputs(): CspInputs;
}

export function resolveRendererTarget(): RendererTarget {
  const bundled: RendererTarget = {
    origin: DESKTOP_ORIGIN,
    url: `${DESKTOP_ORIGIN}/index.html`,
    devOrigin: null,
  };
  const requested = process.env.HOSTILE_DESKTOP_RENDERER_URL?.trim();
  if (!requested) return bundled;
  if (app.isPackaged) {
    log.warn('HOSTILE_DESKTOP_RENDERER_URL is ignored in a packaged build');
    return bundled;
  }
  let parsed: URL;
  try {
    parsed = new URL(requested);
  } catch {
    log.warn(`HOSTILE_DESKTOP_RENDERER_URL is not a URL: ${requested}`);
    return bundled;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    log.warn(`HOSTILE_DESKTOP_RENDERER_URL must be http(s): ${requested}`);
    return bundled;
  }
  if (!safeOriginOf(requested)) {
    log.warn(`HOSTILE_DESKTOP_RENDERER_URL has an unusable host: ${requested}`);
    return bundled;
  }
  log.info(`development renderer: ${parsed.origin}`);
  return { origin: parsed.origin, url: parsed.toString(), devOrigin: parsed.origin };
}

function rendererDirectory(): string {
  const requested = app.isPackaged ? '' : process.env.HOSTILE_DESKTOP_RENDERER_DIR?.trim();
  return requested || join(__dirname, 'renderer');
}

export function testRelays(): string[] {
  if (app.isPackaged) return isProofBuild() ? PROOF_RELAYS : [];
  return (process.env.HOSTILE_TEST_RELAYS ?? '').split(',').filter(Boolean);
}

export function createRuntime(
  profile: string,
  userDataDir: string,
  target: RendererTarget,
): Runtime {
  const settings = createSettingsStore(userDataDir);
  const runtime: Runtime = {
    profile,
    userDataDir,
    rendererDir: rendererDirectory(),
    target,
    settings,
    windowState: createWindowStateStore(userDataDir),
    credentials: createCredentialStore(userDataDir),
    livekitUrl: null,
    credentialScope: () => (settings.get().room === 'host' ? 'hosted-room' : null),
    cspInputs: () => {
      const { room, serverUrl } = settings.get();
      if (room === 'guest') {
        return { serverOrigin: null, livekitUrl: null, guest: true, testRelays: testRelays() };
      }
      return { serverOrigin: serverUrl, livekitUrl: runtime.livekitUrl };
    },
  };
  return runtime;
}
