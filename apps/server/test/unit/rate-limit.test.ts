import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../../src/lib/rate-limit.js';

const WINDOW = 60_000;
const START = 1_770_000_000_000;

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.close();
    vi.useRealTimers();
  });

  it('allows exactly the limit inside one window', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.consume('login:alice', 5, WINDOW), `attempt ${i + 1}`).toEqual({ ok: true });
    }
    expect(limiter.consume('login:alice', 5, WINDOW)).toEqual({ ok: false, retryAfterSec: 60 });
  });

  it('reports a positive retryAfterSec that counts down as the window slides', () => {
    for (let i = 0; i < 3; i++) limiter.consume('k', 3, WINDOW);
    vi.setSystemTime(START + 30_000);
    const blocked = limiter.consume('k', 3, WINDOW);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSec).toBe(30);
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('never reports retryAfterSec below one second', () => {
    limiter.consume('k', 1, WINDOW);
    vi.setSystemTime(START + WINDOW - 1);
    expect(limiter.consume('k', 1, WINDOW)).toEqual({ ok: false, retryAfterSec: 1 });
  });

  it('keeps separate counters per key', () => {
    limiter.consume('a', 1, WINDOW);
    expect(limiter.consume('a', 1, WINDOW).ok).toBe(false);
    expect(limiter.consume('b', 1, WINDOW).ok).toBe(true);
  });

  it('peek does not consume', () => {
    for (let i = 0; i < 10; i++) expect(limiter.peek('k', 2, WINDOW)).toEqual({ ok: true });
    expect(limiter.consume('k', 2, WINDOW).ok).toBe(true);
    expect(limiter.consume('k', 2, WINDOW).ok).toBe(true);
    expect(limiter.peek('k', 2, WINDOW).ok).toBe(false);
    limiter.peek('k', 2, WINDOW);
    vi.setSystemTime(START + WINDOW);
    expect(limiter.peek('k', 2, WINDOW).ok).toBe(true);
  });

  it('reset clears one key and leaves the others alone', () => {
    limiter.consume('a', 1, WINDOW);
    limiter.consume('b', 1, WINDOW);
    limiter.reset('a');
    expect(limiter.consume('a', 1, WINDOW).ok).toBe(true);
    expect(limiter.consume('b', 1, WINDOW).ok).toBe(false);
  });

  it('expires hits once the window has passed', () => {
    for (let i = 0; i < 3; i++) limiter.consume('k', 3, WINDOW);
    expect(limiter.consume('k', 3, WINDOW).ok).toBe(false);
    vi.setSystemTime(START + WINDOW);
    expect(limiter.consume('k', 3, WINDOW).ok).toBe(true);
  });

  it('slides rather than resetting in blocks', () => {
    limiter.consume('k', 2, WINDOW);
    vi.setSystemTime(START + 40_000);
    limiter.consume('k', 2, WINDOW);
    expect(limiter.consume('k', 2, WINDOW).ok).toBe(false);
    vi.setSystemTime(START + WINDOW);
    expect(limiter.consume('k', 2, WINDOW).ok).toBe(true);
    expect(limiter.consume('k', 2, WINDOW).ok).toBe(false);
  });

  it('survives the periodic sweep of idle keys', () => {
    limiter.consume('k', 1, WINDOW);
    vi.advanceTimersByTime(90 * 60 * 1000);
    expect(limiter.consume('k', 1, WINDOW).ok).toBe(true);
    expect(limiter.consume('k', 1, WINDOW).ok).toBe(false);
  });

  it('allows everything when disabled', () => {
    const off = new RateLimiter(true);
    for (let i = 0; i < 10; i++) {
      expect(off.consume('k', 1, WINDOW)).toEqual({ ok: true });
      expect(off.peek('k', 1, WINDOW)).toEqual({ ok: true });
    }
    off.close();
  });
});
