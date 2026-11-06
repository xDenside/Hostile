import { isSafeOriginHost } from './origin.js';

export interface CspInputs {
  serverOrigin: string | null;
  livekitUrl: string | null;
  guest?: boolean;
  testRelays?: string[];
}

function webSocketSources(url: string | null): string[] {
  if (!url) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (!isSafeOriginHost(parsed.host)) return [];
  const twin: Record<string, string> = {
    'ws:': 'http:',
    'wss:': 'https:',
    'http:': 'ws:',
    'https:': 'wss:',
  };
  const other = twin[parsed.protocol];
  const sources = [`${parsed.protocol}//${parsed.host}`];
  if (other) sources.push(`${other}//${parsed.host}`);
  return sources;
}

function connectSources(inputs: CspInputs, extra: string[]): string[] {
  const sources = new Set<string>(["'self'", ...extra]);
  for (const source of webSocketSources(inputs.serverOrigin)) sources.add(source);
  for (const source of webSocketSources(inputs.livekitUrl)) sources.add(source);
  if (inputs.guest) sources.add('wss:');
  for (const relay of inputs.testRelays ?? []) {
    for (const source of webSocketSources(relay)) sources.add(source);
  }
  return [...sources];
}

function fileSources(inputs: CspInputs): string[] {
  const origin = webSocketSources(inputs.serverOrigin)[0];
  return origin && /^https?:/.test(origin) ? [origin] : [];
}

export function contentSecurityPolicy(inputs: CspInputs): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data: blob:", ...fileSources(inputs)].join(' '),
    ["media-src 'self' blob:", ...fileSources(inputs)].join(' '),
    "font-src 'self'",
    `connect-src ${connectSources(inputs, []).join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function bridgeContentSecurityPolicy(
  gatewayPort: number,
  testRelays: string[] = [],
): string {
  const relays = testRelays.flatMap((relay) => webSocketSources(relay));
  return [
    "default-src 'none'",
    "script-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${gatewayPort} wss: ${relays.join(' ')}`.trim(),
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function developmentContentSecurityPolicy(inputs: CspInputs, devOrigin: string): string {
  const dev = webSocketSources(devOrigin);
  return [
    `default-src 'self' ${devOrigin}`,
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${devOrigin}`,
    `style-src 'self' 'unsafe-inline' ${devOrigin}`,
    ["img-src 'self' data: blob:", ...fileSources(inputs)].join(' '),
    ["media-src 'self' blob:", ...fileSources(inputs)].join(' '),
    `font-src 'self' ${devOrigin} data:`,
    `connect-src ${connectSources(inputs, dev).join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
