import { describe, expect, it } from 'vitest';
import { formatMessageTimestamp, formatTime } from '../src/lib/time';

const twelveHour = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;

describe('message times', () => {
  const now = new Date(2026, 10, 12, 20, 0, 0);
  const morning = new Date(2026, 10, 12, 6, 41, 0).toISOString();

  it.runIf(twelveHour)('a header drops the leading zero of the hour', () => {
    expect(formatMessageTimestamp(morning, now)).toBe('Today at 6:41 AM');
  });

  it.runIf(twelveHour)('the time in the gutter keeps two digits, so every row is as wide', () => {
    expect(formatTime(morning)).toBe('06:41 AM');
  });

  it('says Yesterday for the day before, and a date before that', () => {
    const yesterday = new Date(2026, 10, 11, 23, 59, 0).toISOString();
    const older = new Date(2026, 10, 10, 12, 0, 0).toISOString();
    expect(formatMessageTimestamp(yesterday, now)).toMatch(/^Yesterday at /);
    expect(formatMessageTimestamp(older, now)).not.toMatch(/^(Today|Yesterday)/);
  });
});
