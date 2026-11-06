const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:']);

export function safeExternalUrl(raw: string): string | null {
  if (raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!SAFE_LINK_PROTOCOLS.has(url.protocol)) return null;
  if (url.username || url.password) return null;
  return url.toString();
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}
