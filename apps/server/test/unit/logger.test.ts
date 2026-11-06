import { describe, expect, it } from 'vitest';
import { loggableUrl } from '../../src/lib/logger.js';

describe('a request line', () => {
  it('shows no query string', () => {
    expect(loggableUrl('/api/channels?secret=1')).toBe('/api/channels');
  });

  it('shows no join ticket or picture key, which are secrets that sit in the path', () => {
    expect(loggableUrl('/api/join/abc123')).toBe('/api/join/[redacted]');
    expect(loggableUrl('/api/join/abc123/picture')).toBe('/api/join/[redacted]/picture');
    expect(loggableUrl('/api/join-pictures/abc123?x=1')).toBe('/api/join-pictures/[redacted]');
  });

  it('leaves other paths readable', () => {
    expect(loggableUrl('/api/join')).toBe('/api/join');
    expect(loggableUrl('/api/admin/join-requests')).toBe('/api/admin/join-requests');
  });
});
