import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LatestWinsThrottle } from '../../src/lib/latest-wins-throttle.js';
import { RateLimiter } from '../../src/lib/rate-limit.js';

describe('LatestWinsThrottle', () => {
  let applied: [string, number][];
  let throttle: LatestWinsThrottle<number>;

  beforeEach(() => {
    vi.useFakeTimers();
    applied = [];
    throttle = new LatestWinsThrottle(new RateLimiter(), 'test', 3, 10_000, (key, value) =>
      applied.push([key, value]),
    );
  });

  afterEach(() => {
    throttle.close();
    vi.useRealTimers();
  });

  test('applies values at once while the budget lasts', () => {
    for (const v of [1, 2, 3]) throttle.push('alice', v);
    expect(applied).toEqual([
      ['alice', 1],
      ['alice', 2],
      ['alice', 3],
    ]);
  });

  test('past the budget it applies nothing more until the window reopens, then only the latest', () => {
    for (let v = 1; v <= 60; v++) throttle.push('alice', v);
    expect(applied).toHaveLength(3);

    vi.advanceTimersByTime(10_000);
    expect(applied).toEqual([
      ['alice', 1],
      ['alice', 2],
      ['alice', 3],
      ['alice', 60],
    ]);
  });

  test('one member spending their budget does not delay another', () => {
    for (let v = 1; v <= 5; v++) throttle.push('alice', v);
    throttle.push('bob', 7);
    expect(applied.at(-1)).toEqual(['bob', 7]);
  });

  test('a cancelled key applies nothing later', () => {
    for (let v = 1; v <= 5; v++) throttle.push('alice', v);
    throttle.cancel('alice');
    vi.advanceTimersByTime(60_000);
    expect(applied).toHaveLength(3);
  });
});
