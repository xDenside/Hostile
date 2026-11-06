const PREFIX = '[desktop]';

export const log = {
  info: (message: string, ...rest: unknown[]) => console.log(`${PREFIX} ${message}`, ...rest),
  warn: (message: string, ...rest: unknown[]) => console.warn(`${PREFIX} ${message}`, ...rest),
  error: (message: string, ...rest: unknown[]) => console.error(`${PREFIX} ${message}`, ...rest),
};

export function loadFailure(code: number, description: string, url: string): string {
  let where = 'a page with no address';
  try {
    const parsed = new URL(url);
    where = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {}
  return `the window could not load ${where}: ${description} (${code})`;
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Unknown error.';
}
