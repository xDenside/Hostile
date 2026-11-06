import { describe, expect, it } from 'vitest';
import { isLoopbackHost, safeExternalUrl } from '../src/url.js';

describe('safeExternalUrl', () => {
  it('accepts http and https links', () => {
    expect(safeExternalUrl('https://example.com/x?y=1#z')).toBe('https://example.com/x?y=1#z');
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com/');
  });

  it('rejects every other scheme', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'hostile://hostile/x',
      'mailto:someone@example.com',
    ]) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
  });

  it('rejects credentials embedded in the URL', () => {
    expect(safeExternalUrl('https://user:pass@example.com/')).toBeNull();
    expect(safeExternalUrl('https://user@example.com/')).toBeNull();
  });

  it('rejects unparseable and oversized input', () => {
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl('')).toBeNull();
    expect(safeExternalUrl(`https://example.com/${'x'.repeat(2048)}`)).toBeNull();
  });
});

describe('isLoopbackHost', () => {
  it('recognizes loopback names and addresses', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'app.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('does not treat routable or wildcard addresses as loopback', () => {
    for (const host of [
      'example.com',
      'localhost.example.com',
      '192.168.1.5',
      '10.0.0.1',
      '0.0.0.0',
      '::',
      '128.0.0.1',
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
