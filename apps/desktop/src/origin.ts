export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'null') return parsed.origin;
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : null;
  } catch {
    return null;
  }
}

const SAFE_HOST = /^[A-Za-z0-9._:[\]-]+$/;

export function isSafeOriginHost(host: string): boolean {
  return SAFE_HOST.test(host);
}

export function safeOriginOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isSafeOriginHost(parsed.host)) return null;
  return `${parsed.protocol}//${parsed.host}`;
}

export function isSameOrigin(url: string | null | undefined, origin: string): boolean {
  if (!url) return false;
  if (url === origin) return true;
  return originOf(url) === origin;
}
