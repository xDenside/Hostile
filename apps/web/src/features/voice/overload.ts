export const OVERLOAD_GIVE_UP_AFTER_MS = 5000;
export const OVERLOAD_REPEAT_LIMIT = 3;
export const OVERLOAD_REPEAT_WINDOW_MS = 60_000;

export class OverloadWatch {
  private engagedAt: number | null = null;
  private engagements: number[] = [];

  change(engaged: boolean, now: number): boolean {
    if (!engaged) {
      this.engagedAt = null;
      return false;
    }
    this.engagedAt ??= now;
    this.engagements = [
      ...this.engagements.filter((at) => now - at < OVERLOAD_REPEAT_WINDOW_MS),
      now,
    ];
    return this.engagements.length >= OVERLOAD_REPEAT_LIMIT;
  }

  forgive(now: number): void {
    if (this.engagedAt !== null) this.engagedAt = now;
    this.engagements = [];
  }

  stuck(now: number): boolean {
    return this.engagedAt !== null && now - this.engagedAt >= OVERLOAD_GIVE_UP_AFTER_MS;
  }
}
