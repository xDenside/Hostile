export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly disabled = false) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): { ok: true } | { ok: false; retryAfterSec: number } {
    if (this.disabled) return { ok: true };
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((list[0]! + windowMs - now) / 1000)),
      };
    }
    list.push(now);
    this.hits.set(key, list);
    return { ok: true };
  }

  peek(
    key: string,
    limit: number,
    windowMs: number,
  ): { ok: true } | { ok: false; retryAfterSec: number } {
    if (this.disabled) return { ok: true };
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit)
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((list[0]! + windowMs - now) / 1000)),
      };
    return { ok: true };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, list] of this.hits) {
      if (!list.length || now - list[list.length - 1]! > 60 * 60 * 1000) this.hits.delete(key);
    }
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
