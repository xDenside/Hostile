import type { RateLimiter } from './rate-limit.js';

export class LatestWinsThrottle<T> {
  private readonly held = new Map<string, { value: T; timer: NodeJS.Timeout }>();

  constructor(
    private readonly limiter: RateLimiter,
    private readonly scope: string,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly apply: (key: string, value: T) => void,
  ) {}

  push(key: string, value: T): void {
    const waiting = this.held.get(key);
    if (waiting) {
      waiting.value = value;
      return;
    }
    const budget = this.limiter.consume(`${this.scope}:${key}`, this.limit, this.windowMs);
    if (budget.ok) {
      this.apply(key, value);
      return;
    }
    const timer = setTimeout(() => {
      const latest = this.held.get(key);
      this.held.delete(key);
      if (latest) this.apply(key, latest.value);
    }, budget.retryAfterSec * 1000);
    timer.unref();
    this.held.set(key, { value, timer });
  }

  cancel(key: string): void {
    const waiting = this.held.get(key);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.held.delete(key);
  }

  close(): void {
    for (const { timer } of this.held.values()) clearTimeout(timer);
    this.held.clear();
  }
}
