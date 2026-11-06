export class SharedReads {
  private readonly held = new Map<string, Buffer>();
  private heldBytes = 0;
  private readonly reading = new Map<string, Promise<Buffer | null>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly read: (key: string) => Promise<Buffer | null>,
    private readonly maxHeldBytes: number,
    private readonly maxReads: number,
  ) {}

  get(key: string): Promise<Buffer | null> {
    const value = this.held.get(key);
    if (value) {
      this.held.delete(key);
      this.held.set(key, value);
      return Promise.resolve(value);
    }
    let pending = this.reading.get(key);
    if (!pending) {
      pending = this.readAndHold(key).finally(() => this.reading.delete(key));
      this.reading.set(key, pending);
    }
    return pending;
  }

  private async readAndHold(key: string): Promise<Buffer | null> {
    await this.takeTurn();
    try {
      const value = await this.read(key);
      if (value) this.hold(key, value);
      return value;
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async takeTurn(): Promise<void> {
    if (this.running >= this.maxReads) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
  }

  private hold(key: string, value: Buffer): void {
    if (value.length > this.maxHeldBytes) return;
    this.held.set(key, value);
    this.heldBytes += value.length;
    for (const [oldest, bytes] of this.held) {
      if (this.heldBytes <= this.maxHeldBytes) break;
      this.held.delete(oldest);
      this.heldBytes -= bytes.length;
    }
  }
}
