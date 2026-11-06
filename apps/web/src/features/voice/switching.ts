export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private latest = 0;
  private pending = 0;

  constructor(private readonly onBusyChange: (busy: boolean) => void = () => undefined) {}

  get busy(): boolean {
    return this.pending > 0;
  }

  get newestToken(): number {
    return this.latest;
  }

  isNewest(token: number): boolean {
    return token === this.latest;
  }

  run<T>(task: (token: number) => Promise<T>): Promise<T> {
    const token = ++this.latest;
    this.pending++;
    if (this.pending === 1) this.onBusyChange(true);
    const result = this.tail.then(() => task(token));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending--;
      if (this.pending === 0) this.onBusyChange(false);
    });
  }
}

export function suppressorStillWanted(attempt: {
  token: number;
  newestToken: number;
  room: object | null;
  roomNow: object | null;
  track: object | null;
  trackNow: object | null;
  suppressor: string;
  suppressorNow: string | null;
}): boolean {
  return (
    attempt.token === attempt.newestToken &&
    attempt.room !== null &&
    attempt.room === attempt.roomNow &&
    attempt.track !== null &&
    attempt.track === attempt.trackNow &&
    attempt.suppressor === attempt.suppressorNow
  );
}
