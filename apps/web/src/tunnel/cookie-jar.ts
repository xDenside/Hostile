interface Stored {
  value: string;
  expiresAt: number | null;
}

export class CookieJar {
  constructor(private readonly key: string) {}

  private get cookies(): Record<string, Stored> {
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? '{}') as Record<string, Stored>;
    } catch {
      return {};
    }
  }

  header(): string {
    const now = Date.now();
    return Object.entries(this.cookies)
      .filter(([, c]) => c.expiresAt === null || c.expiresAt > now)
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ');
  }

  absorb(setCookies: string[]) {
    const now = Date.now();
    const cookies = this.cookies;
    for (const line of setCookies) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair!.indexOf('=');
      if (eq <= 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      let expiresAt: number | null = null;
      for (const attribute of attributes) {
        const [k, v] = attribute.split('=');
        const key = k!.trim().toLowerCase();
        if (key === 'max-age' && v) expiresAt = now + Number(v) * 1000;
        else if (key === 'expires' && v && expiresAt === null) expiresAt = Date.parse(v);
      }
      if (value === '' || (expiresAt !== null && expiresAt <= now)) delete cookies[name];
      else cookies[name] = { value, expiresAt };
    }
    this.save(cookies);
  }

  clear() {
    this.save({});
  }

  private save(cookies: Record<string, Stored>) {
    try {
      localStorage.setItem(this.key, JSON.stringify(cookies));
    } catch {}
  }
}
