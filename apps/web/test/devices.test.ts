import { describe, expect, it } from 'vitest';
import { describeDevice } from '../src/features/settings/devices';
import { formatAgo } from '../src/lib/time';

const web = (userAgent: string | null) => ({ client: 'web' as const, userAgent });

describe('describeDevice', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome on macOS',
      false,
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Edge on Windows',
      false,
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      'Firefox on Linux',
      false,
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iPhone',
      true,
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
      true,
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
      'Chrome on iPhone',
      true,
    ],
  ])('%s', (agent, name, phone) => {
    expect(describeDevice(web(agent))).toEqual({ name, phone });
  });

  it('calls the desktop app that, whatever engine it runs on', () => {
    const agent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
    expect(describeDevice({ client: 'desktop', userAgent: agent }).name).toBe(
      'Desktop app on macOS',
    );
  });

  it('does not invent anything from an agent it cannot read', () => {
    expect(describeDevice(web(null)).name).toBe('Unknown browser');
    expect(describeDevice(web('curl/8.0')).name).toBe('Unknown browser');
    expect(describeDevice(web('Mozilla/5.0 (Windows NT 10.0)')).name).toBe('Windows');
  });
});

describe('formatAgo', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it('rounds down, and gives way to the date after a month', () => {
    expect(formatAgo(ago(30), now)).toBe('just now');
    expect(formatAgo(ago(119), now)).toMatch(/1 minute ago/);
    expect(formatAgo(ago(3599), now)).toMatch(/59 minutes ago/);
    expect(formatAgo(ago(2 * 3600), now)).toMatch(/2 hours ago/);
    expect(formatAgo(ago(3 * 86_400), now)).toMatch(/3 days ago/);
    expect(formatAgo(ago(40 * 86_400), now)).toMatch(/^on /);
  });

  it('a clock slightly ahead of this one is still "just now"', () => {
    expect(formatAgo(ago(-20), now)).toBe('just now');
  });
});
